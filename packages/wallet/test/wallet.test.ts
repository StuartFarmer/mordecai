import { describe, expect, it } from 'vitest';
import { interactiveKdfLimits, verify } from '@mordecai/crypto';
import { decodeTransaction, encodeTransaction, transactionSigningBytes } from '@mordecai/protocol';
import { Wallet, transactionHash, verifyTransactionSignature } from '../src/index.js';

const CHAIN_ID = 'mordecai-dev-1';

function signedTransfer(wallet: Wallet, amount = 500n) {
  const { wallet: recipient } = Wallet.create();
  return wallet.signTransaction({
    chainId: CHAIN_ID,
    nonce: 0n,
    maxFee: 100n,
    payload: { kind: 'transfer', to: recipient.publicKey, amount },
  });
}

describe('Wallet', () => {
  it('signs a transaction that verifies against the canonical preimage', () => {
    const { wallet } = Wallet.create();
    const tx = signedTransfer(wallet);
    expect(tx.sender).toEqual(wallet.publicKey);
    expect(verify(tx.signature, transactionSigningBytes(tx), wallet.publicKey)).toBe(true);
    expect(verifyTransactionSignature(tx)).toBe(true);
  });

  it('signed transactions survive the wire round-trip', () => {
    const { wallet } = Wallet.create();
    const tx = signedTransfer(wallet);
    const decoded = decodeTransaction(encodeTransaction(tx));
    expect(decoded).toEqual(tx);
    expect(verifyTransactionSignature(decoded)).toBe(true);
  });

  it('rejects signature verification after tampering', () => {
    const { wallet } = Wallet.create();
    const tx = signedTransfer(wallet);
    expect(verifyTransactionSignature({ ...tx, nonce: 1n })).toBe(false);
    expect(verifyTransactionSignature({ ...tx, maxFee: 999_999n })).toBe(false);
  });

  it('transaction hashes are unique per transaction', () => {
    const { wallet } = Wallet.create();
    const a = transactionHash(signedTransfer(wallet, 1n));
    const b = transactionHash(signedTransfer(wallet, 2n));
    expect(a).toHaveLength(32);
    expect(a).not.toEqual(b);
  });

  it('recovers the same wallet from its mnemonic', () => {
    const { wallet, mnemonic } = Wallet.create();
    const recovered = Wallet.fromMnemonic(mnemonic);
    expect(recovered.address).toBe(wallet.address);
    expect(recovered.publicKey).toEqual(wallet.publicKey);
  });

  it('round-trips through an encrypted keystore', () => {
    const { wallet } = Wallet.create();
    const keystore = wallet.toKeystore('pw', interactiveKdfLimits());
    const restored = Wallet.fromKeystore(keystore, 'pw');
    expect(restored.address).toBe(wallet.address);
    expect(() => Wallet.fromKeystore(keystore, 'nope')).toThrow(/passphrase/);
  });

  it('signs application-auth messages', () => {
    const { wallet } = Wallet.create();
    const challenge = new TextEncoder().encode('app-login-challenge-123');
    const sig = wallet.signMessage(challenge);
    expect(verify(sig, challenge, wallet.publicKey)).toBe(true);
  });
});
