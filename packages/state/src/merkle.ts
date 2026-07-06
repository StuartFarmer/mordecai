import { blake2b256 } from '@hssn/crypto';

export const EMPTY_ROOT = new Uint8Array(32);

const LEAF_PREFIX = Uint8Array.of(0x00);
const NODE_PREFIX = Uint8Array.of(0x01);

/**
 * Leaf hash over a key/value entry. Length-prefixed and domain-separated
 * from interior nodes so no entry can collide with a computed node.
 */
export function leafHash(key: Uint8Array, value: Uint8Array): Uint8Array {
  const keyLen = new Uint8Array(4);
  new DataView(keyLen.buffer).setUint32(0, key.length, true);
  return blake2b256(LEAF_PREFIX, keyLen, key, value);
}

/**
 * Binary Merkle root: pairs combine as H(0x01 ‖ left ‖ right); an odd node
 * is promoted unchanged. Empty input commits to 32 zero bytes.
 */
export function merkleRoot(leaves: readonly Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return EMPTY_ROOT.slice();
  let level = [...leaves];
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i + 1 < level.length; i += 2) {
      next.push(blake2b256(NODE_PREFIX, level[i]!, level[i + 1]!));
    }
    if (level.length % 2 === 1) next.push(level[level.length - 1]!);
    level = next;
  }
  return level[0]!;
}
