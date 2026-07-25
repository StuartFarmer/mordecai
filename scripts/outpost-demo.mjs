#!/usr/bin/env node
/**
 * Outpost demo — the MMORTS vertical: game on a player-run app chain,
 * goods market on L1, one wallet identity across both, settlement via
 * anchored outcome calls (app-chains spec).
 *
 *   pnpm build && pnpm --filter @mordecai/example-outpost-web build
 *   node scripts/outpost-demo.mjs
 *
 * Starts: 3-validator L1 devnet · goods_market on L1 · a 2-validator app
 * chain (alice + bob) running the outpost game · an anchor daemon that
 * settles delivered orders every epoch · two gateways:
 *   http://127.0.0.1:8787  L1 + the web UI
 *   http://127.0.0.1:8788  the app chain (game reads/moves)
 * Ctrl-C to stop.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import createTestnet from '../packages/networking/node_modules/hyperdht/testnet.js';
import {
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
const l1ChainId = 'mordecai-outpost-devnet';
const APP = 'com.example.outpost';
const L1_PORT = Number(process.env.PORT ?? 8787);
const APP_PORT = L1_PORT + 1;

const seeds = { alice: generateSeed(), bob: generateSeed() };
const keys = Object.fromEntries(
  Object.entries(seeds).map(([name, seed]) => [name, keyPairFromSeed(seed)]),
);
const relayer = keyPairFromSeed(generateSeed());

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

// ---------------------------------------------------------------- L1 devnet

const testnet = await createTestnet(3);
const validators = Array.from({ length: 3 }, () => keyPairFromSeed(generateSeed()));
const genesis = {
  chainId: l1ChainId,
  validators: validators.map((v) => encodeAddress(v.publicKey)),
  allocations: [
    ...Object.values(keys).map((k) => ({
      address: encodeAddress(k.publicKey),
      balance: 100_000_000n,
    })),
    { address: encodeAddress(relayer.publicKey), balance: 100_000_000n },
  ],
};
const base = mkdtempSync(join(tmpdir(), 'mordecai-outpost-demo-'));
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

async function l1Submit(who, payload) {
  const nonce = nonces.get(who) ?? 0n;
  nonces.set(who, nonce + 1n);
  const u = { chainId: l1ChainId, nonce, sender: who.publicKey, maxFee: 500_000n, payload };
  const tx = { ...u, signature: sign(transactionSigningBytes(u), who.secretKey) };
  const info = await rpc.waitForTx(await rpc.submitTx(encodeTransaction(tx)), {
    timeoutMs: 30_000,
  });
  if (!info.success) throw new Error(`${payload.kind} failed: ${info.error}`);
  return info;
}

// goods market on L1, gated to the app's derived address
const marketWasm = new Uint8Array(readFileSync(join(repoRoot, 'contracts/dist/goods_market.wasm')));
await l1Submit(relayer, { kind: 'deploy_contract', code: marketWasm });
const market = contractIdFor(relayer.publicKey, 0n, marketWasm);
await l1Submit(relayer, {
  kind: 'execute_contract',
  contract: market,
  value: 0n,
  action: 'init',
  args: addr(appAddress(APP)),
});
console.log(`goods market on L1: ${Buffer.from(market).toString('hex')}`);

// register the app: alice + bob are its chain validators
await l1Submit(relayer, {
  kind: 'register_app',
  appId: APP,
  pearKey: new Uint8Array(32).fill(1),
  version: '1.0.0',
  contractAddress: new Uint8Array(32),
  metadataHash: new Uint8Array(32).fill(2),
  chainValidators: [keys.alice.publicKey, keys.bob.publicKey],
});

// ---------------------------------------------------------------- app chain

const [chainA, chainB] = await Promise.all(
  Object.entries(keys).map(([name, keyPair]) =>
    AppChain.join(rpc, APP, {
      dir: join(base, `app-${name}`),
      keyPair,
      bootstrap: testnet.bootstrap,
      blockIntervalMs: 300,
    }),
  ),
);
await Promise.all([chainA.waitForPeers(1), chainB.waitForPeers(1)]);
console.log(`app chain up: ${chainA.genesis.chainId} (validators: alice, bob)`);

const appRpc = NodeRpcClient.connect(chainA.rpcPublicKey, { bootstrap: testnet.bootstrap });
const gameWasm = new Uint8Array(readFileSync(join(repoRoot, 'contracts/dist/outpost.wasm')));
{
  const deploy = {
    chainId: chainA.genesis.chainId,
    nonce: 0n,
    sender: keys.alice.publicKey,
    maxFee: 500_000n,
    payload: { kind: 'deploy_contract', code: gameWasm },
  };
  const tx = { ...deploy, signature: sign(transactionSigningBytes(deploy), keys.alice.secretKey) };
  await appRpc.waitForTx(await appRpc.submitTx(encodeTransaction(tx)), { timeoutMs: 30_000 });
  const init = {
    chainId: chainA.genesis.chainId,
    nonce: 1n,
    sender: keys.alice.publicKey,
    maxFee: 500_000n,
    payload: {
      kind: 'execute_contract',
      contract: contractIdFor(keys.alice.publicKey, 0n, gameWasm),
      value: 0n,
      action: 'init',
      args: u64(144),
    },
  };
  const itx = { ...init, signature: sign(transactionSigningBytes(init), keys.alice.secretKey) };
  await appRpc.waitForTx(await appRpc.submitTx(encodeTransaction(itx)), { timeoutMs: 30_000 });
}
const outpost = contractIdFor(keys.alice.publicKey, 0n, gameWasm);
console.log(`outpost game on app chain: ${Buffer.from(outpost).toString('hex')}`);

// -------------------------------------------------- anchor daemon (settler)

const utf8 = (s) => new TextEncoder().encode(s);
const hexToBytes = (h) => new Uint8Array(Buffer.from(h, 'hex'));

/** Find the lowest delivered-but-open order and settle it as the app. */
async function outcome(chain) {
  const deliveries = await chain.getContractState(outpost, utf8('s:Delivery:'));
  if (deliveries.length === 0) return null;
  const orders = await rpc.getContractState(market, utf8('s:Order:'));
  const phaseOf = new Map(
    orders.map(({ key, value }) => {
      const id = Buffer.from(hexToBytes(key).subarray('s:Order:'.length)).readBigUInt64LE();
      const v = Buffer.from(hexToBytes(value));
      // Order = buyer(32) + good(4+n) + amount(8) + price(8) + phase(8)
      const goodLen = v.readUInt32LE(32);
      const phase = v.readBigUInt64LE(32 + 4 + goodLen + 16);
      return [id, phase];
    }),
  );
  for (const [key, value] of deliveries) {
    const id = Buffer.from(key.subarray('s:Delivery:'.length)).readBigUInt64LE();
    if (phaseOf.get(id) !== 0n) continue;
    const seller = value.subarray(0, 32);
    console.log(`settling order ${id} → seller ${encodeAddress(seller).slice(0, 12)}…`);
    return {
      contract: market,
      action: 'settle',
      args: new Uint8Array(Buffer.concat([Buffer.from(u64(id)), Buffer.from(addr(seller))])),
    };
  }
  return null;
}

const daemon = new AnchorDaemon({
  chain: chainA.chain,
  appId: APP,
  validators: [keys.alice.publicKey, keys.bob.publicKey],
  keyPair: keys.alice,
  l1: { chainId: l1ChainId, nodeKey: nodes[0].rpcPublicKey, bootstrap: testnet.bootstrap },
  relayer,
  outcome,
  epochIntervalMs: 5_000,
  log: (m) => console.log(`[anchor] ${m}`),
});

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
  staticDir: join(repoRoot, 'apps/outpost-web/dist'),
  config: {
    chainId: l1ChainId,
    appChainId: chainA.genesis.chainId,
    appId: APP,
    market: Buffer.from(market).toString('hex'),
    outpost: Buffer.from(outpost).toString('hex'),
    appApi: `http://127.0.0.1:${appGateway.port}`,
    accounts: Object.entries(seeds).map(([name, seed]) => ({
      name,
      seed: Buffer.from(seed).toString('hex'),
    })),
  },
});

console.log(`\n🏰 outpost is live: http://127.0.0.1:${gateway.port}`);
console.log(`   app-chain gateway: http://127.0.0.1:${appGateway.port}`);
console.log('\nplay: claim land + harvest as alice, buy her goods with 🪙 as bob —');
console.log('the anchor daemon settles delivered orders every ~5s epoch.');
console.log('Ctrl-C to stop.');

process.on('SIGINT', async () => {
  console.log('\nshutting down…');
  await daemon.close().catch(() => {});
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
