import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeAddress, generateSeed, keyPairFromSeed, sign, type KeyPair } from '@mordecai/crypto';
import { transactionSigningBytes, type Payload, type Transaction } from '@mordecai/protocol';
import {
  Chain,
  ChainError,
  Mempool,
  MempoolError,
  computeFee,
  genesisHash,
  transactionHash,
  type Genesis,
} from '../src/index.js';

const CHAIN_ID = 'mordecai-test-1';
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mordecai-chain-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function openChain(genesis: Genesis): Promise<Chain> {
  const chain = await Chain.open(tmp(), genesis);
  cleanups.push(() => chain.close());
  return chain;
}

const kp = (): KeyPair => keyPairFromSeed(generateSeed());

function signedTx(
  sender: KeyPair,
  nonce: bigint,
  payload: Payload,
  opts: { chainId?: string; maxFee?: bigint } = {},
): Transaction {
  const unsigned = {
    chainId: opts.chainId ?? CHAIN_ID,
    nonce,
    sender: sender.publicKey,
    maxFee: opts.maxFee ?? 1_000n,
    payload,
  };
  return { ...unsigned, signature: sign(transactionSigningBytes(unsigned), sender.secretKey) };
}

function transfer(sender: KeyPair, nonce: bigint, to: Uint8Array, amount: bigint): Transaction {
  return signedTx(sender, nonce, { kind: 'transfer', to, amount });
}

// Shared cast: alice funded, val is the only validator.
const alice = kp();
const bob = kp();
const val = kp();

function genesis(): Genesis {
  return {
    chainId: CHAIN_ID,
    validators: [encodeAddress(val.publicKey)],
    allocations: [{ address: encodeAddress(alice.publicKey), balance: 1_000_000n }],
  };
}

describe('genesis', () => {
  it('seeds allocations and starts at height 0', async () => {
    const chain = await openChain(genesis());
    expect(chain.height).toBe(0n);
    expect((await chain.getAccount(alice.publicKey)).balance).toBe(1_000_000n);
    expect((await chain.getAccount(bob.publicKey)).balance).toBe(0n);
  });

  it('two nodes from the same genesis agree on hash and head', async () => {
    const a = await openChain(genesis());
    const b = await openChain(genesis());
    expect(genesisHash(a.genesis)).toEqual(genesisHash(b.genesis));
    expect(a.headHash).toEqual(b.headHash);
  });
});

describe('block production', () => {
  it('executes a transfer: balances, fee, nonce, receipt, block record', async () => {
    const chain = await openChain(genesis());
    const tx = transfer(alice, 0n, bob.publicKey, 5_000n);
    const fee = computeFee(tx);

    const { block, receipts, skipped } = await chain.produceBlock([tx], val, 1_000n);

    expect(skipped).toEqual([]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.success).toBe(true);
    expect(chain.height).toBe(1n);
    expect((await chain.getAccount(alice.publicKey)).balance).toBe(1_000_000n - 5_000n - fee);
    expect((await chain.getAccount(alice.publicKey)).nonce).toBe(1n);
    expect((await chain.getAccount(bob.publicKey)).balance).toBe(5_000n);
    expect((await chain.getAccount(val.publicKey)).balance).toBe(fee);

    expect(await chain.getBlock(1n)).toEqual(block);
    const record = await chain.getTxRecord(transactionHash(tx));
    expect(record).toMatchObject({ height: 1n, index: 0, receipt: { success: true, fee } });
  });

  it('chains nonces within one block for the same sender', async () => {
    const chain = await openChain(genesis());
    const txs = [0n, 1n, 2n].map((n) => transfer(alice, n, bob.publicKey, 100n));
    const { receipts, skipped } = await chain.produceBlock(txs, val, 1_000n);
    expect(skipped).toEqual([]);
    expect(receipts.every((r) => r.success)).toBe(true);
    expect((await chain.getAccount(bob.publicKey)).balance).toBe(300n);
    expect((await chain.getAccount(alice.publicKey)).nonce).toBe(3n);
  });

  it('failed execution still charges the fee and consumes the nonce', async () => {
    const chain = await openChain(genesis());
    const tx = transfer(alice, 0n, bob.publicKey, 2_000_000n); // more than balance
    const fee = computeFee(tx);
    const { receipts } = await chain.produceBlock([tx], val, 1_000n);
    expect(receipts[0]!.success).toBe(false);
    expect(receipts[0]!.error).toMatch(/insufficient balance/);
    expect((await chain.getAccount(alice.publicKey)).balance).toBe(1_000_000n - fee);
    expect((await chain.getAccount(alice.publicKey)).nonce).toBe(1n);
    expect((await chain.getAccount(bob.publicKey)).balance).toBe(0n);
  });

  it('drops non-includable transactions in produce mode', async () => {
    const chain = await openChain(genesis());
    const wrongChain = transfer(alice, 0n, bob.publicKey, 1n);
    const badTxs = [
      signedTx(
        alice,
        0n,
        { kind: 'transfer', to: bob.publicKey, amount: 1n },
        { chainId: 'other' },
      ),
      transfer(alice, 5n, bob.publicKey, 1n), // future nonce
      transfer(bob, 0n, alice.publicKey, 1n), // cannot pay fee
      signedTx(alice, 0n, { kind: 'deploy_contract', code: new Uint8Array(8) }), // unsupported in M3
      { ...wrongChain, signature: new Uint8Array(64) }, // bad signature
    ];
    const { block, receipts, skipped } = await chain.produceBlock(badTxs, val, 1_000n);
    expect(receipts).toEqual([]);
    expect(block.txs).toEqual([]);
    expect(skipped).toHaveLength(5);
    expect(chain.height).toBe(1n);
  });

  it('rejects a proposer outside the validator set', async () => {
    const chain = await openChain(genesis());
    await expect(chain.produceBlock([], bob, 1_000n)).rejects.toThrow(/validator set/);
  });
});

describe('applyBlock (follower replay)', () => {
  it('a follower replays blocks to the identical head and state root', async () => {
    const producer = await openChain(genesis());
    const follower = await openChain(genesis());

    const r1 = await producer.produceBlock(
      [transfer(alice, 0n, bob.publicKey, 5_000n)],
      val,
      1_000n,
    );
    const r2 = await producer.produceBlock(
      [transfer(alice, 1n, bob.publicKey, 7_000n)],
      val,
      2_000n,
    );

    await follower.applyBlock(r1.block);
    await follower.applyBlock(r2.block);

    expect(follower.height).toBe(2n);
    expect(follower.headHash).toEqual(producer.headHash);
    expect(follower.headHeader.stateRoot).toEqual(producer.headHeader.stateRoot);
    expect(await follower.getAccount(bob.publicKey)).toEqual(
      await producer.getAccount(bob.publicKey),
    );
  });

  it('rejects tampered, replayed, and foreign blocks', async () => {
    const producer = await openChain(genesis());
    const follower = await openChain(genesis());
    const { block } = await producer.produceBlock(
      [transfer(alice, 0n, bob.publicKey, 5_000n)],
      val,
      1_000n,
    );

    // Tampered header breaks the proposer signature.
    const tampered = {
      ...block,
      header: { ...block.header, stateRoot: new Uint8Array(32) },
    };
    await expect(follower.applyBlock(tampered)).rejects.toThrow(ChainError);

    // Valid block applies once, then replays are rejected.
    await follower.applyBlock(block);
    await expect(follower.applyBlock(block)).rejects.toThrow(/bad height/);
  });
});

describe('persistence', () => {
  it('reopens with height and balances intact', async () => {
    const dir = tmp();
    const g = genesis();
    const chain = await Chain.open(dir, g);
    await chain.produceBlock([transfer(alice, 0n, bob.publicKey, 5_000n)], val, 1_000n);
    const headHash = chain.headHash;
    await chain.close();

    const reopened = await Chain.open(dir, g);
    cleanups.push(() => reopened.close());
    expect(reopened.height).toBe(1n);
    expect(reopened.headHash).toEqual(headHash);
    expect((await reopened.getAccount(bob.publicKey)).balance).toBe(5_000n);
  });

  it('refuses a data dir created from a different genesis', async () => {
    const dir = tmp();
    const chain = await Chain.open(dir, genesis());
    await chain.close();
    const other: Genesis = { ...genesis(), allocations: [] };
    await expect(Chain.open(dir, other)).rejects.toThrow(/different genesis/);
  });
});

describe('mempool', () => {
  it('admits, orders, and prunes transactions', async () => {
    const chain = await openChain(genesis());
    const mempool = new Mempool(chain);

    const t0 = transfer(alice, 0n, bob.publicKey, 100n);
    const t1 = transfer(alice, 1n, bob.publicKey, 100n);
    const t3 = transfer(alice, 3n, bob.publicKey, 100n); // gap at nonce 2
    await mempool.add(t1);
    await mempool.add(t0);
    await mempool.add(t3);
    expect(mempool.size).toBe(3);

    // Contiguous from account nonce: 0,1 — the gap strands nonce 3.
    expect(await mempool.takeForBlock(10)).toEqual([t0, t1]);

    await chain.produceBlock([t0, t1], val, 1_000n);
    await mempool.prune();
    expect(mempool.size).toBe(1); // t3 still waiting on nonce 2
    expect(await mempool.takeForBlock(10)).toEqual([]);
  });

  it('rejects bad admissions', async () => {
    const chain = await openChain(genesis());
    const mempool = new Mempool(chain);

    await expect(
      mempool.add(signedTx(alice, 0n, { kind: 'deploy_contract', code: new Uint8Array(4) })),
    ).rejects.toThrow(MempoolError);
    await expect(mempool.add(transfer(bob, 0n, alice.publicKey, 1n))).rejects.toThrow(/fee/);

    const t0 = transfer(alice, 0n, bob.publicKey, 100n);
    await mempool.add(t0);
    expect(await mempool.add(t0)).toEqual(transactionHash(t0)); // idempotent
    await expect(mempool.add(transfer(alice, 0n, bob.publicKey, 999n))).rejects.toThrow(
      /replacement/,
    );

    await chain.produceBlock([t0], val, 1_000n);
    await expect(mempool.add(transfer(alice, 0n, bob.publicKey, 1n))).rejects.toThrow(
      /nonce too low/,
    );
  });
});
