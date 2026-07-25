import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import createTestnet from 'hyperdht/testnet';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Chain, Mempool, genesisHash, type Genesis } from '@mordecai/chain';
import { encodeAddress, generateSeed, keyPairFromSeed, sign, type KeyPair } from '@mordecai/crypto';
import { transactionSigningBytes, type Transaction } from '@mordecai/protocol';
import { ConsensusEngine, PeerHub } from '../src/index.js';

const CHAIN_ID = 'mordecai-consensus-test';
const kp = (): KeyPair => keyPairFromSeed(generateSeed());

const alice = kp();
const bob = kp();
const validatorKeys = [kp(), kp(), kp(), kp()];

const genesis: Genesis = {
  chainId: CHAIN_ID,
  validators: validatorKeys.map((v) => encodeAddress(v.publicKey)),
  allocations: [{ address: encodeAddress(alice.publicKey), balance: 10_000_000n }],
};

interface TestNode {
  chain: Chain;
  mempool: Mempool;
  hub: PeerHub;
  engine: ConsensusEngine;
  stop(): Promise<void>;
}

let testnet: Awaited<ReturnType<typeof createTestnet>>;
const dirs: string[] = [];
const nodes: TestNode[] = [];

async function makeNode(keyPair: KeyPair): Promise<TestNode> {
  const dir = mkdtempSync(join(tmpdir(), 'mordecai-consensus-'));
  dirs.push(dir);
  const chain = await Chain.open(dir, genesis);
  const mempool = new Mempool(chain);
  const hub = await PeerHub.create({ topic: genesisHash(genesis), bootstrap: testnet.bootstrap });
  const engine = new ConsensusEngine({
    chain,
    mempool,
    keyPair,
    hub,
    blockTimeMs: 100,
    roundTimeoutMs: 1_500,
  });
  engine.start();
  const node: TestNode = {
    chain,
    mempool,
    hub,
    engine,
    async stop() {
      await engine.stop();
      await hub.close();
      await chain.close();
    },
  };
  nodes.push(node);
  return node;
}

function transfer(nonce: bigint, amount: bigint): Transaction {
  const unsigned = {
    chainId: CHAIN_ID,
    nonce,
    sender: alice.publicKey,
    maxFee: 1_000n,
    payload: { kind: 'transfer' as const, to: bob.publicKey, amount },
  };
  return { ...unsigned, signature: sign(transactionSigningBytes(unsigned), alice.secretKey) };
}

async function waitFor(cond: () => boolean, timeoutMs = 30_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeAll(async () => {
  testnet = await createTestnet(3);
  for (const v of validatorKeys) await makeNode(v);
  // Full mesh: each of the 4 validators sees the other 3.
  await waitFor(() => nodes.every((n) => n.hub.peerCount >= 3), 30_000, 'validator mesh');
}, 60_000);

afterAll(async () => {
  for (const node of nodes) await node.stop().catch(() => {});
  await testnet.destroy();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}, 60_000);

describe('multi-validator consensus (M4 acceptance)', () => {
  it(
    'commits a gossiped transaction on every validator with quorum',
    { timeout: 45_000 },
    async () => {
      const tx = transfer(0n, 100_000n);
      await nodes[0]!.mempool.add(tx);
      nodes[0]!.engine.broadcastTx(tx);

      await waitFor(() => nodes.every((n) => n.chain.height === 1n), 30_000, 'height 1 everywhere');

      const heads = nodes.map((n) => Buffer.from(n.chain.headHash).toString('hex'));
      expect(new Set(heads).size).toBe(1);
      for (const node of nodes) {
        expect((await node.chain.getAccount(bob.publicKey)).balance).toBe(100_000n);
        const cert = await node.chain.getCertificate(1n);
        expect(cert).toBeDefined();
        expect(cert!.length).toBeGreaterThanOrEqual(3); // quorum of 4
      }
    },
  );

  it('keeps committing after the next proposer goes down', { timeout: 45_000 }, async () => {
    // Proposer for (height 2, round 0) is validators[(2 + 0) % 4] = index 2.
    const downIndex = Number((2n + 0n) % 4n);
    const down = nodes[downIndex]!;
    await down.stop();

    const live = nodes.filter((_, i) => i !== downIndex);
    const tx = transfer(1n, 50_000n);
    await live[0]!.mempool.add(tx);
    live[0]!.engine.broadcastTx(tx);

    await waitFor(
      () => live.every((n) => n.chain.height === 2n),
      40_000,
      'height 2 on live validators (round skip)',
    );
    const heads = live.map((n) => Buffer.from(n.chain.headHash).toString('hex'));
    expect(new Set(heads).size).toBe(1);
    for (const node of live) {
      expect((await node.chain.getAccount(bob.publicKey)).balance).toBe(150_000n);
    }
  });

  it(
    'a late joiner syncs from genesis and verifies certificates',
    { timeout: 45_000 },
    async () => {
      const observer = await makeNode(kp()); // not a validator
      await waitFor(() => observer.chain.height === 2n, 30_000, 'observer sync to height 2');

      const reference = nodes[0]!;
      expect(observer.chain.headHash).toEqual(reference.chain.headHash);
      expect(observer.chain.headHeader.stateRoot).toEqual(reference.chain.headHeader.stateRoot);
      expect((await observer.chain.getAccount(bob.publicKey)).balance).toBe(150_000n);
    },
  );
});
