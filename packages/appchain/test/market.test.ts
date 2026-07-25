/**
 * The cross-chain goods market (outpost demo): L1 currency buys in-game
 * items with no bridge. One wallet identity acts on both chains — the
 * buyer's key escrows CAI on L1 and receives wood in the game; the
 * seller's key hands over wood in the game and is paid on L1 by the
 * anchored settle call.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import createTestnet from 'hyperdht/testnet';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeAddress, generateSeed, keyPairFromSeed, sign, type KeyPair } from '@mordecai/crypto';
import { appAddress, contractIdFor } from '@mordecai/chain';
import {
  encodeTransaction,
  transactionSigningBytes,
  type Payload,
  type Transaction,
} from '@mordecai/protocol';
import { Node } from '@mordecai/node';
import { NodeRpcClient } from '@mordecai/rpc';
import { AnchorDaemon, AppChain } from '../src/index.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const L1_CHAIN = 'mordecai-market-test';
const APP = 'com.example.outpost';
const PRICE = 400_000n;

// alice sells wood; bob buys it with L1 currency. Same keys everywhere.
const alice: KeyPair = keyPairFromSeed(generateSeed());
const bob: KeyPair = keyPairFromSeed(generateSeed());
const owner: KeyPair = keyPairFromSeed(generateSeed());
const relayer: KeyPair = keyPairFromSeed(generateSeed());
const l1Validator: KeyPair = keyPairFromSeed(generateSeed());

let testnet: Awaited<ReturnType<typeof createTestnet>>;
let l1: Node;
let l1Rpc: NodeRpcClient;
let chainA: AppChain;
let chainB: AppChain;
let daemon: AnchorDaemon;
let market: Uint8Array; // L1
let outpost: Uint8Array; // app chain
const dirs: string[] = [];
const l1Nonces = new Map<KeyPair, bigint>();
const appNonces = new Map<KeyPair, bigint>();

const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return new Uint8Array(b);
};
const str = (s: string) => {
  const bytes = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length);
  return new Uint8Array(Buffer.concat([len, bytes]));
};
const addr = (key: Uint8Array) => {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(32);
  return new Uint8Array(Buffer.concat([len, Buffer.from(key)]));
};
const cat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts.map(Buffer.from)));

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

async function balance(who: KeyPair): Promise<bigint> {
  return BigInt((await l1Rpc.getAccount(encodeAddress(who.publicKey))).balance);
}

/** Decode an app-chain Account row ({wood, wheat}) for one player. */
async function goods(who: KeyPair): Promise<{ wood: bigint; wheat: bigint }> {
  const entries = await chainA.chain.getContractState(outpost);
  const wanted = Buffer.concat([Buffer.from('s:Account:'), Buffer.from(who.publicKey)]);
  const row = entries.find(([k]) => Buffer.from(k).equals(wanted));
  if (!row) return { wood: 0n, wheat: 0n };
  const view = Buffer.from(row[1]);
  return { wood: view.readBigUInt64LE(0), wheat: view.readBigUInt64LE(8) };
}

beforeAll(async () => {
  testnet = await createTestnet(3);

  l1 = await Node.start({
    dir: tmp('mordecai-market-l1-'),
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

  // L1: deploy the goods market, gated to the app's derived address.
  const marketWasm = new Uint8Array(
    readFileSync(join(repoRoot, 'contracts/dist/goods_market.wasm')),
  );
  const marketNonce = l1Nonces.get(owner) ?? 0n;
  await submit(l1Rpc, l1Tx(owner, { kind: 'deploy_contract', code: marketWasm }));
  market = contractIdFor(owner.publicKey, marketNonce, marketWasm);
  await submit(
    l1Rpc,
    l1Tx(owner, {
      kind: 'execute_contract',
      contract: market,
      value: 0n,
      action: 'init',
      args: addr(appAddress(APP)),
    }),
  );

  // Register the app and start its chain (alice + bob are the validators).
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
  );
  [chainA, chainB] = await Promise.all([
    AppChain.join(l1Rpc, APP, {
      dir: tmp('mordecai-market-a-'),
      keyPair: alice,
      bootstrap: testnet.bootstrap,
      blockIntervalMs: 100,
    }),
    AppChain.join(l1Rpc, APP, {
      dir: tmp('mordecai-market-b-'),
      keyPair: bob,
      bootstrap: testnet.bootstrap,
      blockIntervalMs: 100,
    }),
  ]);
  await Promise.all([chainA.waitForPeers(1), chainB.waitForPeers(1)]);

  // App chain: deploy the game.
  const appRpc = NodeRpcClient.connect(chainA.rpcPublicKey, { bootstrap: testnet.bootstrap });
  try {
    const gameWasm = new Uint8Array(readFileSync(join(repoRoot, 'contracts/dist/outpost.wasm')));
    const gameNonce = appNonces.get(alice) ?? 0n;
    await submit(appRpc, appTx(alice, { kind: 'deploy_contract', code: gameWasm }));
    outpost = contractIdFor(alice.publicKey, gameNonce, gameWasm);
    await submit(
      appRpc,
      appTx(alice, {
        kind: 'execute_contract',
        contract: outpost,
        value: 0n,
        action: 'init',
        args: u64(144n),
      }),
    );
  } finally {
    await appRpc.close();
  }
}, 180_000);

afterAll(async () => {
  if (daemon) await daemon.close();
  if (chainA) await chainA.stop().catch(() => {});
  if (chainB) await chainB.stop().catch(() => {});
  if (l1Rpc) await l1Rpc.close();
  if (l1) await l1.stop();
  if (testnet) await testnet.destroy();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}, 120_000);

describe('L1 currency for in-game goods, no bridge', () => {
  it('bob escrows CAI on L1 for wood that only exists in the game', async () => {
    const before = await balance(bob);
    const receipt = await submit(
      l1Rpc,
      l1Tx(bob, {
        kind: 'execute_contract',
        contract: market,
        value: PRICE,
        action: 'place_order',
        args: cat(str('wood'), u64(10n)),
      }),
    );
    expect(receipt.success).toBe(true);
    expect(before - (await balance(bob))).toBeGreaterThanOrEqual(PRICE); // price + fee
  });

  it('alice delivers the wood in-game — same identities as L1', { timeout: 60_000 }, async () => {
    const appRpc = NodeRpcClient.connect(chainA.rpcPublicKey, { bootstrap: testnet.bootstrap });
    try {
      const play = (who: KeyPair, action: string, args: Uint8Array) =>
        submit(
          appRpc,
          appTx(who, { kind: 'execute_contract', contract: outpost, value: 0n, action, args }),
        );

      // alice earns wood by claiming land (+25), then fills order 0.
      expect((await play(alice, 'claim_tile', u64(7n))).success).toBe(true);
      const deliver = await play(
        alice,
        'deliver',
        cat(u64(0n), addr(bob.publicKey), str('wood'), u64(10n)),
      );
      expect(deliver.success).toBe(true);

      // Double delivery of the same order is refused by the game.
      const again = await play(
        alice,
        'deliver',
        cat(u64(0n), addr(bob.publicKey), str('wood'), u64(10n)),
      );
      expect(again.error).toBe('order already delivered');
    } finally {
      await appRpc.close();
    }

    expect(await goods(alice)).toEqual({ wood: 15n, wheat: 0n });
    expect(await goods(bob)).toEqual({ wood: 10n, wheat: 0n });
  });

  it('the anchored outcome releases the escrow to the seller', { timeout: 60_000 }, async () => {
    const before = await balance(alice);

    daemon = new AnchorDaemon({
      chain: chainA.chain,
      appId: APP,
      validators: [alice.publicKey, bob.publicKey],
      keyPair: alice,
      l1: { chainId: L1_CHAIN, nodeKey: l1.rpcPublicKey, bootstrap: testnet.bootstrap },
      relayer,
      // The outcome reads the game's own state: order 0 was delivered by
      // alice, so the game instructs the market to pay her.
      outcome: () => ({
        contract: market,
        action: 'settle',
        args: cat(u64(0n), addr(alice.publicKey)),
      }),
    });

    const info = await daemon.anchorNow();
    expect(info!.success).toBe(true);
    expect((await balance(alice)) - before).toBe(PRICE);
    expect((await l1Rpc.getAppAnchor(APP))!.epoch).toBe('1');
  });

  it('settlement is single-shot and game-gated', { timeout: 60_000 }, async () => {
    // Even the game cannot settle twice.
    const replay = await daemon.anchorNow().catch((err: Error) => err);
    if (replay !== null) {
      expect((replay as Error).message).toContain('order is not open');
    }

    // A normal key cannot impersonate the game.
    const direct = await submit(
      l1Rpc,
      l1Tx(alice, {
        kind: 'execute_contract',
        contract: market,
        value: 0n,
        action: 'settle',
        args: cat(u64(0n), addr(alice.publicKey)),
      }),
    );
    expect(direct.success).toBe(false);
    expect(direct.error).toContain('only the game may settle deliveries');

    // A second order can still be cancelled by its buyer for a refund.
    const receipt = await submit(
      l1Rpc,
      l1Tx(bob, {
        kind: 'execute_contract',
        contract: market,
        value: 100_000n,
        action: 'place_order',
        args: cat(str('wheat'), u64(5n)),
      }),
    );
    expect(receipt.success).toBe(true);
    const before = await balance(bob);
    expect(
      (
        await submit(
          l1Rpc,
          l1Tx(bob, {
            kind: 'execute_contract',
            contract: market,
            value: 0n,
            action: 'cancel_order',
            args: u64(1n),
          }),
        )
      ).success,
    ).toBe(true);
    expect((await balance(bob)) - before).toBeGreaterThan(0n); // refund minus fee
  });
});
