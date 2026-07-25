import { PUBKEY_SIZE, Reader, Writer } from '@mordecai/protocol';

export interface Account {
  balance: bigint;
  nonce: bigint;
}

export const EMPTY_ACCOUNT: Account = { balance: 0n, nonce: 0n };

const ACCOUNT_PREFIX = new TextEncoder().encode('a:');

/** State key for an account: `a:` + 32-byte public key. */
export function accountKey(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== PUBKEY_SIZE) {
    throw new RangeError(`account key needs a ${PUBKEY_SIZE}-byte public key`);
  }
  const key = new Uint8Array(ACCOUNT_PREFIX.length + PUBKEY_SIZE);
  key.set(ACCOUNT_PREFIX);
  key.set(publicKey, ACCOUNT_PREFIX.length);
  return key;
}

export function encodeAccount(account: Account): Uint8Array {
  const w = new Writer(16);
  w.u64(account.balance);
  w.u64(account.nonce);
  return w.finish();
}

export function decodeAccount(bytes: Uint8Array): Account {
  const r = new Reader(bytes);
  const account = { balance: r.u64(), nonce: r.u64() };
  r.finish();
  return account;
}
