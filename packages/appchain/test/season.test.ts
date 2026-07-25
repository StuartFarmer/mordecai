/**
 * The app-chains acceptance vertical (spec §3.5): stake on L1, play the
 * season on the app's own chain, settle the pot through an anchored
 * outcome call. The whole feature in one flow.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import createTestnet from 'hyperdht/testnet';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeAddress, generateSeed, keyPairFromSeed, sign, type KeyPair } from '@hssn/crypto';
import { appAddress, contractIdFor } from '@hssn/chain';
import {
  encodeTransaction,
  transactionSigningBytes,
  type Payload,
  type Transaction,
} from '@hssn/protocol';
import { Node } from '@hssn/node';
import { NodeRpcClient } from '@hssn/rpc';
import { AnchorDaemon, AppChain } from '../src/index.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const L1_CHAIN = 'hssn-season-test';
const APP = 'com.example.mmo-season-1';
const STAKE = 50_000n;

const owner: KeyPair = keyPairFromSeed(generateSeed());
const relayer: KeyPair = keyPairFromSeed(generateSeed());
const alice: KeyPair = keyPairFromSeed(generateSeed());
const bob: KeyPair = keyPairFromSeed(generateSeed());
const l1Validator: KeyPair = keyPairFromSeed(generateSeed());

let testnet: Awaited<ReturnType<typeof createTestnet>>;
let l1: Node;
let l1Rpc: NodeRpcClient;
let chainA: AppChain;
let chainB: AppChain;
let daemon: AnchorDaemon;
let pool: Uint8Array; // season pool contract on L1
let frontier: Uint8Array; // frontier contract on the app chain
const dirs: string[] = [];
const l1Nonces = new Map<KeyPair, bigint>();
const appNonces = new Map<KeyPair, bigint>();

const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return new Uint8Array(b);
};
const addr = (key: Uint8Array) => {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(32);
  return new Uint8Array(Buffer.concat([len, Buffer.from(key)]));
};

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function stx(
  who: KeyPair,
  chainId: string,
  nonces: Map<KeyPair, bigint>,
  payload: Payload,
): Transaction {
  const nonce = nonces.get(who) ?? 0n;
  nonces.set(who, nonce + 1n);
  const u = { chainId, nonce, sender: who.publicKey, maxFee: 500_000n, payload };
  return { ...u, signature: sign(transactionSigningBytes(u), who.secretKey) };
}

async function submit(rpc: NodeRpcClient, tx: Transaction) {
  const hash = await rpc.submitTx(encodeTransaction(tx));
  return rpc.waitForTx(hash, { timeoutMs: 30_000 });
}

const l1Tx = (who: KeyPair, payload: Payload) => stx(who, L1_CHAIN, l1Nonces, payload);
const appTx = (who: KeyPair, payload: Payload) => stx(who, `app:${APP}`, appNonces, payload);

beforeAll(async () => {
  testnet = await createTestnet(3);

  l1 = await Node.start({
    dir: tmp('hssn-season-l1-'),
    genesis: {
      chainId: L1_CHAIN,
      validators: [encodeAddress(l1Validator.publicKey)],
      allocations: [
        { address: encodeAddress(owner.publicKey), balance: 10_000_000n },
        { address: encodeAddress(relayer.publicKey), balance: 10_000_000n },
        { address: encodeAddress(alice.publicKey), balance: 10_000_000n },
        { address: encodeAddress(bob.publicKey), balance: 10_000_000n },
      ],
    },
    keyPair: l1Validator,
    blockIntervalMs: 100,
    bootstrap: testnet.bootstrap,
  });
  l1Rpc = NodeRpcClient.connect(l1.rpcPublicKey, { bootstrap: testnet.bootstrap });
}, 120_000);

afterAll(async () => {
  if (daemon) await daemon.close();
  if (chainA) await chainA.stop().catch(() => {});
  if (chainB) await chainB.stop().catch(() => {});
  if (l1Rpc) await l1Rpc.close();
  if (l1) await l1.stop();
  if (testnet) await testnet.destroy();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}, 120_000);

describe('a wagered season (acceptance)', () => {
  it('stage 1: stakes escrow on L1, gated to the app address', { timeout: 60_000 }, async () => {
    const wasm = new Uint8Array(readFileSync(join(repoRoot, 'contracts/dist/season_pool.wasm')));
    const deployNonce = l1Nonces.get(owner) ?? 0n;
    expect(
      (await submit(l1Rpc, l1Tx(owner, { kind: 'deploy_contract', code: wasm }))).success,
    ).toBe(true);
    pool = contractIdFor(owner.publicKey, deployNonce, wasm);

    const exec = (who: KeyPair, action: string, args: Uint8Array, value = 0n) =>
      submit(l1Rpc, l1Tx(who, { kind: 'execute_contract', contract: pool, value, action, args }));

    expect((await exec(owner, 'init', addr(appAddress(APP)))).success).toBe(true);
    expect((await exec(alice, 'stake', new Uint8Array(0), STAKE)).success).toBe(true);
    expect((await exec(bob, 'stake', new Uint8Array(0), STAKE)).success).toBe(true);

    // Nobody but the game can settle — not even the deployer.
    const early = await exec(owner, 'payout', addr(alice.publicKey));
    expect(early.success).toBe(false);
    expect(early.error).toContain('only the game may report the winner');
  });

  it('stage 2: the season runs on the app chain', { timeout: 120_000 }, async () => {
    expect(
      (
        await submit(
          l1Rpc,
          l1Tx(owner, {
            kind: 'register_app',
            appId: APP,
            pearKey: new Uint8Array(32).fill(1),
            version: '1.0.0',
            contractAddress: new Uint8Array(32),
            metadataHash: new Uint8Array(32).fill(2),
            chainValidators: [alice.publicKey, bob.publicKey],
          }),
        )
      ).success,
    ).toBe(true);

    // Both players join from the registry entry alone.
    [chainA, chainB] = await Promise.all([
      AppChain.join(l1Rpc, APP, {
        dir: tmp('hssn-season-a-'),
        keyPair: alice,
        bootstrap: testnet.bootstrap,
        blockIntervalMs: 100,
      }),
      AppChain.join(l1Rpc, APP, {
        dir: tmp('hssn-season-b-'),
        keyPair: bob,
        bootstrap: testnet.bootstrap,
        blockIntervalMs: 100,
      }),
    ]);
    expect(chainA.genesis).toEqual(chainB.genesis);
    await Promise.all([chainA.waitForPeers(1), chainB.waitForPeers(1)]);

    // Game rules are contracts on the app chain — deploy frontier there
    // and play. Zero L1 involvement from here to season end.
    const appRpc = NodeRpcClient.connect(chainA.rpcPublicKey, { bootstrap: testnet.bootstrap });
    try {
      const wasm = new Uint8Array(readFileSync(join(repoRoot, 'contracts/dist/frontier.wasm')));
      const deployNonce = appNonces.get(alice) ?? 0n;
      expect(
        (await submit(appRpc, appTx(alice, { kind: 'deploy_contract', code: wasm }))).success,
      ).toBe(true);
      frontier = contractIdFor(alice.publicKey, deployNonce, wasm);

      const play = (who: KeyPair, action: string, args: Uint8Array) =>
        submit(
          appRpc,
          appTx(who, { kind: 'execute_contract', contract: frontier, value: 0n, action, args }),
        );

      expect((await play(alice, 'init', u64(144n))).success).toBe(true);
      expect((await play(alice, 'claim_tile', u64(1n))).success).toBe(true);
      expect((await play(bob, 'claim_tile', u64(2n))).success).toBe(true);
      const cat = new Uint8Array(
        Buffer.concat([Buffer.from(u64(1n)), Buffer.from([4, 0, 0, 0]), Buffer.from('farm')]),
      );
      expect((await play(alice, 'build', cat)).success).toBe(true);
    } finally {
      await appRpc.close();
    }
  });

  it('stage 3: the anchored outcome settles the pot', { timeout: 60_000 }, async () => {
    const before = BigInt((await l1Rpc.getAccount(encodeAddress(alice.publicKey))).balance);

    daemon = new AnchorDaemon({
      chain: chainA.chain,
      appId: APP,
      validators: [alice.publicKey, bob.publicKey],
      keyPair: alice,
      l1: { chainId: L1_CHAIN, nodeKey: l1.rpcPublicKey, bootstrap: testnet.bootstrap },
      relayer,
      // The app decides its outcome by reading its own chain; here the
      // winner is simply alice (she owns the farm).
      outcome: () => ({ contract: pool, action: 'payout', args: addr(alice.publicKey) }),
    });

    const info = await daemon.anchorNow();
    expect(info).not.toBeNull();
    expect(info!.success).toBe(true);

    // The pot (both stakes) landed with the winner.
    const after = BigInt((await l1Rpc.getAccount(encodeAddress(alice.publicKey))).balance);
    expect(after - before).toBe(STAKE * 2n);

    // The anchor is recorded and attests the app chain's real head.
    const anchor = await l1Rpc.getAppAnchor(APP);
    expect(anchor).not.toBeNull();
    expect(anchor!.epoch).toBe('1');
    const attested = await chainA.chain.getBlock(BigInt(anchor!.appHeight));
    expect(Buffer.from(attested!.header.stateRoot).toString('hex')).toBe(anchor!.stateRoot);
  });

  it('stage 4: the settlement is final and replay-proof', { timeout: 60_000 }, async () => {
    // A second payout attempt — even from the game itself — fails. (If
    // the app chain produced no new blocks, the daemon declines to
    // re-anchor at all, which is equally final.)
    const again = await daemon.anchorNow().catch((err: Error) => err);
    if (again !== null) {
      expect(again).toBeInstanceOf(Error);
      expect((again as Error).message).toContain('season already settled');
    }

    // Direct payout from a normal key fails on the sender gate.
    const direct = await submit(
      l1Rpc,
      l1Tx(bob, {
        kind: 'execute_contract',
        contract: pool,
        value: 0n,
        action: 'payout',
        args: addr(bob.publicKey),
      }),
    );
    expect(direct.success).toBe(false);
    expect(direct.error).toContain('only the game may report the winner');
  });

  it('stage 5: the app chain is disposable, the outcome is not', { timeout: 60_000 }, async () => {
    await chainA.stop();
    await chainB.stop();
    for (const dir of dirs.filter((d) => d.includes('season-a') || d.includes('season-b'))) {
      rmSync(dir, { recursive: true, force: true });
    }

    // L1 still holds the anchor and the settled pot.
    expect((await l1Rpc.getAppAnchor(APP))!.epoch).toBe('1');
    const entries = await l1.chain.getContractState(pool);
    const potKey = Buffer.concat([Buffer.from('s:Pot:'), Buffer.from(u64(0n))]);
    const pot = entries.find(([k]) => Buffer.from(k).equals(potKey));
    expect(pot).toBeDefined();
    // Pot = { total u64, paid bool }: paid flag is the last byte.
    expect(pot![1][pot![1].length - 1]).toBe(1);
  });
});
