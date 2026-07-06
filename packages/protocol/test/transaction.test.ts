import { describe, expect, it } from 'vitest';
import {
  DOMAIN_TX,
  MAX_ACTION_BYTES,
  WireError,
  decodeTransaction,
  encodeTransaction,
  transactionSigningBytes,
  type Transaction,
} from '../src/index.js';
import { deployTx, executeTx, fill, registerAppTx, transferTx, updateAppTx } from './fixtures.js';

const allFixtures: [string, () => Transaction][] = [
  ['transfer', transferTx],
  ['deploy_contract', deployTx],
  ['execute_contract', executeTx],
  ['register_app', registerAppTx],
  ['update_app', updateAppTx],
];

describe('transaction encoding', () => {
  it.each(allFixtures)('round-trips a %s transaction', (_name, make) => {
    const tx = make();
    expect(decodeTransaction(encodeTransaction(tx))).toEqual(tx);
  });

  it('produces domain-separated signing bytes', () => {
    const bytes = transactionSigningBytes(transferTx());
    const prefix = new TextDecoder().decode(bytes.subarray(0, DOMAIN_TX.length));
    expect(prefix).toBe(DOMAIN_TX);
  });

  it('signing bytes exclude the signature', () => {
    const a = transferTx();
    const b = { ...a, signature: fill(64, 0x00) };
    expect(transactionSigningBytes(a)).toEqual(transactionSigningBytes(b));
  });

  it('signing bytes change with any unsigned field', () => {
    const base = transactionSigningBytes(transferTx());
    expect(transactionSigningBytes({ ...transferTx(), nonce: 8n })).not.toEqual(base);
    expect(transactionSigningBytes({ ...transferTx(), maxFee: 1_001n })).not.toEqual(base);
    expect(transactionSigningBytes({ ...transferTx(), chainId: 'hssn-dev-2' })).not.toEqual(base);
  });

  it('rejects unknown payload tags', () => {
    const bytes = encodeTransaction(transferTx());
    // Payload tag sits right after chainId (4+10), nonce (8), sender (32), maxFee (8).
    const tagOffset = 4 + 10 + 8 + 32 + 8;
    expect(bytes[tagOffset]).toBe(1);
    bytes[tagOffset] = 99;
    expect(() => decodeTransaction(bytes)).toThrow(/unknown payload tag/);
  });

  it('rejects truncated transactions', () => {
    const bytes = encodeTransaction(transferTx());
    expect(() => decodeTransaction(bytes.subarray(0, bytes.length - 1))).toThrow(WireError);
  });

  it('rejects trailing bytes', () => {
    const bytes = encodeTransaction(transferTx());
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes);
    expect(() => decodeTransaction(padded)).toThrow(/trailing/);
  });

  it('rejects wrong-size keys and signatures on encode', () => {
    expect(() => encodeTransaction({ ...transferTx(), sender: fill(31, 1) })).toThrow(WireError);
    expect(() => encodeTransaction({ ...transferTx(), signature: fill(63, 1) })).toThrow(WireError);
  });

  it('enforces the action length limit', () => {
    const tx = executeTx();
    tx.payload = {
      ...tx.payload,
      action: 'a'.repeat(MAX_ACTION_BYTES + 1),
    } as Transaction['payload'];
    expect(() => encodeTransaction(tx)).toThrow(WireError);
  });

  it('preserves u64 boundary values', () => {
    const tx = transferTx();
    tx.payload = { kind: 'transfer', to: fill(32, 0x22), amount: 0xffffffffffffffffn };
    tx.nonce = 0xffffffffffffffffn;
    expect(decodeTransaction(encodeTransaction(tx))).toEqual(tx);
  });
});
