import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import createTestnet from 'hyperdht/testnet';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeAddress } from '@mordecai/crypto';
import { encodeTransaction } from '@mordecai/protocol';
import { NodeRpcClient } from '@mordecai/rpc';
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
});
