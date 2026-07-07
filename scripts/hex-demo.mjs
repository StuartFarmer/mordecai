#!/usr/bin/env node
/**
 * Hex demo — winner-takes-all Hex with strangers: ONE person runs this
 * script (L1 devnet, a host-run app chain, anchor daemon, faucet, and the
 * web gateways); everyone else just visits the site, gets a wallet
 * generated in the page, and creates or joins games by code.
 *
 *   pnpm build && pnpm --filter @hssn/example-hex-web build
 *   node scripts/hex-demo.mjs
 *
 * Starts: 3-validator L1 devnet · hex_escrow on L1 · a 2-validator app
 * chain running the hex contract (3-minute forfeit clock) · an anchor
 * daemon that settles finished games every epoch · a faucet that funds
 * visiting wallets on both chains · two gateways:
 *   http://<host>:8787  L1 + the web UI
 *   http://<host>:8788  the app chain (board reads, moves)
 *   http://<host>:8789  the faucet
 * Ctrl-C to stop.
 */
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import createTestnet from '../packages/networking/node_modules/hyperdht/testnet.js';
import {
  decodeAddress,
  encodeAddress,
  generateSeed,
  keyPairFromSeed,
  sign,
} from '../packages/crypto/dist/index.js';
import { encodeTransaction, transactionSigningBytes } from '../packages/protocol/dist/index.js';
import { appAddress, contractIdFor } from '../packages/chain/dist/index.js';
import { NodeRpcClient } from '../packages/rpc/dist/index.js';
import { Node } from '../packages/node/dist/index.js';
import { Gateway } from '../packages/gateway/dist/index.js';
import { AnchorDaemon, AppChain } from '../packages/appchain/dist/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const l1ChainId = 'hssn-hex-devnet';
const APP = 'com.example.hex';
const TIMEOUT_MS = BigInt(process.env.HEX_TIMEOUT_MS ?? 180_000); // 3-minute inactivity forfeit
const L1_PORT = Number(process.env.PORT ?? 8787);
const APP_PORT = L1_PORT + 1;
const FAUCET_PORT = L1_PORT + 2;
const L1_GRANT = 10_000_000n; // per faucet request, covers stakes + fees
const APP_GRANT = 1_000_000_000n; // app-chain fee float (valueless by design)

const hosts = {
  'host-a': keyPairFromSeed(generateSeed()),
  'host-b': keyPairFromSeed(generateSeed()),
};
const relayer = keyPairFromSeed(generateSeed());
const faucet = keyPairFromSeed(generateSeed());

const utf8 = (s) => new TextEncoder().encode(s);
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return new Uint8Array(b);
};
const addr = (key) => {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(32);
  return new Uint8Array(Buffer.concat([len, Buffer.from(key)]));
};
const hexToBytes = (h) => new Uint8Array(Buffer.from(h, 'hex'));

// ---------------------------------------------------------------- L1 devnet

const testnet = await createTestnet(3);
const validators = Array.from({ length: 3 }, () => keyPairFromSeed(generateSeed()));
const genesis = {
  chainId: l1ChainId,
  validators: validators.map((v) => encodeAddress(v.publicKey)),
  allocations: [
    { address: encodeAddress(relayer.publicKey), balance: 100_000_000n },
    { address: encodeAddress(faucet.publicKey), balance: 100_000_000_000n },
  ],
};
const base = mkdtempSync(join(tmpdir(), 'hssn-hex-demo-'));
const nodes = [];
for (const [i, keyPair] of validators.entries()) {
  nodes.push(
    await Node.start({
      dir: join(base, `l1-${i}`),
      genesis,
      keyPair,
      blockIntervalMs: 400,
      bootstrap: testnet.bootstrap,
    }),
  );
}
console.log('L1 devnet up: 3 validators');

const rpc = NodeRpcClient.connect(nodes[0].rpcPublicKey, { bootstrap: testnet.bootstrap });
const nonces = new Map();

async function submit(client, chainId, who, payload) {
  const key = `${chainId}:${encodeAddress(who.publicKey)}`;
  const nonce = nonces.get(key) ?? 0n;
  nonces.set(key, nonce + 1n);
  const u = { chainId, nonce, sender: who.publicKey, maxFee: 500_000n, payload };
  const tx = { ...u, signature: sign(transactionSigningBytes(u), who.secretKey) };
  const info = await client.waitForTx(await client.submitTx(encodeTransaction(tx)), {
    timeoutMs: 30_000,
  });
  if (!info.success) throw new Error(`${payload.kind} failed: ${info.error}`);
  return info;
}
const l1Submit = (who, payload) => submit(rpc, l1ChainId, who, payload);

// hex escrow on L1, its settle gated to the app's derived address
const escrowWasm = new Uint8Array(readFileSync(join(repoRoot, 'contracts/dist/hex_escrow.wasm')));
await l1Submit(relayer, { kind: 'deploy_contract', code: escrowWasm });
const escrow = contractIdFor(relayer.publicKey, 0n, escrowWasm);
await l1Submit(relayer, {
  kind: 'execute_contract',
  contract: escrow,
  value: 0n,
  action: 'init',
  args: addr(appAddress(APP)),
});
console.log(`hex escrow on L1: ${Buffer.from(escrow).toString('hex')}`);

// register the app: the two host-run keys are its chain validators
await l1Submit(relayer, {
  kind: 'register_app',
  appId: APP,
  pearKey: new Uint8Array(32).fill(1),
  version: '1.0.0',
  contractAddress: new Uint8Array(32),
  metadataHash: new Uint8Array(32).fill(2),
  chainValidators: Object.values(hosts).map((k) => k.publicKey),
});

// ---------------------------------------------------------------- app chain

const [chainA, chainB] = await Promise.all(
  Object.entries(hosts).map(([name, keyPair]) =>
    AppChain.join(rpc, APP, {
      dir: join(base, `app-${name}`),
      keyPair,
      bootstrap: testnet.bootstrap,
      blockIntervalMs: 300,
    }),
  ),
);
await Promise.all([chainA.waitForPeers(1), chainB.waitForPeers(1)]);
console.log(`app chain up: ${chainA.genesis.chainId} (validators: host-a, host-b)`);

const appRpc = NodeRpcClient.connect(chainA.rpcPublicKey, { bootstrap: testnet.bootstrap });
const appSubmit = (who, payload) => submit(appRpc, chainA.genesis.chainId, who, payload);

const hexWasm = new Uint8Array(readFileSync(join(repoRoot, 'contracts/dist/hex.wasm')));
await appSubmit(hosts['host-a'], { kind: 'deploy_contract', code: hexWasm });
const hex = contractIdFor(hosts['host-a'].publicKey, 0n, hexWasm);
await appSubmit(hosts['host-a'], {
  kind: 'execute_contract',
  contract: hex,
  value: 0n,
  action: 'init',
  args: u64(TIMEOUT_MS),
});
console.log(`hex game on app chain: ${Buffer.from(hex).toString('hex')}`);

// -------------------------------------------------- anchor daemon (settler)

/**
 * Find the lowest finished-but-unsettled game and settle its pot as the
 * app. Game value layout: creator(32) opponent(32) winner(32) phase(8)…;
 * Pot value layout: creator(32) opponent(32) stake(8) phase(8).
 */
async function outcome(chain) {
  const games = await chain.getContractState(hex, utf8('s:Game:'));
  if (games.length === 0) return null;
  const pots = await rpc.getContractState(escrow, utf8('s:Pot:'));
  const potPhase = new Map(
    pots.map(({ key, value }) => {
      const id = Buffer.from(hexToBytes(key).subarray('s:Pot:'.length)).readBigUInt64LE();
      return [id, Buffer.from(hexToBytes(value)).readBigUInt64LE(72)];
    }),
  );
  for (const [key, value] of games) {
    const id = Buffer.from(key.subarray('s:Game:'.length)).readBigUInt64LE();
    const phase = Buffer.from(value).readBigUInt64LE(96);
    if (phase !== 2n || potPhase.get(id) !== 1n) continue;
    const winner = value.subarray(64, 96);
    console.log(`settling game ${id} → winner ${encodeAddress(winner).slice(0, 12)}…`);
    return {
      contract: escrow,
      action: 'settle',
      args: new Uint8Array(Buffer.concat([Buffer.from(u64(id)), Buffer.from(addr(winner))])),
    };
  }
  return null;
}

const daemon = new AnchorDaemon({
  chain: chainA.chain,
  appId: APP,
  validators: Object.values(hosts).map((k) => k.publicKey),
  keyPair: hosts['host-a'],
  l1: { chainId: l1ChainId, nodeKey: nodes[0].rpcPublicKey, bootstrap: testnet.bootstrap },
  relayer,
  outcome,
  epochIntervalMs: 5_000,
  log: (m) => console.log(`[anchor] ${m}`),
});

// -------------------------------------------------------------- the faucet

// Funds a visiting wallet on BOTH chains: L1 currency for stakes + fees,
// app-chain float for fees (valueless by design). Grants are serialized
// so concurrent visitors don't race the faucet nonces.
let faucetQueue = Promise.resolve();

const faucetServer = createServer((req, res) => {
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }
  if (req.method !== 'POST' || req.url !== '/faucet') {
    res.writeHead(404, { 'content-type': 'application/json', ...cors });
    return res.end(JSON.stringify({ error: 'POST /faucet {"address": "<z32>"}' }));
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    faucetQueue = faucetQueue.then(async () => {
      try {
        const { address } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const to = decodeAddress(address);
        await l1Submit(faucet, { kind: 'transfer', to, amount: L1_GRANT });
        await appSubmit(hosts['host-a'], { kind: 'transfer', to, amount: APP_GRANT });
        console.log(`[faucet] funded ${address.slice(0, 12)}…`);
        res.writeHead(200, { 'content-type': 'application/json', ...cors });
        res.end(JSON.stringify({ ok: true, l1: String(L1_GRANT), app: String(APP_GRANT) }));
      } catch (err) {
        res.writeHead(400, { 'content-type': 'application/json', ...cors });
        res.end(JSON.stringify({ error: String(err?.message ?? err) }));
      }
    });
  });
});
await new Promise((resolve) => faucetServer.listen(FAUCET_PORT, resolve));

// ------------------------------------------------------------------ gateways

const appGateway = await Gateway.start({
  nodeKey: chainA.rpcPublicKey,
  bootstrap: testnet.bootstrap,
  port: APP_PORT,
});
const gateway = await Gateway.start({
  nodeKey: nodes[0].rpcPublicKey,
  bootstrap: testnet.bootstrap,
  port: L1_PORT,
  staticDir: join(repoRoot, 'apps/hex-web/dist'),
  config: {
    chainId: l1ChainId,
    appChainId: chainA.genesis.chainId,
    appId: APP,
    escrow: Buffer.from(escrow).toString('hex'),
    hex: Buffer.from(hex).toString('hex'),
    // Ports, not URLs: the page targets the host it was loaded from, so
    // players on other machines reach this box automatically.
    appApiPort: appGateway.port,
    faucetPort: FAUCET_PORT,
  },
});

console.log(`\n⬡ hex is live: http://127.0.0.1:${gateway.port}`);
console.log(`   app-chain gateway: http://127.0.0.1:${appGateway.port}`);
console.log(`   faucet:            http://127.0.0.1:${FAUCET_PORT}`);
console.log('\nplay: open the site on two machines (or two browsers), agree on a game');
console.log('code, create on one and join on the other — 1,000,000 🪙 each, winner takes all.');
console.log('Ctrl-C to stop.');

process.on('SIGINT', async () => {
  console.log('\nshutting down…');
  await daemon.close().catch(() => {});
  await new Promise((resolve) => faucetServer.close(resolve));
  await gateway.close().catch(() => {});
  await appGateway.close().catch(() => {});
  await appRpc.close().catch(() => {});
  await rpc.close().catch(() => {});
  await chainA.stop().catch(() => {});
  await chainB.stop().catch(() => {});
  for (const node of nodes) await node.stop().catch(() => {});
  await testnet.destroy();
  process.exit(0);
});
await new Promise(() => {});
