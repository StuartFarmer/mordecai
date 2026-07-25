/**
 * The hex example on-chain: two players create/join a game by id, place
 * stones under full rule enforcement, prove a winning path step by step,
 * forfeit on the `time`-based inactivity deadline, and settle the L1
 * escrow pot. Skipped when the Rust/Python toolchain isn't available (CI).
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
const CHAIN_ID = 'hssn-hex-e2e';
const TIMEOUT_MS = 180_000n;
const alice: KeyPair = keyPairFromSeed(generateSeed()); // creator, side 0 (top↔bottom)
const bob: KeyPair = keyPairFromSeed(generateSeed()); // opponent, side 1 (left↔right)
const game: KeyPair = keyPairFromSeed(generateSeed()); // stands in for appAddress(appId)
const val: KeyPair = keyPairFromSeed(generateSeed());
const nonces = new Map<KeyPair, bigint>();
const dirs: string[] = [];
let chain: Chain;
let hex: Uint8Array;
let escrow: Uint8Array;
let clock = 1_000_000n; // explicit block timestamps drive the forfeit tests

const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return new Uint8Array(b);
};
const addr = (key: Uint8Array) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(32);
  return new Uint8Array(Buffer.concat([b, key]));
};
const cat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts));

function stx(who: KeyPair, payload: Payload): Transaction {
  const nonce = nonces.get(who) ?? 0n;
  nonces.set(who, nonce + 1n);
  const u = { chainId: CHAIN_ID, nonce, sender: who.publicKey, maxFee: 500_000n, payload };
  return { ...u, signature: sign(transactionSigningBytes(u), who.secretKey) };
}

/** Execute one contract action in its own block at the current test clock. */
async function run(
  contract: Uint8Array,
  who: KeyPair,
  action: string,
  args: Uint8Array,
  value = 0n,
) {
  clock += 1_000n;
  const r = await chain.produceBlock(
    [stx(who, { kind: 'execute_contract', contract, value, action, args })],
    val,
    clock,
  );
  return r.receipts[0]!;
}

const play = (who: KeyPair, action: string, args: Uint8Array) => run(hex, who, action, args);

function reader(raw: Uint8Array) {
  let o = 0;
  return {
    u64: () => {
      const v = Buffer.from(raw.subarray(o, o + 8)).readBigUInt64LE();
      o += 8;
      return v;
    },
    addr: () => {
      const a = raw.subarray(o, o + 32);
      o += 32;
      return encodeAddress(a);
    },
    bool: () => raw[o++] === 1,
  };
}

async function readState(
  contract: Uint8Array,
  map: string,
  key: Uint8Array,
): Promise<Uint8Array | undefined> {
  const entries = await chain.getContractState(contract);
  const wanted = Buffer.from(cat(new TextEncoder().encode(`s:${map}:`), key));
  for (const [k, v] of entries) if (Buffer.from(k).equals(wanted)) return v;
  return undefined;
}

async function readGame(id: bigint) {
  const raw = await readState(hex, 'Game', u64(id));
  expect(raw).toBeDefined();
  const r = reader(raw!);
  return {
    creator: r.addr(),
    opponent: r.addr(),
    winner: r.addr(),
    phase: r.u64(),
    turn: r.u64(),
    moves: r.u64(),
    base: r.u64(),
    deadline: r.u64(),
  };
}

function buildContract(name: string): Uint8Array {
  const build = mkdtempSync(join(tmpdir(), `hssn-${name}-`));
  dirs.push(build);
  execFileSync(
    'python3',
    [
      join(repoRoot, 'compiler/hssnc'),
      'build',
      join(repoRoot, `compiler/examples/${name}.pysc`),
      '-o',
      build,
      '--wasm',
    ],
    { stdio: 'pipe' },
  );
  return new Uint8Array(readFileSync(join(build, `${name}.wasm`)));
}

beforeAll(async () => {
  if (!enabled) return;
  const hexWasm = buildContract('hex');
  const escrowWasm = buildContract('hex_escrow');

  const dir = mkdtempSync(join(tmpdir(), 'hssn-hex-chain-'));
  dirs.push(dir);
  chain = await Chain.open(dir, {
    chainId: CHAIN_ID,
    validators: [encodeAddress(val.publicKey)],
    allocations: [
      { address: encodeAddress(alice.publicKey), balance: 10_000_000n },
      { address: encodeAddress(bob.publicKey), balance: 10_000_000n },
      { address: encodeAddress(game.publicKey), balance: 10_000_000n },
    ],
  });

  clock += 1_000n;
  await chain.produceBlock([stx(alice, { kind: 'deploy_contract', code: hexWasm })], val, clock);
  hex = contractIdFor(alice.publicKey, 0n, hexWasm);
  expect((await run(hex, alice, 'init', u64(TIMEOUT_MS))).success).toBe(true);

  clock += 1_000n;
  await chain.produceBlock([stx(bob, { kind: 'deploy_contract', code: escrowWasm })], val, clock);
  escrow = contractIdFor(bob.publicKey, 0n, escrowWasm);
  expect((await run(escrow, bob, 'init', addr(game.publicKey))).success).toBe(true);
}, 300_000);

afterAll(async () => {
  if (chain) await chain.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!enabled)('hex on chain', () => {
  it('creates and joins a game by id', { timeout: 60_000 }, async () => {
    expect((await play(alice, 'create', u64(1n))).success).toBe(true);
    expect((await play(alice, 'create', u64(1n))).error).toBe('game code already taken');
    expect((await play(alice, 'join', u64(1n))).error).toBe('cannot play against yourself');
    expect((await play(bob, 'place', cat(u64(1n), u64(0n), u64(0n)))).error).toBe(
      'game is not active',
    );
    expect((await play(bob, 'join', u64(1n))).success).toBe(true);
    const g = await readGame(1n);
    expect(g.phase).toBe(1n);
    expect(g.deadline).toBe(clock + TIMEOUT_MS);
  });

  it('enforces turn order, bounds, and occupancy', { timeout: 60_000 }, async () => {
    expect((await play(bob, 'place', cat(u64(1n), u64(5n), u64(5n)))).error).toBe('not your turn');
    expect((await play(alice, 'place', cat(u64(1n), u64(11n), u64(0n)))).error).toBe(
      'off the board',
    );
    expect((await play(alice, 'place', cat(u64(1n), u64(5n), u64(5n)))).success).toBe(true);
    expect((await play(bob, 'place', cat(u64(1n), u64(5n), u64(5n)))).error).toBe(
      'cell is occupied',
    );
    expect((await play(bob, 'place', cat(u64(1n), u64(5n), u64(6n)))).success).toBe(true);
  });

  it('proves a winning path step by step', { timeout: 120_000 }, async () => {
    // alice fills column 0 top to bottom (rows 1..10 plus the (5,5) stone
    // already placed); bob idles along row 3.
    let placed = 0n;
    for (let r = 0n; r <= 10n; r++) {
      if (r === 5n) continue; // column cell (5,0)
      expect((await play(alice, 'place', cat(u64(1n), u64(r), u64(0n)))).success).toBe(true);
      expect((await play(bob, 'place', cat(u64(1n), u64(3n), u64(1n + placed)))).success).toBe(
        true,
      );
      placed++;
    }
    expect((await play(alice, 'place', cat(u64(1n), u64(5n), u64(0n)))).success).toBe(true);

    // proof must start on the claimant's own edge, on their own stone
    expect((await play(alice, 'prove_start', cat(u64(1n), u64(5n), u64(0n)))).error).toBe(
      'start on your own edge',
    );
    expect((await play(bob, 'prove_start', cat(u64(1n), u64(3n), u64(1n)))).error).toBe(
      'start on your own edge',
    );
    expect((await play(alice, 'prove_start', cat(u64(1n), u64(0n), u64(0n)))).success).toBe(true);

    // non-adjacent and foreign stones are rejected mid-proof
    expect((await play(alice, 'prove_step', cat(u64(1n), u64(2n), u64(0n)))).error).toBe(
      'not adjacent to the previous proof stone',
    );
    expect((await play(bob, 'prove_step', cat(u64(1n), u64(1n), u64(0n)))).error).toBe(
      'not your proof',
    );

    for (let r = 1n; r <= 10n; r++) {
      expect((await play(alice, 'prove_step', cat(u64(1n), u64(r), u64(0n)))).success).toBe(true);
    }
    const g = await readGame(1n);
    expect(g.phase).toBe(2n);
    expect(g.winner).toBe(encodeAddress(alice.publicKey));
    expect((await play(bob, 'place', cat(u64(1n), u64(9n), u64(9n)))).error).toBe(
      'game is not active',
    );
  });

  it('forfeits the player to move after the inactivity deadline', { timeout: 60_000 }, async () => {
    expect((await play(alice, 'create', u64(2n))).success).toBe(true);
    expect((await play(bob, 'join', u64(2n))).success).toBe(true);
    expect((await play(alice, 'place', cat(u64(2n), u64(0n), u64(0n)))).success).toBe(true);

    // bob is on turn and still inside the window
    expect((await play(bob, 'claim_timeout', u64(2n))).error).toBe(
      'the player to move still has time',
    );

    // jump the chain clock past the deadline: bob forfeits, alice wins
    clock += TIMEOUT_MS;
    expect((await play(alice, 'claim_timeout', u64(2n))).success).toBe(true);
    const g = await readGame(2n);
    expect(g.phase).toBe(2n);
    expect(g.winner).toBe(encodeAddress(alice.publicKey));
  });

  it('escrows both stakes and pays the winner on settle', { timeout: 60_000 }, async () => {
    const stake = 1_000n;
    const before = {
      alice: (await chain.getAccount(alice.publicKey)).balance,
      bob: (await chain.getAccount(bob.publicKey)).balance,
    };

    expect((await run(escrow, alice, 'create', u64(1n), stake)).success).toBe(true);
    expect((await run(escrow, bob, 'join', u64(1n), stake + 1n)).error).toBe(
      "attached value must match the creator's stake",
    );
    expect((await run(escrow, bob, 'join', u64(1n), stake)).success).toBe(true);
    expect((await run(escrow, alice, 'cancel', u64(1n))).error).toBe('pot already funded');

    // only the configured game address may settle, and only to a player
    expect((await run(escrow, alice, 'settle', cat(u64(1n), addr(alice.publicKey)))).error).toBe(
      'only the game may settle',
    );
    expect((await run(escrow, game, 'settle', cat(u64(1n), addr(val.publicKey)))).error).toBe(
      'winner must be one of the players',
    );
    expect((await run(escrow, game, 'settle', cat(u64(1n), addr(alice.publicKey)))).success).toBe(
      true,
    );
    expect((await run(escrow, game, 'settle', cat(u64(1n), addr(alice.publicKey)))).error).toBe(
      'pot is not active',
    );

    const after = {
      alice: (await chain.getAccount(alice.publicKey)).balance,
      bob: (await chain.getAccount(bob.publicKey)).balance,
    };
    // winner nets +stake, loser −stake (modulo fees, which are ≤ a few hundred)
    const fees = 10_000n;
    expect(after.alice - before.alice).toBeGreaterThan(stake - fees);
    expect(before.bob - after.bob).toBeGreaterThan(stake - fees);

    // an unfunded pot refunds via cancel
    expect((await run(escrow, alice, 'create', u64(2n), stake)).success).toBe(true);
    expect((await run(escrow, alice, 'cancel', u64(2n))).success).toBe(true);
  });
});
