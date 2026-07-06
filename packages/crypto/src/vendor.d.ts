declare module 'sodium-native' {
  interface SodiumNative {
    crypto_sign_PUBLICKEYBYTES: number;
    crypto_sign_SECRETKEYBYTES: number;
    crypto_sign_SEEDBYTES: number;
    crypto_sign_BYTES: number;
    crypto_sign_keypair(publicKey: Uint8Array, secretKey: Uint8Array): void;
    crypto_sign_seed_keypair(publicKey: Uint8Array, secretKey: Uint8Array, seed: Uint8Array): void;
    crypto_sign_detached(signature: Uint8Array, message: Uint8Array, secretKey: Uint8Array): void;
    crypto_sign_verify_detached(
      signature: Uint8Array,
      message: Uint8Array,
      publicKey: Uint8Array,
    ): boolean;

    crypto_generichash_BYTES: number;
    crypto_generichash(output: Uint8Array, input: Uint8Array, key?: Uint8Array): void;
    crypto_generichash_batch(output: Uint8Array, inputs: Uint8Array[], key?: Uint8Array): void;

    randombytes_buf(buffer: Uint8Array): void;
    sodium_memzero(buffer: Uint8Array): void;

    crypto_pwhash_SALTBYTES: number;
    crypto_pwhash_ALG_ARGON2ID13: number;
    crypto_pwhash_OPSLIMIT_INTERACTIVE: number;
    crypto_pwhash_MEMLIMIT_INTERACTIVE: number;
    crypto_pwhash_OPSLIMIT_MODERATE: number;
    crypto_pwhash_MEMLIMIT_MODERATE: number;
    crypto_pwhash(
      output: Uint8Array,
      password: Uint8Array,
      salt: Uint8Array,
      opslimit: number,
      memlimit: number,
      algorithm: number,
    ): void;

    crypto_aead_xchacha20poly1305_ietf_KEYBYTES: number;
    crypto_aead_xchacha20poly1305_ietf_NPUBBYTES: number;
    crypto_aead_xchacha20poly1305_ietf_ABYTES: number;
    crypto_aead_xchacha20poly1305_ietf_encrypt(
      ciphertext: Uint8Array,
      message: Uint8Array,
      additionalData: Uint8Array | null,
      secretNonce: Uint8Array | null,
      publicNonce: Uint8Array,
      key: Uint8Array,
    ): number;
    crypto_aead_xchacha20poly1305_ietf_decrypt(
      message: Uint8Array,
      secretNonce: Uint8Array | null,
      ciphertext: Uint8Array,
      additionalData: Uint8Array | null,
      publicNonce: Uint8Array,
      key: Uint8Array,
    ): number;
  }
  const sodium: SodiumNative;
  export = sodium;
}

declare module 'z32' {
  const z32: {
    encode(buffer: Uint8Array): string;
    decode(value: string, output?: Uint8Array): Uint8Array;
  };
  export = z32;
}
