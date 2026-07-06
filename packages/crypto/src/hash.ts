import sodium from 'sodium-native';

export const HASH_SIZE = 32;

/** BLAKE2b-256 over the concatenation of the inputs. */
export function blake2b256(...inputs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(HASH_SIZE);
  if (inputs.length === 1) {
    sodium.crypto_generichash(out, inputs[0]!);
  } else {
    sodium.crypto_generichash_batch(out, [...inputs]);
  }
  return out;
}
