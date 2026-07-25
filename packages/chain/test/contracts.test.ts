import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeAddress, generateSeed, keyPairFromSeed, sign, type KeyPair } from '@mordecai/crypto';
import { transactionSigningBytes, type Payload, type Transaction } from '@mordecai/protocol';
import {
  Chain,
  FUEL_PER_FEE,
  MAX_FUEL,
  Mempool,
  MempoolError,
  computeFee,
  contractIdFor,
  type Genesis,
} from '../src/index.js';

const counterWasm = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../../contracts/dist/counter.wasm', import.meta.url))),
);
const marketWasm = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../../contracts/dist/marketplace.wasm', import.meta.url))),
);
const floatyWasm = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../vm/test/fixtures/floaty.wasm', import.meta.url))),
);

const CHAIN_ID = 'mordecai-contracts-test';
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const kp = (): KeyPair => keyPairFromSeed(generateSeed());
const alice = kp();
const bob = kp();
const val = kp();

function genesis(): Genesis {
  return {
    chainId: CHAIN_ID,
    validators: [encodeAddress(val.publicKey)],
    allocations: [
      { address: encodeAddress(alice.publicKey), balance: 10_000_000n },
      { address: encodeAddress(bob.publicKey), balance: 10_000_000n },
    ],
  };
}

async function openChain(): Promise<Chain> {
  const dir = mkdtempSync(join(tmpdir(), 'mordecai-contracts-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const chain = await Chain.open(dir, genesis());
  cleanups.push(() => chain.close());
  return chain;
}

function signedTx(
  sender: KeyPair,
  nonce: bigint,
  payload: Payload,
  maxFee = 500_000n,
): Transaction {
  const unsigned = { chainId: CHAIN_ID, nonce, sender: sender.publicKey, maxFee, payload };
  return { ...unsigned, signature: sign(transactionSigningBytes(unsigned), sender.secretKey) };
}

const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return new Uint8Array(b);
};

function deploy(sender: KeyPair, nonce: bigint, code: Uint8Array): Transaction {
  return signedTx(sender, nonce, { kind: 'deploy_contract', code });
}

function execute(
  sender: KeyPair,
  nonce: bigint,
  contract: Uint8Array,
  action: string,
  args: Uint8Array = new Uint8Array(0),
  value = 0n,
): Transaction {
  return signedTx(sender, nonce, { kind: 'execute_contract', contract, value, action, args });
}

describe('contract lifecycle (M5)', () => {
  it('deploys and executes with storage, events, fuel-based fees', async () => {
    const chain = await openChain();
    const deployTx = deploy(alice, 0n, counterWasm);
    const contractId = contractIdFor(alice.publicKey, 0n, counterWasm);

    const r1 = await chain.produceBlock([deployTx], val, 1_000n);
    expect(r1.receipts[0]!.success).toBe(true);
    expect(r1.receipts[0]!.returnData).toEqual(contractId);

    const call = execute(alice, 1n, contractId, 'increment');
    const r2 = await chain.produceBlock([call], val, 2_000n);
    const receipt = r2.receipts[0]!;
    expect(receipt.success).toBe(true);
    expect(Buffer.from(receipt.returnData).readBigUInt64LE()).toBe(1n);
    expect(new TextDecoder().decode(receipt.events[0])).toBe('count=1');
    // Execution costs more than the static fee but never exceeds maxFee.
    expect(receipt.fee).toBeGreaterThan(computeFee(call));
    expect(receipt.fee).toBeLessThanOrEqual(call.maxFee);
  });

  it('moves attached value into the contract account and pays out via transfer', async () => {
    const chain = await openChain();
    await chain.produceBlock([deploy(alice, 0n, counterWasm)], val, 1_000n);
    const contractId = contractIdFor(alice.publicKey, 0n, counterWasm);

    const depositTx = execute(alice, 1n, contractId, 'deposit', new Uint8Array(0), 700n);
    const r = await chain.produceBlock([depositTx], val, 2_000n);
    expect(r.receipts[0]!.success).toBe(true);
    expect((await chain.getAccount(contractId)).balance).toBe(700n);

    // refund sends the attached value straight back to the caller.
    const before = (await chain.getAccount(bob.publicKey)).balance;
    const refundTx = execute(bob, 0n, contractId, 'refund', new Uint8Array(0), 555n);
    const r2 = await chain.produceBlock([refundTx], val, 3_000n);
    expect(r2.receipts[0]!.success).toBe(true);
    const after = (await chain.getAccount(bob.publicKey)).balance;
    expect(before - after).toBe(r2.receipts[0]!.fee); // value went out and came back
    expect((await chain.getAccount(contractId)).balance).toBe(700n);
  });

  it('reverts all effects (including value) on abort, still charging fees', async () => {
    const chain = await openChain();
    await chain.produceBlock([deploy(alice, 0n, counterWasm)], val, 1_000n);
    const contractId = contractIdFor(alice.publicKey, 0n, counterWasm);
    await chain.produceBlock([execute(alice, 1n, contractId, 'increment')], val, 2_000n);

    const before = (await chain.getAccount(alice.publicKey)).balance;
    const boom = execute(alice, 2n, contractId, 'boom', new Uint8Array(0), 123n);
    const r = await chain.produceBlock([boom], val, 3_000n);
    const receipt = r.receipts[0]!;
    expect(receipt.success).toBe(false);
    expect(receipt.error).toBe('boom: deliberate abort');
    expect(receipt.events).toEqual([]);

    // Nonce consumed, fee charged, but the 123 value and the storage write reverted.
    const account = await chain.getAccount(alice.publicKey);
    expect(account.nonce).toBe(3n);
    expect(before - account.balance).toBe(receipt.fee);
    expect((await chain.getAccount(contractId)).balance).toBe(0n);
    const check = await chain.produceBlock(
      [execute(alice, 3n, contractId, 'increment')],
      val,
      4_000n,
    );
    expect(Buffer.from(check.receipts[0]!.returnData).readBigUInt64LE()).toBe(2n); // not 999999
  });

  it('halts runaway execution deterministically and charges at most maxFee', async () => {
    const chain = await openChain();
    await chain.produceBlock([deploy(alice, 0n, counterWasm)], val, 1_000n);
    const contractId = contractIdFor(alice.publicKey, 0n, counterWasm);

    const spin = execute(alice, 1n, contractId, 'spin');
    const r = await chain.produceBlock([spin], val, 2_000n);
    expect(r.receipts[0]!.success).toBe(false);
    expect(r.receipts[0]!.error).toMatch(/out of fuel/);
    // The MAX_FUEL cap binds before maxFee here: static fee + the full budget.
    expect(r.receipts[0]!.fee).toBe(computeFee(spin) + MAX_FUEL / FUEL_PER_FEE);
    expect(r.receipts[0]!.fee).toBeLessThanOrEqual(spin.maxFee);
  });

  it('runs the marketplace: list, buy with exact value, ownership flip', async () => {
    const chain = await openChain();
    await chain.produceBlock([deploy(alice, 0n, marketWasm)], val, 1_000n);
    const market = contractIdFor(alice.publicKey, 0n, marketWasm);

    // Alice lists for 50_000.
    const list = execute(alice, 1n, market, 'list', u64(50_000n));
    const r1 = await chain.produceBlock([list], val, 2_000n);
    expect(r1.receipts[0]!.success).toBe(true);
    const itemId = Buffer.from(r1.receipts[0]!.returnData).readBigUInt64LE();
    expect(itemId).toBe(0n);

    // Bob buys with the exact price attached; Alice gets paid.
    const aliceBefore = (await chain.getAccount(alice.publicKey)).balance;
    const buy = execute(bob, 0n, market, 'buy', u64(itemId), 50_000n);
    const r2 = await chain.produceBlock([buy], val, 3_000n);
    expect(r2.receipts[0]!.success).toBe(true);
    expect((await chain.getAccount(alice.publicKey)).balance).toBe(aliceBefore + 50_000n);
    expect((await chain.getAccount(market)).balance).toBe(0n);

    // Item now belongs to Bob and is off sale.
    const get = execute(bob, 1n, market, 'get_item', u64(itemId));
    const r3 = await chain.produceBlock([get], val, 4_000n);
    const item = r3.receipts[0]!.returnData;
    expect(item.slice(0, 32)).toEqual(bob.publicKey);
    expect(item[40]).toBe(0); // not for sale

    // Alice can no longer buy it back while off sale.
    const rebuy = execute(alice, 2n, market, 'buy', u64(itemId), 50_000n);
    const r4 = await chain.produceBlock([rebuy], val, 5_000n);
    expect(r4.receipts[0]!.success).toBe(false);
    expect(r4.receipts[0]!.error).toBe('item not for sale');
  });

  it('wrong attached value fails the trade and refunds it', async () => {
    const chain = await openChain();
    await chain.produceBlock([deploy(alice, 0n, marketWasm)], val, 1_000n);
    const market = contractIdFor(alice.publicKey, 0n, marketWasm);
    await chain.produceBlock([execute(alice, 1n, market, 'list', u64(10_000n))], val, 2_000n);

    const before = (await chain.getAccount(bob.publicKey)).balance;
    const lowball = execute(bob, 0n, market, 'buy', u64(0n), 9_999n);
    const r = await chain.produceBlock([lowball], val, 3_000n);
    expect(r.receipts[0]!.success).toBe(false);
    expect(r.receipts[0]!.error).toBe('attached value must equal price');
    expect(before - (await chain.getAccount(bob.publicKey)).balance).toBe(r.receipts[0]!.fee);
  });

  it('follower replay of contract blocks reaches identical state roots', async () => {
    const producer = await openChain();
    const follower = await openChain();
    const blocks = [];
    blocks.push((await producer.produceBlock([deploy(alice, 0n, marketWasm)], val, 1_000n)).block);
    const market = contractIdFor(alice.publicKey, 0n, marketWasm);
    blocks.push(
      (await producer.produceBlock([execute(alice, 1n, market, 'list', u64(5_000n))], val, 2_000n))
        .block,
    );
    blocks.push(
      (await producer.produceBlock([execute(bob, 0n, market, 'buy', u64(0n), 5_000n)], val, 3_000n))
        .block,
    );
    for (const block of blocks) await follower.applyBlock(block);
    expect(follower.headHash).toEqual(producer.headHash);
    expect(follower.headHeader.stateRoot).toEqual(producer.headHeader.stateRoot);
  });

  it('rejects float-using contracts at admission', async () => {
    const chain = await openChain();
    const mempool = new Mempool(chain);
    await expect(mempool.add(deploy(alice, 0n, floatyWasm))).rejects.toThrow(MempoolError);
    const { skipped } = await chain.produceBlock([deploy(alice, 0n, floatyWasm)], val, 1_000n);
    expect(skipped[0]!.reason).toMatch(/forbidden feature/);
  });
});
