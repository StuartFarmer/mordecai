#!/usr/bin/env node
/**
 * One-command frontier demo — the frontier game (from the original CosmWasm
 * mordecai) on Mordecai, played
 * from a browser through the HTTP gateway:
 *
 *   pnpm build && pnpm --filter @mordecai/example-frontier-web build
 *   node scripts/frontier-demo.mjs
 *
 * Starts a 3-validator devnet, deploys the frontier contract
 * (contracts/dist/frontier.wasm — rebuild with scripts/build-wasm.sh),
 * funds two dev accounts, and serves the web client on the gateway.
 * Open the printed URL and play. Ctrl-C to stop.
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
import { NodeRpcClient } from '../packages/rpc/dist/index.js';
import { Node } from '../packages/node/dist/index.js';
import { Gateway } from '../packages/gateway/dist/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const chainId = 'mordecai-frontier-devnet';
const validatorCount = 3;
const port = Number(process.env.PORT ?? 8787);

// dev accounts: fresh keys each run, funded at genesis, seeds handed to the
// browser via /api/config (devnet-only custody model, as in the original CosmWasm mordecai)
const seeds = { alice: generateSeed(), bob: generateSeed() };
const keys = Object.fromEntries(
  Object.entries(seeds).map(([name, seed]) => [name, keyPairFromSeed(seed)]),
);

const testnet = await createTestnet(3);
const validators = Array.from({ length: validatorCount }, () => keyPairFromSeed(generateSeed()));
const genesis = {
  chainId,
  validators: validators.map((v) => encodeAddress(v.publicKey)),
  allocations: Object.values(keys).map((k) => ({
    address: encodeAddress(k.publicKey),
    balance: 100_000_000n,
  })),
};

const base = mkdtempSync(join(tmpdir(), 'mordecai-frontier-demo-'));
const nodes = [];
for (const [i, keyPair] of validators.entries()) {
  nodes.push(
    await Node.start({
      dir: join(base, `node-${i}`),
      genesis,
      keyPair,
      blockIntervalMs: 400,
      bootstrap: testnet.bootstrap,
    }),
  );
}
console.log(`devnet up: ${validatorCount} validators (data: ${base})`);

// deploy + init the frontier contract as alice
const rpc = NodeRpcClient.connect(nodes[0].rpcPublicKey, { bootstrap: testnet.bootstrap });
const alice = keys.alice;

async function submit(nonce, payload) {
  const unsigned = { chainId, nonce, sender: alice.publicKey, maxFee: 500_000n, payload };
  const tx = { ...unsigned, signature: sign(transactionSigningBytes(unsigned), alice.secretKey) };
  const hash = await rpc.submitTx(encodeTransaction(tx));
  const info = await rpc.waitForTx(hash, { timeoutMs: 30_000 });
  if (!info.success) throw new Error(`${payload.kind} failed: ${info.error}`);
  return info;
}

const wasm = new Uint8Array(readFileSync(join(repoRoot, 'contracts/dist/frontier.wasm')));
const deployed = await submit(0n, { kind: 'deploy_contract', code: wasm });
const contract = deployed.returnData;
console.log(`frontier contract deployed: ${contract}`);

const maxTiles = new Uint8Array(8);
new DataView(maxTiles.buffer).setBigUint64(0, 144n, true);
await submit(1n, {
  kind: 'execute_contract',
  contract: new Uint8Array(Buffer.from(contract, 'hex')),
  value: 0n,
  action: 'init',
  args: maxTiles,
});
console.log('contract initialized (max_tiles=144)');
await rpc.close();

const gateway = await Gateway.start({
  nodeKey: nodes[0].rpcPublicKey,
  bootstrap: testnet.bootstrap,
  port,
  staticDir: join(repoRoot, 'apps/frontier-web/dist'),
  config: {
    chainId,
    contract,
    accounts: Object.entries(seeds).map(([name, seed]) => ({
      name,
      seed: Buffer.from(seed).toString('hex'),
    })),
  },
});

console.log(`\n🌾 frontier is live: http://127.0.0.1:${gateway.port}\n`);
console.log('players alice & bob are funded — switch between them in the UI.');
console.log('Ctrl-C to stop.');

process.on('SIGINT', async () => {
  console.log('\nshutting down…');
  await gateway.close().catch(() => {});
  for (const node of nodes) await node.stop().catch(() => {});
  await testnet.destroy();
  process.exit(0);
});
await new Promise(() => {});
