import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import createTestnet from 'hyperdht/testnet';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Genesis } from '@hssn/chain';
import { encodeAddress, generateSeed, keyPairFromSeed } from '@hssn/crypto';
import { encodeTransaction } from '@hssn/protocol';
import { NodeRpcClient } from '@hssn/rpc';
import { Wallet } from '@hssn/wallet';
import { Node } from '../src/node.js';

const CHAIN_ID = 'hssn-devnet-test';
const validatorKeys = [0, 1, 2].map(() => keyPairFromSeed(generateSeed()));
const { wallet: alice } = Wallet.create();
const { wallet: bob } = Wallet.create();

const genesis: Genesis = {
  chainId: CHAIN_ID,
  validators: validatorKeys.map((v) => encodeAddress(v.publicKey)),
  allocations: [{ address: alice.address, balance: 5_000_000n }],
};

let testnet: Awaited<ReturnType<typeof createTestnet>>;
const dirs: string[] = [];
const nodes: Node[] = [];
let client: NodeRpcClient;

beforeAll(async () => {
  testnet = await createTestnet(3);
  for (const keyPair of validatorKeys) {
    const dir = mkdtempSync(join(tmpdir(), 'hssn-devnet-'));
    dirs.push(dir);
    nodes.push(
      await Node.start({
        dir,
        genesis,
        keyPair,
        blockIntervalMs: 100,
        bootstrap: testnet.bootstrap,
      }),
    );
  }
  client = NodeRpcClient.connect(nodes[0]!.rpcPublicKey, { bootstrap: testnet.bootstrap });
}, 60_000);

afterAll(async () => {
  await client.close();
  for (const node of nodes) await node.stop().catch(() => {});
  await testnet.destroy();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}, 60_000);

describe('3-validator devnet via Node + RPC (M4 acceptance)', () => {
  it(
    'settles an RPC-submitted transfer through consensus on every node',
    { timeout: 45_000 },
    async () => {
      const tx = alice.signTransaction({
        chainId: CHAIN_ID,
        nonce: 0n,
        maxFee: 1_000n,
        payload: { kind: 'transfer', to: bob.publicKey, amount: 42_000n },
      });
      const hash = await client.submitTx(encodeTransaction(tx));
      const info = await client.waitForTx(hash, { timeoutMs: 30_000 });
      expect(info.success).toBe(true);

      // Every validator (not just the RPC target) reaches the same head.
      const deadline = Date.now() + 30_000;
      while (nodes.some((n) => n.chain.height < 1n)) {
        if (Date.now() > deadline) throw new Error('validators did not converge');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const heads = nodes.map((n) => Buffer.from(n.chain.headHash).toString('hex'));
      expect(new Set(heads).size).toBe(1);

      // Query a *different* node than the one that took the submission.
      const client2 = NodeRpcClient.connect(nodes[2]!.rpcPublicKey, {
        bootstrap: testnet.bootstrap,
      });
      try {
        expect((await client2.getAccount(bob.address)).balance).toBe('42000');
      } finally {
        await client2.close();
      }
    },
  );
});
