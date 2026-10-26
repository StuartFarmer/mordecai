import { ed25519 } from '@noble/curves/ed25519';
import { blake2b } from '@noble/hashes/blake2b';
import z32 from 'z32';
import { encodeTransaction, transactionSigningBytes, type Transaction } from '@mordecai/protocol';
import type { SignParams } from './wallet.js';

export interface BrowserWallet {
  seed: Uint8Array;
  publicKey: Uint8Array;
  address: string;
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function fromSeed(seed: Uint8Array): BrowserWallet {
  const publicKey = ed25519.getPublicKey(seed);
  return { seed, publicKey, address: z32.encode(publicKey) };
}

export function createBrowserWallet(): BrowserWallet {
  return fromSeed(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

/** Accept a seed, libsodium secret key, or our explicitly unencrypted test backup. */
export function loadBrowserWallet(input: string): BrowserWallet {
  if (input.length > 4096) throw new Error('Account file is too large.');
  let key = input.trim();
  let expectedAddress: string | undefined;
  if (key.startsWith('{')) {
    const data = JSON.parse(key) as Record<string, unknown>;
    if (
      data.format !== 'mordecai-test-wallet' ||
      data.version !== 1 ||
      typeof data.privateKey !== 'string' ||
      typeof data.address !== 'string'
    ) {
      throw new Error(
        'Unsupported account format. Use an account backup or a hexadecimal private key.',
      );
    }
    key = data.privateKey;
    expectedAddress = data.address;
  }
  if (!/^(?:[a-f\d]{64}|[a-f\d]{128})$/i.test(key))
    throw new Error('Private key must be 64 or 128 hexadecimal characters.');
  const bytes = Uint8Array.from(key.match(/../g)!, (b) => parseInt(b, 16));
  const wallet = fromSeed(bytes.slice(0, 32));
  if (bytes.length === 64 && hex(bytes.slice(32)) !== hex(wallet.publicKey))
    throw new Error('Private key has an inconsistent public key.');
  if (expectedAddress !== undefined && wallet.address !== expectedAddress)
    throw new Error('Account address does not match the private key.');
  return wallet;
}

export function exportBrowserWallet(wallet: BrowserWallet): string {
  return (
    JSON.stringify(
      {
        format: 'mordecai-test-wallet',
        version: 1,
        address: wallet.address,
        privateKey: hex(wallet.seed),
      },
      null,
      2,
    ) + '\n'
  );
}

export function signBrowserTransaction(wallet: BrowserWallet, params: SignParams): Transaction {
  const unsigned = { ...params, sender: wallet.publicKey };
  return { ...unsigned, signature: ed25519.sign(transactionSigningBytes(unsigned), wallet.seed) };
}

export function decodeBrowserAddress(address: string): Uint8Array {
  try {
    if (address.length !== 52) throw new Error();
    const bytes = new Uint8Array(z32.decode(address));
    if (bytes.length !== 32 || z32.encode(bytes) !== address) throw new Error();
    return bytes;
  } catch {
    throw new Error('Enter a valid account address.');
  }
}

export function browserAddress(publicKey: Uint8Array): string {
  return z32.encode(publicKey);
}

export function browserTransactionHash(tx: Transaction): string {
  return hex(blake2b(encodeTransaction(tx), { dkLen: 32 }));
}

export function verifyBrowserTransaction(tx: Transaction): boolean {
  try {
    return ed25519.verify(tx.signature, transactionSigningBytes(tx), tx.sender, { zip215: false });
  } catch {
    return false;
  }
}

function registrationBytes(chainId: string, publicKey: string): Uint8Array {
  if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(chainId)) throw new Error('Invalid network');
  return new TextEncoder().encode(
    JSON.stringify(['mordecai/account-registration/v1', chainId, publicKey]),
  );
}

export function signAccountRegistration(wallet: BrowserWallet, chainId: string) {
  const publicKey = hex(wallet.publicKey);
  return {
    chainId,
    publicKey,
    signature: hex(ed25519.sign(registrationBytes(chainId, publicKey), wallet.seed)),
  };
}

export function verifyAccountRegistration(input: unknown, chainId: string): string {
  const proof = input as ReturnType<typeof signAccountRegistration>;
  if (
    !proof ||
    Object.keys(proof).sort().join() !== 'chainId,publicKey,signature' ||
    proof.chainId !== chainId ||
    typeof proof.publicKey !== 'string' ||
    !/^[a-f0-9]{64}$/.test(proof.publicKey) ||
    typeof proof.signature !== 'string' ||
    !/^[a-f0-9]{128}$/.test(proof.signature)
  )
    throw new Error('Invalid account registration proof');
  const bytes = (value: string) => Uint8Array.from(value.match(/../g)!, (b) => parseInt(b, 16));
  if (
    !ed25519.verify(
      bytes(proof.signature),
      registrationBytes(chainId, proof.publicKey),
      bytes(proof.publicKey),
      { zip215: false },
    )
  )
    throw new Error('Invalid account registration signature');
  return browserAddress(bytes(proof.publicKey));
}
