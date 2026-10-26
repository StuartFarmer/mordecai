import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet, transactionHash } from '@mordecai/wallet';
import {
  createBrowserWallet,
  signAccountRegistration,
  verifyBrowserTransaction,
} from '@mordecai/wallet/browser';
import { decodeTransaction } from '@mordecai/protocol';
import { Accounts } from '../src/accounts.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mordecai-accounts-'));
  dirs.push(dir);
  const funder = Wallet.create().wallet;
  const nonces = { l1: 0n, hex: 0n };
  const receipts = new Map<string, { success: boolean }>();
  const submitted: { network: string; tx: Uint8Array }[] = [];
  let interrupt = '',
    fail = '',
    occupied = false;
  const networks = Object.fromEntries(
    ['l1', 'hex'].map((name) => [
      name,
      {
        wallet: funder,
        amount: name === 'l1' ? 1000000n : 1000000000n,
        rpc: {
          getHead: async () => ({ chainId: name }),
          getAccount: async (address: string) =>
            address === funder.address
              ? { balance: '1000000000000', nonce: String(nonces[name as keyof typeof nonces]) }
              : { balance: occupied ? '1' : '0', nonce: '0' },
          getTx: async (hash: string) => receipts.get(hash) ?? null,
          submitTx: async (bytes: Uint8Array) => {
            const tx = decodeTransaction(bytes);
            expect(verifyBrowserTransaction(tx)).toBe(true);
            submitted.push({ network: name, tx: bytes });
            if (interrupt === name) {
              interrupt = '';
              throw new Error('Lost submission');
            }
            expect(tx.nonce).toBe(nonces[name as keyof typeof nonces]);
            nonces[name as keyof typeof nonces]++;
            const hash = Buffer.from(transactionHash(tx)).toString('hex');
            receipts.set(hash, { success: fail !== name });
            return hash;
          },
          waitForTx: async (hash: string) => receipts.get(hash),
        },
      },
    ]),
  ) as unknown as ConstructorParameters<typeof Accounts>[2];
  const restart = () => new Accounts(dir, 'l1', networks);
  return {
    dir,
    restart,
    submitted,
    service: restart(),
    interrupt: (name: string) => {
      interrupt = name;
    },
    fail: (name: string) => {
      fail = name;
    },
    occupy: () => {
      occupied = true;
    },
  };
}

it('grants exactly 1,000,000 CAI and app fees once, with durable IP cooldown and idempotent replay', async () => {
  let now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const f = fixture(),
    first = createBrowserWallet(),
    second = createBrowserWallet();
  const proof = signAccountRegistration(first, 'l1');
  expect(await f.service.register(proof, 'ip1')).toMatchObject({
    status: 'confirmed',
    amount: '1000000',
    address: first.address,
  });
  expect(f.submitted.map((s) => decodeTransaction(s.tx).payload)).toEqual([
    { kind: 'transfer', to: Buffer.from(first.publicKey), amount: 1000000n },
    { kind: 'transfer', to: Buffer.from(first.publicKey), amount: 1000000000n },
  ]);
  const restarted = f.restart();
  await restarted.register(proof, 'other-ip');
  expect(f.submitted).toHaveLength(2);
  await expect(
    restarted.register(signAccountRegistration(second, 'l1'), 'ip1'),
  ).rejects.toMatchObject({ status: 429, retryAfter: 60 });
  expect(readFileSync(join(f.dir, 'registrations.json'), 'utf8')).not.toContain('ip1');
  now += 60000;
  await restarted.register(signAccountRegistration(second, 'l1'), 'ip1');
  expect(f.submitted).toHaveLength(4);
  now += 60000;
  await restarted.register(proof, 'ip1');
  expect(f.submitted).toHaveLength(4);
});

it('rejects forged or cross-network proofs and existing accounts without issuing funds', async () => {
  const f = fixture(),
    wallet = createBrowserWallet(),
    proof = signAccountRegistration(wallet, 'l1');
  for (const bad of [
    null,
    {},
    { ...proof, signature: '00'.repeat(64) },
    signAccountRegistration(wallet, 'other'),
    { ...proof, amount: '999999' },
  ])
    await expect(f.service.register(bad, 'ip')).rejects.toMatchObject({ status: 400 });
  f.occupy();
  await expect(f.service.register(proof, 'ip')).rejects.toMatchObject({ status: 409 });
  expect(f.submitted).toEqual([]);
});

it('resumes interrupted multi-chain funding after restart using exactly the saved bytes', async () => {
  const f = fixture(),
    proof = signAccountRegistration(createBrowserWallet(), 'l1');
  f.interrupt('hex');
  await expect(f.service.register(proof, 'ip')).rejects.toMatchObject({ status: 503 });
  expect(f.submitted).toHaveLength(2);
  const result = await f.restart().register(proof, 'ip');
  expect(result.status).toBe('confirmed');
  expect(f.submitted).toHaveLength(3);
  expect(f.submitted[2]).toEqual(f.submitted[1]);
});

it('serializes registrations and records failed transfers without paying them again', async () => {
  const f = fixture(),
    proof = signAccountRegistration(createBrowserWallet(), 'l1');
  f.fail('hex');
  const first = f.service.register(proof, 'ip1');
  await expect(
    f.service.register(signAccountRegistration(createBrowserWallet(), 'l1'), 'ip2'),
  ).rejects.toMatchObject({ status: 503 });
  await expect(first).rejects.toMatchObject({ status: 409 });
  await expect(f.restart().register(proof, 'ip3')).rejects.toMatchObject({ status: 409 });
  expect(f.submitted).toHaveLength(2);
});

it('never broadcasts funding if the registration journal cannot be saved', async () => {
  const f = fixture(),
    proof = signAccountRegistration(createBrowserWallet(), 'l1');
  rmSync(f.dir, { recursive: true });
  await expect(f.service.register(proof, 'ip')).rejects.toMatchObject({ status: 503 });
  await expect(f.service.register(proof, 'ip')).rejects.toMatchObject({ status: 503 });
  expect(f.submitted).toEqual([]);
});
