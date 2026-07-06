import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { SEED_SIZE } from './keys.js';

/** 24-word (256-bit entropy) BIP39 mnemonic. */
export function generateMnemonic(): string {
  return bip39.generateMnemonic(wordlist, 256);
}

export function validateMnemonic(mnemonic: string): boolean {
  return bip39.validateMnemonic(mnemonic, wordlist);
}

/**
 * Derive the 32-byte Ed25519 wallet seed from a mnemonic: the first half of
 * the standard 64-byte BIP39 seed. Deterministic — the mnemonic alone fully
 * recovers the wallet.
 */
export function seedFromMnemonic(mnemonic: string): Uint8Array {
  if (!bip39.validateMnemonic(mnemonic, wordlist)) {
    throw new RangeError('invalid mnemonic');
  }
  return bip39.mnemonicToSeedSync(mnemonic).slice(0, SEED_SIZE);
}
