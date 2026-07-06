/**
 * Spec Phase 7 milestone: compile a Python-like contract into deployable
 * WASM (hssnc: parse -> typecheck -> Rust -> wasm32) and execute it
 * on-chain. Skipped when the Rust/Python toolchain isn't available (CI).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeAddress, generateSeed, keyPairFromSeed, sign, type KeyPair } from '@hssn/crypto';
import { transactionSigningBytes, type Payload, type Transaction } from '@hssn/protocol';
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
const CHAIN_ID = 'hssn-dsl-e2e';
const alice: KeyPair = keyPairFromSeed(generateSeed());
const val: KeyPair = keyPairFromSeed(generateSeed());
const dirs: string[] = [];
let chain: Chain;
let wasm: Uint8Array;
let land: Uint8Array;

const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return new Uint8Array(b);
};

function stx(nonce: bigint, payload: Payload): Transaction {
  const u = { chainId: CHAIN_ID, nonce, sender: alice.publicKey, maxFee: 500_000n, payload };
  return { ...u, signature: sign(transactionSigningBytes(u), alice.secretKey) };
}

async function run(nonce: bigint, action: string, args: Uint8Array) {
  const r = await chain.produceBlock(
    [stx(nonce, { kind: 'execute_contract', contract: land, value: 0n, action, args })],
    val,
  );
  return r.receipts[0]!;
}

beforeAll(async () => {
  if (!enabled) return;
  const build = mkdtempSync(join(tmpdir(), 'hssn-dsl-'));
  dirs.push(build);
  execFileSync(
    'python3',
    [
      join(repoRoot, 'compiler/hssnc'),
      'build',
      join(repoRoot, 'compiler/examples/land.pysc'),
      '-o',
      build,
      '--wasm',
    ],
    { stdio: 'pipe' },
  );
  wasm = new Uint8Array(readFileSync(join(build, 'land.wasm')));

  const dir = mkdtempSync(join(tmpdir(), 'hssn-dsl-chain-'));
  dirs.push(dir);
  chain = await Chain.open(dir, {
    chainId: CHAIN_ID,
    validators: [encodeAddress(val.publicKey)],
    allocations: [{ address: encodeAddress(alice.publicKey), balance: 10_000_000n }],
  });
  await chain.produceBlock([stx(0n, { kind: 'deploy_contract', code: wasm })], val);
  land = contractIdFor(alice.publicKey, 0n, wasm);
}, 300_000);

afterAll(async () => {
  if (chain) await chain.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!enabled)('DSL-compiled contract on chain (spec Phase 7)', () => {
  it('initializes config exactly once', { timeout: 60_000 }, async () => {
    expect((await run(1n, 'init', u64(100n))).success).toBe(true);
    const again = await run(2n, 'init', u64(100n));
    expect(again.success).toBe(false);
    expect(again.error).toBe('already initialized');
  });

  it('enforces require() semantics from the source', { timeout: 60_000 }, async () => {
    expect((await run(3n, 'claim_tile', u64(5n))).success).toBe(true);
    const dup = await run(4n, 'claim_tile', u64(5n));
    expect(dup.error).toBe('tile is already claimed');
    const off = await run(5n, 'claim_tile', u64(500n));
    expect(off.error).toBe('tile is off the map');
  });

  it('reads builtins: height drives farm harvests', { timeout: 60_000 }, async () => {
    expect((await run(6n, 'build_farm', u64(5n))).success).toBe(true);
    // Two harvests in ONE block: the first collects (height advanced since
    // build_farm), the second sees zero growth and must fail.
    const harvest = (nonce: bigint) =>
      stx(nonce, {
        kind: 'execute_contract',
        contract: land,
        value: 0n,
        action: 'harvest',
        args: u64(5n),
      });
    const { receipts } = await chain.produceBlock([harvest(7n), harvest(8n)], val);
    expect(receipts[0]!.success).toBe(true);
    expect(receipts[1]!.success).toBe(false);
    expect(receipts[1]!.error).toBe('nothing to harvest yet');
  });
});
