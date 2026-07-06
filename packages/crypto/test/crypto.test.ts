import { describe, expect, it } from 'vitest';
import {
  blake2b256,
  decodeAddress,
  encodeAddress,
  generateSeed,
  isValidAddress,
  keyPairFromSeed,
  randomBytes,
  sign,
  verify,
} from '../src/index.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const fromHex = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));

describe('blake2b256', () => {
  // Cross-checked against Python hashlib.blake2b(digest_size=32).
  it('matches known vectors', () => {
    expect(hex(blake2b256(new Uint8Array(0)))).toBe(
      '0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8',
    );
    expect(hex(blake2b256(new TextEncoder().encode('abc')))).toBe(
      'bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319',
    );
  });

  it('concatenates multiple inputs', () => {
    const a = new TextEncoder().encode('hello ');
    const b = new TextEncoder().encode('world');
    expect(hex(blake2b256(a, b))).toBe(
      '256c83b297114d201b30179f3f0ef0cace9783622da5974326b436178aeef610',
    );
  });
});

describe('ed25519 keys', () => {
  // RFC 8032 §7.1 test vector 1.
  const rfcSeed = fromHex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');

  it('derives the RFC 8032 public key from a seed', () => {
    const kp = keyPairFromSeed(rfcSeed);
    expect(hex(kp.publicKey)).toBe(
      'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    );
  });

  it('produces the RFC 8032 signature for the empty message', () => {
    const kp = keyPairFromSeed(rfcSeed);
    const sig = sign(new Uint8Array(0), kp.secretKey);
    expect(hex(sig)).toBe(
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    );
    expect(verify(sig, new Uint8Array(0), kp.publicKey)).toBe(true);
  });

  it('is deterministic from the seed', () => {
    const seed = generateSeed();
    expect(keyPairFromSeed(seed)).toEqual(keyPairFromSeed(seed));
  });

  it('rejects tampered messages and foreign keys', () => {
    const kp = keyPairFromSeed(generateSeed());
    const other = keyPairFromSeed(generateSeed());
    const msg = new TextEncoder().encode('pay 100 to bob');
    const sig = sign(msg, kp.secretKey);
    expect(verify(sig, msg, kp.publicKey)).toBe(true);
    const tampered = new TextEncoder().encode('pay 900 to bob');
    expect(verify(sig, tampered, kp.publicKey)).toBe(false);
    expect(verify(sig, msg, other.publicKey)).toBe(false);
    const badSig = sig.slice();
    badSig[0]! ^= 1;
    expect(verify(badSig, msg, kp.publicKey)).toBe(false);
  });

  it('rejects wrong-size seeds', () => {
    expect(() => keyPairFromSeed(new Uint8Array(31))).toThrow(RangeError);
  });
});

describe('addresses', () => {
  it('round-trips a public key', () => {
    const kp = keyPairFromSeed(generateSeed());
    const address = encodeAddress(kp.publicKey);
    expect(decodeAddress(address)).toEqual(kp.publicKey);
    expect(isValidAddress(address)).toBe(true);
  });

  it('rejects malformed addresses', () => {
    expect(isValidAddress('not-an-address!')).toBe(false);
    expect(isValidAddress('abc')).toBe(false);
    expect(() => decodeAddress('abc')).toThrow(RangeError);
  });

  it('rejects wrong-size public keys', () => {
    expect(() => encodeAddress(randomBytes(31))).toThrow(RangeError);
  });
});
