import z32 from 'z32';
import { PUBKEY_SIZE } from './keys.js';

/** Wallet addresses are z32-encoded Ed25519 public keys (the encoding hyperdht/Pear use). */
export function encodeAddress(publicKey: Uint8Array): string {
  if (publicKey.length !== PUBKEY_SIZE) {
    throw new RangeError(`public key must be ${PUBKEY_SIZE} bytes, got ${publicKey.length}`);
  }
  return z32.encode(publicKey);
}

export function decodeAddress(address: string): Uint8Array {
  let decoded: Uint8Array;
  try {
    decoded = z32.decode(address);
  } catch {
    throw new RangeError(`invalid address: ${address}`);
  }
  if (decoded.length !== PUBKEY_SIZE) {
    throw new RangeError(`invalid address length: ${address}`);
  }
  return new Uint8Array(decoded);
}

export function isValidAddress(address: string): boolean {
  try {
    decodeAddress(address);
    return true;
  } catch {
    return false;
  }
}
