import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { decodeAddress, type KdfLimits, type Keystore } from '@hssn/crypto';
import { encodeTransaction } from '@hssn/protocol';
import { Wallet, transactionHash } from './wallet.js';

const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');

function readKeystoreFile(path: string): Keystore {
  return JSON.parse(readFileSync(path, 'utf8')) as Keystore;
}

export interface CreateOptions {
  keystorePath: string;
  passphrase: string;
  force?: boolean;
  kdfLimits?: KdfLimits;
}

export interface CreateResult {
  address: string;
  mnemonic: string;
  keystorePath: string;
}

export function createWallet(options: CreateOptions): CreateResult {
  if (existsSync(options.keystorePath) && !options.force) {
    throw new Error(`keystore already exists: ${options.keystorePath} (use --force to overwrite)`);
  }
  const { wallet, mnemonic } = Wallet.create();
  const keystore = wallet.toKeystore(options.passphrase, options.kdfLimits);
  mkdirSync(dirname(options.keystorePath), { recursive: true });
  writeFileSync(options.keystorePath, JSON.stringify(keystore, null, 2) + '\n', { mode: 0o600 });
  return { address: wallet.address, mnemonic, keystorePath: options.keystorePath };
}

/** The address is stored in the clear; no passphrase needed. */
export function showAddress(keystorePath: string): string {
  return readKeystoreFile(keystorePath).address;
}

export interface TransferOptions {
  keystorePath: string;
  passphrase: string;
  to: string;
  amount: bigint;
  nonce: bigint;
  chainId: string;
  maxFee: bigint;
}

export interface SignedTransfer {
  from: string;
  to: string;
  amount: string;
  nonce: string;
  maxFee: string;
  chainId: string;
  /** Transaction id (BLAKE2b-256 of the encoded transaction), hex. */
  hash: string;
  /** Canonical encoded transaction, hex — ready to submit to a node. */
  tx: string;
}

export function signTransfer(options: TransferOptions): SignedTransfer {
  const wallet = Wallet.fromKeystore(readKeystoreFile(options.keystorePath), options.passphrase);
  const tx = wallet.signTransaction({
    chainId: options.chainId,
    nonce: options.nonce,
    maxFee: options.maxFee,
    payload: { kind: 'transfer', to: decodeAddress(options.to), amount: options.amount },
  });
  return {
    from: wallet.address,
    to: options.to,
    amount: options.amount.toString(),
    nonce: options.nonce.toString(),
    maxFee: options.maxFee.toString(),
    chainId: options.chainId,
    hash: toHex(transactionHash(tx)),
    tx: toHex(encodeTransaction(tx)),
  };
}
