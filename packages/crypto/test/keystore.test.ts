import { describe, expect, it } from 'vitest';
import {
  KeystoreError,
  generateMnemonic,
  generateSeed,
  interactiveKdfLimits,
  keyPairFromSeed,
  encodeAddress,
  openSeed,
  sealSeed,
  seedFromMnemonic,
  validateMnemonic,
  type Keystore,
} from '../src/index.js';

// Interactive KDF limits keep argon2id fast enough for CI.
const limits = interactiveKdfLimits();

describe('keystore', () => {
  it('round-trips a seed through seal/open', () => {
    const seed = generateSeed();
    const keystore = sealSeed(seed, 'correct horse battery staple', limits);
    expect(openSeed(keystore, 'correct horse battery staple')).toEqual(seed);
  });

  it('stores the address in the clear', () => {
    const seed = generateSeed();
    const keystore = sealSeed(seed, 'pw', limits);
    expect(keystore.address).toBe(encodeAddress(keyPairFromSeed(seed).publicKey));
  });

  it('rejects a wrong passphrase', () => {
    const keystore = sealSeed(generateSeed(), 'right', limits);
    expect(() => openSeed(keystore, 'wrong')).toThrow(KeystoreError);
  });

  it('rejects tampered ciphertext', () => {
    const keystore = sealSeed(generateSeed(), 'pw', limits);
    const bytes = Buffer.from(keystore.cipher.ciphertext, 'hex');
    bytes[0]! ^= 1;
    const tampered: Keystore = {
      ...keystore,
      cipher: { ...keystore.cipher, ciphertext: bytes.toString('hex') },
    };
    expect(() => openSeed(tampered, 'pw')).toThrow(KeystoreError);
  });

  it('rejects unsupported versions and algorithms', () => {
    const keystore = sealSeed(generateSeed(), 'pw', limits);
    expect(() => openSeed({ ...keystore, version: 2 as 1 }, 'pw')).toThrow(/version/);
    expect(() =>
      openSeed(
        { ...keystore, kdf: { ...keystore.kdf, algorithm: 'scrypt' as 'argon2id13' } },
        'pw',
      ),
    ).toThrow(/kdf/);
  });

  it('survives JSON serialization', () => {
    const seed = generateSeed();
    const keystore = sealSeed(seed, 'pw', limits);
    const revived: Keystore = JSON.parse(JSON.stringify(keystore));
    expect(openSeed(revived, 'pw')).toEqual(seed);
  });
});

describe('mnemonic', () => {
  it('generates a valid 24-word mnemonic', () => {
    const mnemonic = generateMnemonic();
    expect(mnemonic.split(' ')).toHaveLength(24);
    expect(validateMnemonic(mnemonic)).toBe(true);
  });

  it('derives the seed deterministically', () => {
    const mnemonic = generateMnemonic();
    const seed = seedFromMnemonic(mnemonic);
    expect(seed).toHaveLength(32);
    expect(seedFromMnemonic(mnemonic)).toEqual(seed);
  });

  it('different mnemonics give different seeds', () => {
    expect(seedFromMnemonic(generateMnemonic())).not.toEqual(seedFromMnemonic(generateMnemonic()));
  });

  it('matches the BIP39 reference derivation', () => {
    // First 32 bytes of the standard BIP39 seed for the well-known
    // "abandon ... about" test mnemonic (empty passphrase), from the
    // reference test vectors.
    const mnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const seed = seedFromMnemonic(mnemonic);
    expect(Buffer.from(seed).toString('hex')).toBe(
      '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1',
    );
  });

  it('rejects invalid mnemonics', () => {
    expect(validateMnemonic('foo bar baz')).toBe(false);
    expect(() => seedFromMnemonic('foo bar baz')).toThrow(RangeError);
  });
});
