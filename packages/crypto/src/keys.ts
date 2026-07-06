import sodium from 'sodium-native';

export const SEED_SIZE = 32;
export const PUBKEY_SIZE = 32;
export const SECRET_KEY_SIZE = 64;
export const SIGNATURE_SIZE = 64;

export interface KeyPair {
  publicKey: Uint8Array;
  /** libsodium Ed25519 secret key (seed ‖ public key, 64 bytes). */
  secretKey: Uint8Array;
}

export function randomBytes(size: number): Uint8Array {
  const buf = new Uint8Array(size);
  sodium.randombytes_buf(buf);
  return buf;
}

export function generateSeed(): Uint8Array {
  return randomBytes(SEED_SIZE);
}

export function keyPairFromSeed(seed: Uint8Array): KeyPair {
  if (seed.length !== SEED_SIZE) {
    throw new RangeError(`seed must be ${SEED_SIZE} bytes, got ${seed.length}`);
  }
  const publicKey = new Uint8Array(PUBKEY_SIZE);
  const secretKey = new Uint8Array(SECRET_KEY_SIZE);
  sodium.crypto_sign_seed_keypair(publicKey, secretKey, seed);
  return { publicKey, secretKey };
}

export function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array {
  if (secretKey.length !== SECRET_KEY_SIZE) {
    throw new RangeError(`secret key must be ${SECRET_KEY_SIZE} bytes`);
  }
  const signature = new Uint8Array(SIGNATURE_SIZE);
  sodium.crypto_sign_detached(signature, message, secretKey);
  return signature;
}

export function verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.length !== SIGNATURE_SIZE || publicKey.length !== PUBKEY_SIZE) return false;
  return sodium.crypto_sign_verify_detached(signature, message, publicKey);
}

/** Best-effort scrubbing of secret material. */
export function memzero(buffer: Uint8Array): void {
  sodium.sodium_memzero(buffer);
}
