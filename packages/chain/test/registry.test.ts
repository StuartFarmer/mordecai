import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  blake2b256,
  encodeAddress,
  generateSeed,
  keyPairFromSeed,
  sign,
  type KeyPair,
} from '@mordecai/crypto';
import { transactionSigningBytes, type Payload, type Transaction } from '@mordecai/protocol';
import { Chain, type Genesis } from '../src/index.js';

const CHAIN_ID = 'mordecai-registry-test';
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const kp = (): KeyPair => keyPairFromSeed(generateSeed());
const dev = kp();
const other = kp();
const val = kp();

async function openChain(): Promise<Chain> {
  const dir = mkdtempSync(join(tmpdir(), 'mordecai-registry-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const genesis: Genesis = {
    chainId: CHAIN_ID,
    validators: [encodeAddress(val.publicKey)],
    allocations: [
      { address: encodeAddress(dev.publicKey), balance: 1_000_000n },
      { address: encodeAddress(other.publicKey), balance: 1_000_000n },
    ],
  };
  const chain = await Chain.open(dir, genesis);
  cleanups.push(() => chain.close());
  return chain;
}

function signedTx(sender: KeyPair, nonce: bigint, payload: Payload): Transaction {
  const unsigned = { chainId: CHAIN_ID, nonce, sender: sender.publicKey, maxFee: 1_000n, payload };
  return { ...unsigned, signature: sign(transactionSigningBytes(unsigned), sender.secretKey) };
}

const pearKey = new Uint8Array(32).fill(0x11);
const bundleHash = blake2b256(new TextEncoder().encode('the-bundle'));

function registerApp(sender: KeyPair, nonce: bigint, version = '1.0.0'): Transaction {
  return signedTx(sender, nonce, {
    kind: 'register_app',
    appId: 'com.example.demo',
    pearKey,
    version,
    contractAddress: new Uint8Array(32),
    metadataHash: bundleHash,
    chainValidators: [],
  });
}

describe('application registry (M6)', () => {
  it('registers an app and serves the entry', async () => {
    const chain = await openChain();
    const { receipts } = await chain.produceBlock([registerApp(dev, 0n)], val, 1_000n);
    expect(receipts[0]!.success).toBe(true);
    expect(new TextDecoder().decode(receipts[0]!.events[0])).toBe(
      'app:registered:com.example.demo',
    );

    const entry = await chain.getApp('com.example.demo');
    expect(entry).toBeDefined();
    expect(entry!.owner).toEqual(dev.publicKey);
    expect(entry!.pearKey).toEqual(pearKey);
    expect(entry!.version).toBe('1.0.0');
    expect(entry!.metadataHash).toEqual(bundleHash);
    expect(await chain.getApp('nope')).toBeUndefined();
  });

  it('rejects duplicate registration and foreign updates', async () => {
    const chain = await openChain();
    await chain.produceBlock([registerApp(dev, 0n)], val, 1_000n);

    const dup = await chain.produceBlock([registerApp(other, 0n)], val, 2_000n);
    expect(dup.receipts[0]!.success).toBe(false);
    expect(dup.receipts[0]!.error).toMatch(/already registered/);

    const foreign = signedTx(other, 1n, {
      kind: 'update_app',
      appId: 'com.example.demo',
      pearKey,
      version: '9.9.9',
      contractAddress: new Uint8Array(32),
      metadataHash: bundleHash,
      chainValidators: [],
    });
    const r = await chain.produceBlock([foreign], val, 3_000n);
    expect(r.receipts[0]!.success).toBe(false);
    expect(r.receipts[0]!.error).toMatch(/registering key/);
    expect((await chain.getApp('com.example.demo'))!.version).toBe('1.0.0');
  });

  it('lets the owner publish a new version', async () => {
    const chain = await openChain();
    await chain.produceBlock([registerApp(dev, 0n)], val, 1_000n);
    const update = signedTx(dev, 1n, {
      kind: 'update_app',
      appId: 'com.example.demo',
      pearKey,
      version: '1.1.0',
      contractAddress: new Uint8Array(32),
      metadataHash: blake2b256(new TextEncoder().encode('bundle-v2')),
      chainValidators: [],
    });
    const r = await chain.produceBlock([update], val, 2_000n);
    expect(r.receipts[0]!.success).toBe(true);
    expect((await chain.getApp('com.example.demo'))!.version).toBe('1.1.0');
  });
});
