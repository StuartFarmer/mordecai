import sodium from 'sodium-native';
import { encodeAddress } from './address.js';
import { SEED_SIZE, keyPairFromSeed, memzero, randomBytes } from './keys.js';

export class KeystoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeystoreError';
  }
}

/**
 * Encrypted-at-rest wallet seed. The address is stored in the clear so tools
 * can display it without the passphrase; only the seed is secret.
 */
export interface Keystore {
  version: 1;
  address: string;
  kdf: {
    algorithm: 'argon2id13';
    salt: string;
    opslimit: number;
    memlimit: number;
  };
  cipher: {
    algorithm: 'xchacha20poly1305-ietf';
    nonce: string;
    ciphertext: string;
  };
}

export interface KdfLimits {
  opslimit: number;
  memlimit: number;
}

/** Fast parameters for tests only — never use for real keystores. */
export function interactiveKdfLimits(): KdfLimits {
  return {
    opslimit: sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    memlimit: sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
  };
}

function deriveKey(passphrase: string, salt: Uint8Array, limits: KdfLimits): Uint8Array {
  const key = new Uint8Array(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
  sodium.crypto_pwhash(
    key,
    new TextEncoder().encode(passphrase),
    salt,
    limits.opslimit,
    limits.memlimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
  return key;
}

const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const fromHex = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));

export function sealSeed(seed: Uint8Array, passphrase: string, limits?: KdfLimits): Keystore {
  if (seed.length !== SEED_SIZE) {
    throw new RangeError(`seed must be ${SEED_SIZE} bytes, got ${seed.length}`);
  }
  const kdfLimits = limits ?? {
    opslimit: sodium.crypto_pwhash_OPSLIMIT_MODERATE,
    memlimit: sodium.crypto_pwhash_MEMLIMIT_MODERATE,
  };
  const salt = randomBytes(sodium.crypto_pwhash_SALTBYTES);
  const nonce = randomBytes(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
  const key = deriveKey(passphrase, salt, kdfLimits);
  const ciphertext = new Uint8Array(seed.length + sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES);
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(ciphertext, seed, null, null, nonce, key);
  memzero(key);
  return {
    version: 1,
    address: encodeAddress(keyPairFromSeed(seed).publicKey),
    kdf: {
      algorithm: 'argon2id13',
      salt: toHex(salt),
      opslimit: kdfLimits.opslimit,
      memlimit: kdfLimits.memlimit,
    },
    cipher: {
      algorithm: 'xchacha20poly1305-ietf',
      nonce: toHex(nonce),
      ciphertext: toHex(ciphertext),
    },
  };
}

export function openSeed(keystore: Keystore, passphrase: string): Uint8Array {
  if (keystore.version !== 1) {
    throw new KeystoreError(`unsupported keystore version: ${keystore.version}`);
  }
  if (keystore.kdf.algorithm !== 'argon2id13') {
    throw new KeystoreError(`unsupported kdf: ${keystore.kdf.algorithm}`);
  }
  if (keystore.cipher.algorithm !== 'xchacha20poly1305-ietf') {
    throw new KeystoreError(`unsupported cipher: ${keystore.cipher.algorithm}`);
  }
  const key = deriveKey(passphrase, fromHex(keystore.kdf.salt), keystore.kdf);
  const ciphertext = fromHex(keystore.cipher.ciphertext);
  const seed = new Uint8Array(ciphertext.length - sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES);
  try {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      seed,
      null,
      ciphertext,
      null,
      fromHex(keystore.cipher.nonce),
      key,
    );
  } catch {
    throw new KeystoreError('wrong passphrase or corrupted keystore');
  } finally {
    memzero(key);
  }
  return seed;
}
