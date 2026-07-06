/**
 * Spec Phase 8, chess (the §15 exemplar): the match plays entirely over
 * Hypercore feeds; only the wager (escrow, settlement) touches the chain,
 * through the ChessWager contract written in the Pythonic DSL
 * (compiler/examples/chess_wager.pysc; artifact rebuilt by
 * scripts/build-wasm.sh).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import createTestnet from 'hyperdht/testnet';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Genesis } from '@hssn/chain';
import { encodeAddress, generateSeed, keyPairFromSeed } from '@hssn/crypto';
import { Node } from '@hssn/node';
import { Hssn } from '@hssn/sdk';
import { Wallet } from '@hssn/wallet';
import { ChessMatch, WagerClient } from '../src/index.js';

const wagerWasm = new Uint8Array(
  readFileSync(fileURLToPath(new URL('../../../contracts/dist/chess_wager.wasm', import.meta.url))),
);
const CHAIN_ID = 'hssn-chess-1';
const STAKE = 100_000n;
const validators = [0, 1].map(() => keyPairFromSeed(generateSeed()));
const { wallet: aliceWallet } = Wallet.create();
const { wallet: bobWallet } = Wallet.create();

let testnet: Awaited<ReturnType<typeof createTestnet>>;
const dirs: string[] = [];
const nodes: Node[] = [];
let alice: Hssn;
let bob: Hssn;
let contract: Uint8Array;

const tmp = (tag: string) => {
  const dir = mkdtempSync(join(tmpdir(), `hssn-chess-${tag}-`));
  dirs.push(dir);
  return dir;
};

beforeAll(async () => {
  testnet = await createTestnet(3);
  const genesis: Genesis = {
    chainId: CHAIN_ID,
    validators: validators.map((v) => encodeAddress(v.publicKey)),
    allocations: [
      { address: aliceWallet.address, balance: 10_000_000n },
      { address: bobWallet.address, balance: 10_000_000n },
    ],
  };
  for (const keyPair of validators) {
    nodes.push(
      await Node.start({
        dir: tmp('node'),
        genesis,
        keyPair,
        blockIntervalMs: 100,
        bootstrap: testnet.bootstrap,
      }),
    );
  }
  alice = Hssn.connect({
    wallet: aliceWallet,
    nodeKey: nodes[0]!.rpcPublicKey,
    storageDir: tmp('alice'),
    chainId: CHAIN_ID,
    bootstrap: testnet.bootstrap,
  });
  bob = Hssn.connect({
    wallet: bobWallet,
    nodeKey: nodes[1]!.rpcPublicKey,
    storageDir: tmp('bob'),
    chainId: CHAIN_ID,
    bootstrap: testnet.bootstrap,
  });
  ({ contractId: contract } = await alice.deploy(wagerWasm));
}, 300_000);

afterAll(async () => {
  await alice.close();
  await bob.close();
  for (const node of nodes) await node.stop().catch(() => {});
  await testnet.destroy();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}, 90_000);

describe('p2p chess with an on-chain wager (spec Phase 8)', () => {
  it('plays a wagered match end to end', { timeout: 120_000 }, async () => {
    const aliceWager = new WagerClient(alice, contract);
    const bobWager = new WagerClient(bob, contract);

    // --- escrow: two transactions, one per player ---
    const created = await aliceWager.create(STAKE);
    expect(created.success).toBe(true);
    expect(created.events.map((e) => Buffer.from(e, 'hex').toString())).toContain('match created');
    const matchId = 0n;

    const wrongStake = await bobWager.join(matchId, STAKE - 1n);
    expect(wrongStake.success).toBe(false);
    expect(wrongStake.error).toBe('attached value must match the stake');

    const joined = await bobWager.join(matchId, STAKE);
    expect(joined.success).toBe(true);

    // Escrow now holds both stakes; cancellation is off the table.
    expect(BigInt((await alice.account(encodeAddress(contract))).balance)).toBe(2n * STAKE);
    const lateCancel = await aliceWager.cancel(matchId);
    expect(lateCancel.success).toBe(false);
    expect(lateCancel.error).toBe('match already started');

    // --- the game itself: pure p2p, zero transactions ---
    const hosted = await ChessMatch.host(alice, 'match-0');
    const black = await ChessMatch.join(bob, 'match-0', hosted.feedKey);
    const white = await hosted.acceptOpponent(alice, black.feedKey);

    await white.move('e4');
    expect(await black.waitForOpponent()).toBe('e4');
    await black.move('e5');
    expect(await white.waitForOpponent()).toBe('e5');
    await white.move('Nf3');
    expect(await black.waitForOpponent()).toBe('Nf3');
    expect(await black.moves()).toEqual(['e4', 'e5', 'Nf3']);
    await expect(white.move('d4')).rejects.toThrow(/not your turn/); // black to move

    // --- settlement: both report the same winner, pot pays out ---
    const aliceBefore = BigInt((await alice.account()).balance);
    const r1 = await aliceWager.report(matchId, alice.address);
    expect(r1.success).toBe(true);
    const r2 = await bobWager.report(matchId, alice.address);
    expect(r2.success).toBe(true);
    expect(r2.events.map((e) => Buffer.from(e, 'hex').toString())).toContain('match settled');

    const aliceAfter = BigInt((await alice.account()).balance);
    expect(aliceAfter).toBe(aliceBefore + 2n * STAKE - BigInt(r1.fee));
    expect(BigInt((await alice.account(encodeAddress(contract))).balance)).toBe(0n);

    // A second settlement attempt is rejected.
    const again = await bobWager.report(matchId, bob.address);
    expect(again.success).toBe(false);
    expect(again.error).toBe('match is not active');
  });
});
