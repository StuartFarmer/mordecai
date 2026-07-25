import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeAddress, interactiveKdfLimits } from '@mordecai/crypto';
import { decodeTransaction } from '@mordecai/protocol';
import { createWallet, showAddress, signTransfer } from '../src/index.js';
import { verifyTransactionSignature } from '../src/wallet.js';

const kdfLimits = interactiveKdfLimits();
let dir: string;
let keystorePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mordecai-wallet-test-'));
  keystorePath = join(dir, 'keys', 'wallet.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('wallet commands', () => {
  it('create writes a keystore and returns address + mnemonic', () => {
    const result = createWallet({ keystorePath, passphrase: 'pw', kdfLimits });
    expect(result.mnemonic.split(' ')).toHaveLength(24);
    const stored = JSON.parse(readFileSync(keystorePath, 'utf8'));
    expect(stored.address).toBe(result.address);
    expect(readFileSync(keystorePath, 'utf8')).not.toContain(result.mnemonic.split(' ')[0]);
  });

  it('create refuses to overwrite without force', () => {
    createWallet({ keystorePath, passphrase: 'pw', kdfLimits });
    expect(() => createWallet({ keystorePath, passphrase: 'pw', kdfLimits })).toThrow(/exists/);
    expect(() =>
      createWallet({ keystorePath, passphrase: 'pw', kdfLimits, force: true }),
    ).not.toThrow();
  });

  it('address reads the keystore without a passphrase', () => {
    const { address } = createWallet({ keystorePath, passphrase: 'pw', kdfLimits });
    expect(showAddress(keystorePath)).toBe(address);
  });

  it('transfer produces a valid, submittable signed transaction', () => {
    const sender = createWallet({ keystorePath, passphrase: 'pw', kdfLimits });
    const recipientPath = join(dir, 'recipient.json');
    const recipient = createWallet({ keystorePath: recipientPath, passphrase: 'pw', kdfLimits });

    const result = signTransfer({
      keystorePath,
      passphrase: 'pw',
      to: recipient.address,
      amount: 12_345n,
      nonce: 0n,
      chainId: 'mordecai-dev-1',
      maxFee: 100n,
    });

    expect(result.from).toBe(sender.address);
    const tx = decodeTransaction(Uint8Array.from(Buffer.from(result.tx, 'hex')));
    expect(verifyTransactionSignature(tx)).toBe(true);
    expect(tx.payload).toEqual({
      kind: 'transfer',
      to: decodeAddress(recipient.address),
      amount: 12_345n,
    });
    expect(tx.nonce).toBe(0n);
    expect(result.hash).toHaveLength(64);
  });

  it('transfer fails with the wrong passphrase', () => {
    createWallet({ keystorePath, passphrase: 'pw', kdfLimits });
    expect(() =>
      signTransfer({
        keystorePath,
        passphrase: 'wrong',
        to: showAddress(keystorePath),
        amount: 1n,
        nonce: 0n,
        chainId: 'mordecai-dev-1',
        maxFee: 100n,
      }),
    ).toThrow(/passphrase/);
  });
});
