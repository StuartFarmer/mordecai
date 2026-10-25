import { expect, it } from 'vitest';
import {
  createBrowserWallet,
  loadBrowserWallet,
  exportBrowserWallet,
  signBrowserTransaction,
} from '../src/browser.js';
import { Wallet, verifyTransactionSignature } from '../src/wallet.js';

it('generates independent browser identities compatible with native wallets', () => {
  const a = createBrowserWallet();
  const b = createBrowserWallet();
  expect(a.seed).toHaveLength(32);
  expect(a.address).not.toBe(b.address);
  expect(a.address).toBe(Wallet.fromSeed(a.seed).address);
});

it('loads raw seeds and verified libsodium secret keys', () => {
  const seed = '01'.repeat(32);
  const wallet = loadBrowserWallet(seed);
  expect(loadBrowserWallet(seed + Buffer.from(wallet.publicKey).toString('hex')).address).toBe(
    wallet.address,
  );
  expect(() => loadBrowserWallet(seed + '00'.repeat(32))).toThrow(/public key/);
  for (const bad of ['', 'zz'.repeat(32), '01', '01'.repeat(31), '01'.repeat(65)]) {
    expect(() => loadBrowserWallet(bad)).toThrow();
  }
});

it('round-trips portable backups and rejects wrong formats or addresses', () => {
  const wallet = createBrowserWallet();
  const backup = exportBrowserWallet(wallet);
  expect(loadBrowserWallet(backup)).toEqual(wallet);
  const parsed = JSON.parse(backup);
  expect(() =>
    loadBrowserWallet(JSON.stringify({ ...parsed, address: createBrowserWallet().address })),
  ).toThrow(/address/);
  expect(() => loadBrowserWallet(JSON.stringify({ ...parsed, version: 2 }))).toThrow(/format/);
  expect(() => loadBrowserWallet('x'.repeat(4097))).toThrow(/large/);
  expect(() => loadBrowserWallet('{')).toThrow();
});

it('produces exactly the same signed transactions as the native wallet', () => {
  const wallet = createBrowserWallet();
  const params = {
    chainId: 'browser-test',
    nonce: 3n,
    maxFee: 1000n,
    payload: { kind: 'transfer' as const, to: createBrowserWallet().publicKey, amount: 42n },
  };
  const tx = signBrowserTransaction(wallet, params);
  expect(tx).toEqual(Wallet.fromSeed(wallet.seed).signTransaction(params));
  expect(verifyTransactionSignature(tx)).toBe(true);
});
