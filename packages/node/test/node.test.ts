import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import createTestnet from 'hyperdht/testnet';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeAddress } from '@mordecai/crypto';
import { encodeTransaction } from '@mordecai/protocol';
import { NodeRpcClient, RPC_METHODS } from '@mordecai/rpc';
import { Wallet } from '@mordecai/wallet';
import { Node } from '../src/node.js';
import { initNodeDir, loadNodeDir } from '../src/config.js';

let testnet: Awaited<ReturnType<typeof createTestnet>>;
let dir: string;
let node: Node;
let client: NodeRpcClient;
const { wallet: alice } = Wallet.create();
const { wallet: bob } = Wallet.create();

beforeAll(async () => {
  testnet = await createTestnet(3);
  dir = mkdtempSync(join(tmpdir(), 'mordecai-node-'));
  const config = initNodeDir({
    dir,
    chainId: 'mordecai-test-1',
    allocations: [{ address: alice.address, balance: 1_000_000n }],
  });
  node = await Node.start({
    dir,
    genesis: config.genesis,
    keyPair: config.keyPair,
    blockIntervalMs: 50,
    bootstrap: testnet.bootstrap,
  });
  client = NodeRpcClient.connect(node.rpcPublicKey, { bootstrap: testnet.bootstrap });
}, 60_000);

afterAll(async () => {
  await client.close();
  await node.stop();
  await testnet.destroy();
  rmSync(dir, { recursive: true, force: true });
}, 60_000);

describe('single-sequencer node over hyperswarm RPC (M3 acceptance)', () => {
  it('serves head and genesis balances', { timeout: 30_000 }, async () => {
    const head = await client.getHead();
    expect(head.chainId).toBe('mordecai-test-1');
    expect(head.height).toBe('0');
    expect(await client.getAccount(alice.address)).toMatchObject({
      balance: '1000000',
      nonce: '0',
    });
  });

  it('accepts a signed transfer, seals a block, and settles it', { timeout: 30_000 }, async () => {
    const tx = alice.signTransaction({
      chainId: 'mordecai-test-1',
      nonce: 0n,
      maxFee: 1_000n,
      payload: { kind: 'transfer', to: bob.publicKey, amount: 250_000n },
    });
    const hash = await client.submitTx(encodeTransaction(tx));

    const info = await client.waitForTx(hash);
    expect(info.success).toBe(true);
    expect(info.height).toBe('1');

    const bobAccount = await client.getAccount(bob.address);
    expect(bobAccount.balance).toBe('250000');
    const aliceAccount = await client.getAccount(alice.address);
    expect(aliceAccount.nonce).toBe('1');
    expect(BigInt(aliceAccount.balance)).toBe(1_000_000n - 250_000n - BigInt(info.fee));

    const block = await client.getBlock(1n);
    expect(block).not.toBeNull();
    expect(block!.txs).toHaveLength(1);
    expect(block!.header.proposer).toBe(encodeAddress(node.rpcPublicKey));
  });

  it('rejects an invalid submission with a useful error', { timeout: 30_000 }, async () => {
    const tx = alice.signTransaction({
      chainId: 'wrong-chain',
      nonce: 1n,
      maxFee: 1_000n,
      payload: { kind: 'transfer', to: bob.publicKey, amount: 1n },
    });
    await expect(client.submitTx(encodeTransaction(tx))).rejects.toThrow(/wrong chain id/);
  });

  it('keeps state across a restart', { timeout: 30_000 }, async () => {
    await client.close();
    await node.stop();

    const reloaded = loadNodeDir(dir);
    node = await Node.start({
      dir,
      genesis: reloaded.genesis,
      keyPair: reloaded.keyPair,
      blockIntervalMs: 50,
      bootstrap: testnet.bootstrap,
    });
    client = NodeRpcClient.connect(node.rpcPublicKey, { bootstrap: testnet.bootstrap });

    expect((await client.getHead()).height).toBe('1');
    expect((await client.getAccount(bob.address)).balance).toBe('250000');
  });

  it(
    'serves bounded registry pages with the same JSON encoding as individual apps',
    { timeout: 30_000 },
    async () => {
      expect(RPC_METHODS).toContain('get_apps');
      expect(await client.getApps()).toEqual({ apps: [], nextAfter: null });
      const payload = {
        kind: 'register_app' as const,
        pearKey: new Uint8Array(32).fill(0xab),
        version: '1.2.3',
        contractAddress: new Uint8Array(32).fill(0xcd),
        metadataHash: new Uint8Array(32).fill(0xef),
        chainValidators: [bob.publicKey],
      };
      const txs = Array.from({ length: 101 }, (_, index) =>
        alice.signTransaction({
          chainId: 'mordecai-test-1',
          nonce: BigInt(index + 1),
          maxFee: 1_000n,
          payload: { ...payload, appId: `app.${String(100 - index).padStart(3, '0')}` },
        }),
      );
      const result = await node.chain.produceBlock(txs, loadNodeDir(dir).keyPair);
      expect(result.receipts).toHaveLength(101);
      expect(result.receipts.every((receipt) => receipt.success)).toBe(true);
      const first = await client.getApps();
      expect(first.apps).toHaveLength(50);
      expect(first.nextAfter).toBe('app.049');
      expect(first.apps[0]).toEqual({
        appId: 'app.000',
        owner: alice.address,
        pearKey: 'ab'.repeat(32),
        version: '1.2.3',
        contractAddress: 'cd'.repeat(32),
        metadataHash: 'ef'.repeat(32),
        chainValidators: [Buffer.from(bob.publicKey).toString('hex')],
      });
      expect(await client.getApp('app.000')).toEqual(first.apps[0]);
      const maximum = await client.getApps({ limit: 100 });
      expect(maximum.apps).toHaveLength(100);
      expect(maximum.nextAfter).toBe('app.099');
      expect(await client.getApps({ after: maximum.nextAfter!, limit: 100 })).toEqual({
        apps: [{ ...first.apps[0], appId: 'app.100' }],
        nextAfter: null,
      });
      expect((await client.getApps({ after: 'é'.repeat(32) })).apps).toEqual([]);
    },
  );

  it.each([
    { after: 1 },
    { after: null },
    { after: '' },
    { after: 'é'.repeat(33) },
    { limit: '2' },
    { limit: null },
    { limit: 0 },
    { limit: -1 },
    { limit: 1.5 },
    { limit: 101 },
  ])('rejects invalid registry paging parameters: %j', async (params) => {
    await expect(client.getApps(params as { after?: string; limit?: number })).rejects.toThrow(
      /after|limit/,
    );
  });
});
