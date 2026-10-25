import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { encodeAddress, generateSeed, keyPairFromSeed, sign, type KeyPair } from '@mordecai/crypto';
import { transactionSigningBytes, type Payload } from '@mordecai/protocol';
import { Chain, contractIdFor } from '../src/index.js';
import { decodeState } from '../../../apps/bounties-web/src/chain.js';

const alice = keyPairFromSeed(generateSeed());
const bob = keyPairFromSeed(generateSeed());
const observer = keyPairFromSeed(generateSeed());
const rich = keyPairFromSeed(generateSeed());
const validator = keyPairFromSeed(generateSeed());
const dirs: string[] = [];
let chain: Chain;
let contract: Uint8Array;
const chainId = 'bounties-test';
const u64 = (n: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const str = (s: string) => {
  const b = Buffer.from(s);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
};
const createArgs = (
  end: bigint | number,
  title = 'Question',
  request = 'Public request and criteria',
) => Buffer.concat([str(title), str(request), u64(end)]);
const answerArgs = (id: number, text = 'Public evidence https://example.com') =>
  Buffer.concat([u64(id), str(text)]);
const awardArgs = (id: number, response: number) => Buffer.concat([u64(id), u64(response)]);

async function tx(who: KeyPair, payload: Payload) {
  const account = await chain.getAccount(who.publicKey);
  const unsigned = {
    chainId,
    nonce: account.nonce,
    sender: who.publicKey,
    maxFee: 500000n,
    payload,
  };
  const result = await chain.produceBlock(
    [{ ...unsigned, signature: sign(transactionSigningBytes(unsigned), who.secretKey) }],
    validator,
  );
  expect(result.skipped).toHaveLength(0);
  return result.receipts[0]!;
}
const run = (who: KeyPair, action: string, args: Uint8Array, value = 0n) =>
  tx(who, { kind: 'execute_contract', contract, action, args, value });
const balance = async (who: KeyPair | Uint8Array) =>
  (await chain.getAccount(who instanceof Uint8Array ? who : who.publicKey)).balance;
const board = async () =>
  decodeState(
    (await chain.getContractState(contract)).map(([key, value]) => ({
      key: Buffer.from(key).toString('hex'),
      value: Buffer.from(value).toString('hex'),
    })),
  );
async function beforeHeight(height: number) {
  while (chain.headHeader.height < BigInt(height - 1)) await chain.produceBlock([], validator);
}
async function rejected(who: KeyPair, action: string, args: Uint8Array, value = 0n) {
  const escrow = await balance(contract);
  const before = await board();
  const ownerBalance = await balance(who);
  const receipt = await run(who, action, args, value);
  expect(receipt.success).toBe(false);
  expect(await balance(contract)).toBe(escrow);
  expect(await board()).toEqual(before);
  expect(await balance(who)).toBe(ownerBalance - receipt.fee);
  return receipt;
}

beforeAll(async () => {
  const build = mkdtempSync(join(tmpdir(), 'bounties-compile-'));
  const dir = mkdtempSync(join(tmpdir(), 'bounties-chain-'));
  dirs.push(build, dir);
  execFileSync(
    'python3',
    [
      'compiler/mordecaic',
      'build',
      'compiler/examples/information_bounties.pysc',
      '-o',
      build,
      '--wasm',
    ],
    { stdio: 'pipe', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
  );
  const code = new Uint8Array(readFileSync(join(build, 'information_bounties.wasm')));
  chain = await Chain.open(dir, {
    chainId,
    validators: [encodeAddress(validator.publicKey)],
    allocations: [
      ...[alice, bob, observer].map((who) => ({
        address: encodeAddress(who.publicKey),
        balance: 100000000n,
      })),
      { address: encodeAddress(rich.publicKey), balance: 18446744073709551615n },
    ],
  });
  const receipt = await tx(alice, { kind: 'deploy_contract', code });
  expect(receipt.success).toBe(true);
  contract = contractIdFor(alice.publicKey, 0n, code);
}, 300000);
afterAll(async () => {
  await chain?.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

it('enforces byte limits and funding atomically, including UTF-8 boundaries', async () => {
  await rejected(alice, 'create', createArgs(100), 0n);
  await rejected(alice, 'create', createArgs(100, 'é'.repeat(81)), 1000n);
  await rejected(alice, 'create', createArgs(100, 'Title', 'é'.repeat(4097)), 1000n);
  await rejected(alice, 'create', createArgs(0), 1000n);
  await rejected(alice, 'create', createArgs(18446744073709551615n), 1000n);
  await rejected(bob, 'respond', answerArgs(999));
  await rejected(alice, 'cancel', u64(999));
  const before = await balance(alice);
  const receipt = await run(
    alice,
    'create',
    createArgs(100, 'é'.repeat(80), 'é'.repeat(4096)),
    1000n,
  );
  expect(receipt.success).toBe(true);
  expect(await balance(alice)).toBe(before - 1000n - receipt.fee);
  expect(await balance(contract)).toBe(1000n);
  expect((await board()).bounties[0]).toMatchObject({
    reward: '1000',
    submit_end: 100,
    award_end: 200,
    phase: 0,
  });
  console.info(`bounty max-size create fee: ${receipt.fee}`);
}, 60000);

it('rejects unauthorized/value-bearing actions and keeps independent rewards isolated', async () => {
  expect((await run(alice, 'create', createArgs(100), 2000n)).success).toBe(true);
  await rejected(alice, 'respond', answerArgs(0));
  await rejected(bob, 'respond', answerArgs(0), 1n);
  await rejected(bob, 'respond', answerArgs(0, '🙂'.repeat(2049)));
  expect((await run(bob, 'respond', answerArgs(1))).success).toBe(true);
  const maxResponse = await run(bob, 'respond', answerArgs(0, '🙂'.repeat(2048)));
  expect(maxResponse.success).toBe(true);
  console.info(`bounty max-size response fee: ${maxResponse.fee}`);
  await rejected(alice, 'cancel', u64(0));
  await rejected(observer, 'award', awardArgs(0, 1));
  await rejected(alice, 'award', awardArgs(0, 1));
  expect(await balance(contract)).toBe(3000n);
}, 60000);

it('awards at the submission boundary exactly once, with immutable response recipient', async () => {
  await beforeHeight(99);
  expect((await run(bob, 'respond', answerArgs(0))).success).toBe(true);
  expect(chain.headHeader.height).toBe(99n);
  await rejected(bob, 'respond', answerArgs(0));
  expect(chain.headHeader.height).toBe(100n);
  await rejected(alice, 'award', awardArgs(0, 0));
  await rejected(alice, 'award', awardArgs(0, 999));
  await rejected(alice, 'award', awardArgs(0, 1), 1n);
  const before = await balance(bob);
  const award = await run(alice, 'award', awardArgs(0, 1));
  expect(award.success).toBe(true);
  expect(await balance(bob)).toBe(before + 1000n);
  expect(await balance(contract)).toBe(2000n);
  expect((await board()).bounties[0]).toMatchObject({
    phase: 1,
    winner: 1,
    settled_height: Number(chain.headHeader.height),
  });
  await rejected(alice, 'award', awardArgs(0, 1));
  await rejected(observer, 'refund', u64(0));
}, 60000);

it('refunds only to creator at awardEnd, then rejects late awards and repeats', async () => {
  await beforeHeight(199);
  await rejected(observer, 'refund', u64(1));
  expect(chain.headHeader.height).toBe(199n);
  const before = await balance(alice);
  expect((await run(observer, 'refund', u64(1))).success).toBe(true);
  expect(chain.headHeader.height).toBe(200n);
  expect(await balance(alice)).toBe(before + 2000n);
  expect(await balance(contract)).toBe(0n);
  await rejected(alice, 'award', awardArgs(1, 0));
  await rejected(observer, 'refund', u64(1));
}, 60000);

it('cancels untouched requests once and follows the same timeout for zero responses', async () => {
  expect((await run(alice, 'create', createArgs(220), 3000n)).success).toBe(true);
  await rejected(bob, 'cancel', u64(2));
  await rejected(alice, 'cancel', u64(2), 1n);
  const before = await balance(alice);
  const receipt = await run(alice, 'cancel', u64(2));
  expect(receipt.success).toBe(true);
  expect(await balance(alice)).toBe(before + 3000n - receipt.fee);
  await rejected(alice, 'cancel', u64(2));
  expect((await run(alice, 'create', createArgs(220), 4000n)).success).toBe(true);
  await beforeHeight(220);
  await rejected(alice, 'cancel', u64(3));
  await beforeHeight(320);
  expect((await run(observer, 'refund', u64(3))).success).toBe(true);
  expect(await balance(contract)).toBe(0n);
}, 60000);

it('rolls back closure on recipient overflow and permits award exactly at submission close', async () => {
  expect((await run(alice, 'create', createArgs(340), 1000000n)).success).toBe(true);
  expect((await run(rich, 'respond', answerArgs(4))).success).toBe(true);
  await beforeHeight(340);
  const failed = await rejected(alice, 'award', awardArgs(4, 3));
  expect(failed.error).toMatch(/out of range|overflow/i);
  expect(chain.headHeader.height).toBe(340n);
  expect((await board()).bounties[4].phase).toBe(0);
  expect(
    (await tx(rich, { kind: 'transfer', to: observer.publicKey, amount: 1000000n })).success,
  ).toBe(true);
  expect((await run(alice, 'award', awardArgs(4, 3))).success).toBe(true);
  expect(await balance(contract)).toBe(0n);
  expect((await run(alice, 'create', createArgs(350), 1n)).success).toBe(true);
  expect((await run(bob, 'respond', answerArgs(5))).success).toBe(true);
  await beforeHeight(350);
  expect((await run(alice, 'award', awardArgs(5, 4))).success).toBe(true);
  expect(chain.headHeader.height).toBe(350n);
}, 60000);
