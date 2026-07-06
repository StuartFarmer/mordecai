#!/usr/bin/env node
/**
 * Local devnet: N in-process validators on an in-process DHT testnet.
 *
 *   pnpm build && node apps/devnet/devnet.mjs [validators=4]
 *
 * Prints the faucet wallet mnemonic and each node's RPC key, then runs
 * until Ctrl-C. Data lives in a fresh temp dir per run.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import createTestnet from '../../packages/networking/node_modules/hyperdht/testnet.js';
import { encodeAddress, generateSeed, keyPairFromSeed } from '../../packages/crypto/dist/index.js';
import { Wallet } from '../../packages/wallet/dist/index.js';
import { Node } from '../../packages/node/dist/index.js';

const count = Number(process.argv[2] ?? 4);
const chainId = 'hssn-devnet';

const testnet = await createTestnet(3);
const validators = Array.from({ length: count }, () => keyPairFromSeed(generateSeed()));
const { wallet: faucet, mnemonic } = Wallet.create();

const genesis = {
  chainId,
  validators: validators.map((v) => encodeAddress(v.publicKey)),
  allocations: [{ address: faucet.address, balance: 1_000_000_000n }],
};

const base = mkdtempSync(join(tmpdir(), 'hssn-devnet-'));
const nodes = [];
for (const [i, keyPair] of validators.entries()) {
  const node = await Node.start({
    dir: join(base, `node-${i}`),
    genesis,
    keyPair,
    blockIntervalMs: 300,
    bootstrap: testnet.bootstrap,
    log: (m) => console.log(`[node-${i}] ${m}`),
  });
  nodes.push(node);
  console.log(`node-${i}  rpc key: ${Buffer.from(node.rpcPublicKey).toString('hex')}`);
}

console.log(`\nchain:            ${chainId}`);
console.log(`data dir:         ${base}`);
console.log(`dht bootstrap:    ${testnet.bootstrap.map((b) => `${b.host}:${b.port}`).join(',')}`);
console.log(`faucet address:   ${faucet.address}`);
console.log(`faucet mnemonic:  ${mnemonic}`);
console.log(`\ndevnet running (${count} validators) — Ctrl-C to stop`);

process.on('SIGINT', async () => {
  console.log('\nshutting down…');
  for (const node of nodes) await node.stop().catch(() => {});
  await testnet.destroy();
  process.exit(0);
});
await new Promise(() => {});
