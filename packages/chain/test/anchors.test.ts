/**
 * App-chain anchors on L1 (app-chains spec §2.3/§3.2): quorum math, epoch
 * ordering, signature binding, outcome calls as the app sender, and
 * validator-set rotation. Uses the prebuilt land contract so no Rust
 * toolchain is needed.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeAddress, generateSeed, keyPairFromSeed, sign, type KeyPair } from '@mordecai/crypto';
import {
  anchorSigningBytes,
  transactionSigningBytes,
  type AnchorPayload,
  type AnchorSignature,
  type Payload,
  type Transaction,
} from '@mordecai/protocol';
import { Chain, anchorQuorum, appAddress, contractIdFor } from '../src/index.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const CHAIN_ID = 'mordecai-anchor-test';
const APP = 'com.example.game';

const owner: KeyPair = keyPairFromSeed(generateSeed());
const relayer: KeyPair = keyPairFromSeed(generateSeed());
const validators: KeyPair[] = [0, 1, 2].map(() => keyPairFromSeed(generateSeed()));
const outsider: KeyPair = keyPairFromSeed(generateSeed());
const val: KeyPair = keyPairFromSeed(generateSeed());
const nonces = new Map<KeyPair, bigint>();
let dir: string;
let chain: Chain;
let land: Uint8Array;

const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return new Uint8Array(b);
};

function stx(who: KeyPair, payload: Payload): Transaction {
  const nonce = nonces.get(who) ?? 0n;
  nonces.set(who, nonce + 1n);
  const u = { chainId: CHAIN_ID, nonce, sender: who.publicKey, maxFee: 500_000n, payload };
  return { ...u, signature: sign(transactionSigningBytes(u), who.secretKey) };
}

async function run(who: KeyPair, payload: Payload) {
  const { receipts } = await chain.produceBlock([stx(who, payload)], val);
  return receipts[0]!;
}

type AnchorBody = Omit<AnchorPayload, 'kind' | 'signatures'>;

function attest(body: AnchorBody, signers: KeyPair[], chainId = CHAIN_ID): AnchorSignature[] {
  const message = anchorSigningBytes(chainId, body);
  return signers.map((s) => ({
    validator: s.publicKey,
    signature: sign(message, s.secretKey),
  }));
}

function anchor(body: AnchorBody, signatures: AnchorSignature[]): Payload {
  return { kind: 'anchor', ...body, signatures };
}

const body = (epoch: bigint, overrides: Partial<AnchorBody> = {}): AnchorBody => ({
  appId: APP,
  epoch,
  appHeight: 10n * epoch,
  stateRoot: new Uint8Array(32).fill(Number(epoch)),
  ...overrides,
});

function registerPayload(appId: string, keys: KeyPair[]): Payload {
  return {
    kind: 'register_app',
    appId,
    pearKey: new Uint8Array(32).fill(1),
    version: '1.0.0',
    contractAddress: new Uint8Array(32),
    metadataHash: new Uint8Array(32).fill(2),
    chainValidators: keys.map((k) => k.publicKey),
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mordecai-anchor-'));
  chain = await Chain.open(dir, {
    chainId: CHAIN_ID,
    validators: [encodeAddress(val.publicKey)],
    allocations: [
      { address: encodeAddress(owner.publicKey), balance: 10_000_000n },
      { address: encodeAddress(relayer.publicKey), balance: 10_000_000n },
    ],
  });
  expect((await run(owner, registerPayload(APP, validators))).success).toBe(true);

  const wasm = new Uint8Array(readFileSync(join(repoRoot, 'contracts/dist/land.wasm')));
  const deployNonce = nonces.get(owner)!;
  expect((await run(owner, { kind: 'deploy_contract', code: wasm })).success).toBe(true);
  land = contractIdFor(owner.publicKey, deployNonce, wasm);
  expect(
    (
      await run(owner, {
        kind: 'execute_contract',
        contract: land,
        value: 0n,
        action: 'init',
        args: u64(100n),
      })
    ).success,
  ).toBe(true);
});

afterAll(async () => {
  if (chain) await chain.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('anchor quorum and ordering', () => {
  it('computes the >2/3 threshold', () => {
    expect(anchorQuorum(1)).toBe(1);
    expect(anchorQuorum(2)).toBe(2);
    expect(anchorQuorum(3)).toBe(3);
    expect(anchorQuorum(4)).toBe(3);
  });

  it('accepts a full-quorum anchor and records it', async () => {
    const b = body(1n);
    const receipt = await run(relayer, anchor(b, attest(b, validators)));
    expect(receipt.success).toBe(true);
    expect(receipt.events.map((e) => new TextDecoder().decode(e))).toContain(`anchor:${APP}:1`);
    expect(await chain.getAnchor(APP)).toEqual({
      epoch: 1n,
      appHeight: 10n,
      stateRoot: b.stateRoot,
    });
  });

  it('rejects a sub-quorum anchor (2 of 3)', async () => {
    const b = body(2n);
    const receipt = await run(relayer, anchor(b, attest(b, validators.slice(0, 2))));
    expect(receipt.success).toBe(false);
    expect(receipt.error).toMatch(/quorum not met/);
  });

  it('rejects duplicate-signer padding', async () => {
    const b = body(2n);
    const sigs = attest(b, [validators[0]!, validators[1]!, validators[1]!]);
    const receipt = await run(relayer, anchor(b, sigs));
    expect(receipt.error).toBe('duplicate anchor signer');
  });

  it('rejects signers outside the registered set', async () => {
    const b = body(2n);
    const sigs = attest(b, [validators[0]!, validators[1]!, outsider]);
    const receipt = await run(relayer, anchor(b, sigs));
    expect(receipt.error).toBe('anchor signer is not a registered validator');
  });

  it('rejects stale and replayed epochs, allows skips', async () => {
    const replay = body(1n);
    expect((await run(relayer, anchor(replay, attest(replay, validators)))).error).toMatch(
      /stale anchor epoch/,
    );
    const skip = body(5n);
    expect((await run(relayer, anchor(skip, attest(skip, validators)))).success).toBe(true);
    expect((await chain.getAnchor(APP))!.epoch).toBe(5n);
  });

  it('rejects signatures over a different body or chain', async () => {
    const b = body(6n);
    const wrongEpoch = attest(body(7n), validators);
    expect((await run(relayer, anchor(b, wrongEpoch))).error).toBe('invalid anchor signature');
    const wrongChain = attest(b, validators, 'other-l1');
    expect((await run(relayer, anchor(b, wrongChain))).error).toBe('invalid anchor signature');
  });

  it('rejects anchors for unknown apps', async () => {
    const b = body(1n, { appId: 'com.example.ghost' });
    const receipt = await run(relayer, anchor(b, attest(b, validators)));
    expect(receipt.error).toBe('no such app: com.example.ghost');
  });

  it('rejects anchors for apps with no chain validators', async () => {
    expect((await run(owner, registerPayload('com.example.chainless', []))).success).toBe(true);
    const b = body(1n, { appId: 'com.example.chainless' });
    const receipt = await run(relayer, anchor(b, attest(b, validators)));
    expect(receipt.error).toBe('app has no registered chain validators');
  });
});

describe('anchor outcome calls', () => {
  it('executes the call with the app address as sender', async () => {
    const b = body(6n, {
      call: { contract: land, action: 'claim_tile', args: u64(42n) },
    });
    const receipt = await run(relayer, anchor(b, attest(b, validators)));
    expect(receipt.success).toBe(true);

    // land stores the claimer: Tile[42].owner must be the app address.
    const entries = await chain.getContractState(land);
    const wanted = Buffer.concat([Buffer.from('s:Tile:'), Buffer.from(u64(42n))]);
    const tile = entries.find(([k]) => Buffer.from(k).equals(wanted));
    expect(tile).toBeDefined();
    expect(tile![1].subarray(0, 32)).toEqual(appAddress(APP));
  });

  it('a failed call fails the anchor and does not consume the epoch', async () => {
    const b = body(7n, {
      call: { contract: land, action: 'claim_tile', args: u64(42n) }, // already claimed
    });
    const receipt = await run(relayer, anchor(b, attest(b, validators)));
    expect(receipt.success).toBe(false);
    expect(receipt.error).toBe('anchor outcome call failed: tile is already claimed');
    expect((await chain.getAnchor(APP))!.epoch).toBe(6n);

    // The same epoch can be re-anchored with a corrected call.
    const retry = body(7n, {
      call: { contract: land, action: 'claim_tile', args: u64(43n) },
    });
    expect((await run(relayer, anchor(retry, attest(retry, validators)))).success).toBe(true);
    expect((await chain.getAnchor(APP))!.epoch).toBe(7n);
  });
});

describe('validator rotation', () => {
  const next: KeyPair[] = [0, 1].map(() => keyPairFromSeed(generateSeed()));

  it('update_app swaps the judging set', async () => {
    const update = { ...registerPayload(APP, next), kind: 'update_app' as const };
    expect((await run(owner, update)).success).toBe(true);

    const old = body(8n);
    expect((await run(relayer, anchor(old, attest(old, validators)))).error).toBe(
      'anchor signer is not a registered validator',
    );

    const fresh = body(8n);
    expect((await run(relayer, anchor(fresh, attest(fresh, next)))).success).toBe(true);
    expect((await chain.getAnchor(APP))!.epoch).toBe(8n);
  });
});
