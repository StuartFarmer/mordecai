/**
 * The frontier example (ported from the original CosmWasm mordecai) on-chain:
 * two players claim
 * land, build both building kinds, harvest, and trade through the escrowed
 * order book. Skipped when the Rust/Python toolchain isn't available (CI).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeAddress, generateSeed, keyPairFromSeed, sign, type KeyPair } from '@mordecai/crypto';
import { transactionSigningBytes, type Payload, type Transaction } from '@mordecai/protocol';
import { Chain, contractIdFor } from '../src/index.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

function toolchainAvailable(): boolean {
  try {
    execFileSync('cargo', ['--version'], { stdio: 'ignore' });
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const enabled = toolchainAvailable();
const CHAIN_ID = 'mordecai-frontier-e2e';
const alice: KeyPair = keyPairFromSeed(generateSeed());
const bob: KeyPair = keyPairFromSeed(generateSeed());
const val: KeyPair = keyPairFromSeed(generateSeed());
const nonces = new Map<KeyPair, bigint>();
const dirs: string[] = [];
let chain: Chain;
let frontier: Uint8Array;

const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return new Uint8Array(b);
};
const str = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  const b = Buffer.alloc(4);
  b.writeUInt32LE(bytes.length);
  return new Uint8Array(Buffer.concat([b, bytes]));
};
const cat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));

function stx(who: KeyPair, payload: Payload): Transaction {
  const nonce = nonces.get(who) ?? 0n;
  nonces.set(who, nonce + 1n);
  const u = { chainId: CHAIN_ID, nonce, sender: who.publicKey, maxFee: 500_000n, payload };
  return { ...u, signature: sign(transactionSigningBytes(u), who.secretKey) };
}

async function run(who: KeyPair, action: string, args: Uint8Array) {
  const r = await chain.produceBlock(
    [stx(who, { kind: 'execute_contract', contract: frontier, value: 0n, action, args })],
    val,
  );
  return r.receipts[0]!;
}

/** Decode the codegen's field encoding (u64 LE / u32-len str / 32-byte addr / 1-byte bool). */
function reader(raw: Uint8Array) {
  let o = 0;
  return {
    u64: () => {
      const v = Buffer.from(raw.subarray(o, o + 8)).readBigUInt64LE();
      o += 8;
      return v;
    },
    str: () => {
      const n = Buffer.from(raw.subarray(o, o + 4)).readUInt32LE();
      o += 4;
      const s = new TextDecoder().decode(raw.subarray(o, o + n));
      o += n;
      return s;
    },
    addr: () => {
      const a = raw.subarray(o, o + 32);
      o += 32;
      return encodeAddress(a);
    },
    bool: () => raw[o++] === 1,
  };
}

const stateKey = (map: string, key: Uint8Array) => cat(new TextEncoder().encode(`s:${map}:`), key);

async function readState(map: string, key: Uint8Array): Promise<Uint8Array | undefined> {
  const entries = await chain.getContractState(frontier);
  const wanted = Buffer.from(stateKey(map, key));
  for (const [k, v] of entries) if (Buffer.from(k).equals(wanted)) return v;
  return undefined;
}

async function account(who: KeyPair): Promise<{ wood: bigint; wheat: bigint }> {
  const raw = await readState('Account', who.publicKey);
  if (!raw) return { wood: 0n, wheat: 0n };
  const r = reader(raw);
  return { wood: r.u64(), wheat: r.u64() };
}

beforeAll(async () => {
  if (!enabled) return;
  const build = mkdtempSync(join(tmpdir(), 'mordecai-frontier-'));
  dirs.push(build);
  execFileSync(
    'python3',
    [
      join(repoRoot, 'compiler/mordecaic'),
      'build',
      join(repoRoot, 'compiler/examples/frontier.pysc'),
      '-o',
      build,
      '--wasm',
    ],
    { stdio: 'pipe' },
  );
  const wasm = new Uint8Array(readFileSync(join(build, 'frontier.wasm')));

  const dir = mkdtempSync(join(tmpdir(), 'mordecai-frontier-chain-'));
  dirs.push(dir);
  chain = await Chain.open(dir, {
    chainId: CHAIN_ID,
    validators: [encodeAddress(val.publicKey)],
    allocations: [
      { address: encodeAddress(alice.publicKey), balance: 10_000_000n },
      { address: encodeAddress(bob.publicKey), balance: 10_000_000n },
    ],
  });
  await chain.produceBlock([stx(alice, { kind: 'deploy_contract', code: wasm })], val);
  frontier = contractIdFor(alice.publicKey, 0n, wasm);
  expect((await run(alice, 'init', u64(144n))).success).toBe(true);
}, 300_000);

afterAll(async () => {
  if (chain) await chain.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!enabled)('frontier economy on chain', () => {
  it('claims land and builds both building kinds', { timeout: 60_000 }, async () => {
    expect((await run(alice, 'claim_tile', u64(1n))).success).toBe(true);
    expect((await run(alice, 'claim_tile', u64(2n))).success).toBe(true);
    expect((await run(bob, 'claim_tile', u64(3n))).success).toBe(true);

    expect((await run(alice, 'build', cat(u64(1n), str('farm')))).success).toBe(true);
    expect((await run(alice, 'build', cat(u64(2n), str('lumbermill')))).success).toBe(true);
    const bogus = await run(bob, 'build', cat(u64(3n), str('castle')));
    expect(bogus.error).toBe('unknown building kind');

    // 50 claimed, 20 spent on the two buildings
    expect((await account(alice)).wood).toBe(30n);
  });

  it('harvests by building kind', { timeout: 60_000 }, async () => {
    const before = await account(alice);
    expect((await run(alice, 'harvest', u64(1n))).success).toBe(true); // farm → wheat
    expect((await run(alice, 'harvest', u64(2n))).success).toBe(true); // mill → wood
    const after = await account(alice);
    expect(after.wheat).toBeGreaterThan(before.wheat);
    expect(after.wood).toBeGreaterThan(before.wood);
  });

  it('escrows, fills, and cancels market orders', { timeout: 60_000 }, async () => {
    // grow some wheat for alice to sell
    const wheatBefore = (await account(alice)).wheat;
    expect(wheatBefore).toBeGreaterThan(0n);

    // alice sells wheat for wood; escrow leaves her account immediately
    const sell = (await account(alice)).wheat;
    expect(
      (await run(alice, 'place_order', cat(str('wheat'), u64(sell), str('wood'), u64(5n)))).success,
    ).toBe(true);
    expect((await account(alice)).wheat).toBe(0n);

    // she can't fill her own order; bob can
    expect((await run(alice, 'fill_order', u64(0n))).error).toBe('cannot fill your own order');
    const bobBefore = await account(bob);
    expect(bobBefore.wood).toBeGreaterThanOrEqual(5n);
    expect((await run(bob, 'fill_order', u64(0n))).success).toBe(true);
    const bobAfter = await account(bob);
    expect(bobAfter.wheat - bobBefore.wheat).toBe(sell);
    expect(bobBefore.wood - bobAfter.wood).toBe(5n);
    expect((await account(alice)).wood).toBeGreaterThanOrEqual(5n);

    // filled orders close
    expect((await run(bob, 'fill_order', u64(0n))).error).toBe('order is not open');

    // cancel refunds the escrow
    expect(
      (await run(bob, 'place_order', cat(str('wheat'), u64(1n), str('wood'), u64(1n)))).success,
    ).toBe(true);
    const escrowed = await account(bob);
    expect((await run(bob, 'cancel_order', u64(1n))).success).toBe(true);
    expect((await account(bob)).wheat - escrowed.wheat).toBe(1n);
  });

  it('exposes readable contract state (Order fields decode)', { timeout: 60_000 }, async () => {
    const raw = await readState('Order', u64(0n));
    expect(raw).toBeDefined();
    const r = reader(raw!);
    expect(r.addr()).toBe(encodeAddress(alice.publicKey));
    expect(r.str()).toBe('wheat');
    r.u64(); // give_amount
    expect(r.str()).toBe('wood');
    expect(r.u64()).toBe(5n);
    expect(r.bool()).toBe(false); // filled
  });
});
