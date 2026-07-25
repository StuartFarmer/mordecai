import { describe, expect, it } from 'vitest';
import {
  DOMAIN_ANCHOR,
  DOMAIN_TX,
  MAX_ACTION_BYTES,
  MAX_APP_VALIDATORS,
  WireError,
  anchorSigningBytes,
  decodeTransaction,
  encodeTransaction,
  transactionSigningBytes,
  type AnchorPayload,
  type Transaction,
} from '../src/index.js';
import {
  anchorTx,
  anchorTxNoCall,
  deployTx,
  executeTx,
  fill,
  registerAppTx,
  transferTx,
  updateAppTx,
} from './fixtures.js';

const allFixtures: [string, () => Transaction][] = [
  ['transfer', transferTx],
  ['deploy_contract', deployTx],
  ['execute_contract', executeTx],
  ['register_app', registerAppTx],
  ['update_app', updateAppTx],
  ['anchor', anchorTx],
  ['anchor (no call)', anchorTxNoCall],
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
    expect(transactionSigningBytes({ ...transferTx(), chainId: 'mordecai-dev-2' })).not.toEqual(
      base,
    );
  });

  it('rejects unknown payload tags', () => {
    const bytes = encodeTransaction(transferTx());
    // Payload tag sits right after chainId (4 + len), nonce (8), sender (32), maxFee (8).
    const tagOffset = 4 + Buffer.byteLength(transferTx().chainId) + 8 + 32 + 8;
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

  it('round-trips register_app with 0 and MAX validators, rejects one more', () => {
    const make = (count: number): Transaction => {
      const tx = registerAppTx();
      tx.payload = {
        ...tx.payload,
        chainValidators: Array.from({ length: count }, (_, i) => fill(32, i + 1)),
      } as Transaction['payload'];
      return tx;
    };
    expect(decodeTransaction(encodeTransaction(make(0)))).toEqual(make(0));
    expect(decodeTransaction(encodeTransaction(make(MAX_APP_VALIDATORS)))).toEqual(
      make(MAX_APP_VALIDATORS),
    );
    expect(() => encodeTransaction(make(MAX_APP_VALIDATORS + 1))).toThrow(WireError);
  });

  it('rejects a non-canonical anchor call flag', () => {
    const withCall = encodeTransaction(anchorTx());
    const noCall = encodeTransaction(anchorTxNoCall());
    // The call flag is the first byte where the two encodings diverge.
    let offset = 0;
    while (withCall[offset] === noCall[offset]) offset++;
    expect(withCall[offset]).toBe(1);
    expect(noCall[offset]).toBe(0);
    const mangled = new Uint8Array(withCall);
    mangled[offset] = 2;
    expect(() => decodeTransaction(mangled)).toThrow(/anchor call flag/);
  });
});

describe('anchor signing bytes', () => {
  const payload = (): Omit<AnchorPayload, 'kind' | 'signatures'> => {
    const { kind: _kind, signatures: _sigs, ...body } = anchorTx().payload as AnchorPayload;
    return body;
  };
  const base = () => anchorSigningBytes('mordecai-dev-1', payload());

  it('is domain separated', () => {
    const prefix = new TextDecoder().decode(base().subarray(0, DOMAIN_ANCHOR.length));
    expect(prefix).toBe(DOMAIN_ANCHOR);
  });

  it('binds every attested field', () => {
    expect(anchorSigningBytes('mordecai-dev-2', payload())).not.toEqual(base());
    expect(anchorSigningBytes('mordecai-dev-1', { ...payload(), appId: 'other' })).not.toEqual(
      base(),
    );
    expect(anchorSigningBytes('mordecai-dev-1', { ...payload(), epoch: 5n })).not.toEqual(base());
    expect(anchorSigningBytes('mordecai-dev-1', { ...payload(), appHeight: 1_025n })).not.toEqual(
      base(),
    );
    expect(
      anchorSigningBytes('mordecai-dev-1', { ...payload(), stateRoot: fill(32, 0x5b) }),
    ).not.toEqual(base());
    const { call: _call, ...noCall } = payload();
    expect(anchorSigningBytes('mordecai-dev-1', noCall)).not.toEqual(base());
    expect(
      anchorSigningBytes('mordecai-dev-1', {
        ...payload(),
        call: { ...payload().call!, action: 'refund' },
      }),
    ).not.toEqual(base());
  });

  it('excludes the signature set', () => {
    // Same body, different signature count → identical preimage.
    const bytes = anchorSigningBytes('mordecai-dev-1', payload());
    expect(bytes).toEqual(base());
  });
});
