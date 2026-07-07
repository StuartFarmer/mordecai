/**
 * App-chain runtime over a real DHT testnet (app-chains spec §3.3): two
 * validators derive the same genesis from the registry entry, run the
 * chain, and the anchor daemon collects a co-signature over hyperswarm
 * RPC and lands the anchor on a live L1 node.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import createTestnet from 'hyperdht/testnet';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeAddress, generateSeed, keyPairFromSeed, sign, type KeyPair } from '@hssn/crypto';
import { genesisHash } from '@hssn/chain';
import {
  encodeTransaction,
  transactionSigningBytes,
  type Payload,
  type Transaction,
} from '@hssn/protocol';
import { Node } from '@hssn/node';
import { NodeRpcClient } from '@hssn/rpc';
import { AnchorDaemon, AppChain, appChainGenesis } from '../src/index.js';

const L1_CHAIN = 'hssn-appchain-test';
const APP = 'com.example.game';

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
const dirs: string[] = [];
const nonces = new Map<KeyPair, bigint>();

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function stx(who: KeyPair, chainId: string, payload: Payload): Transaction {
  const nonce = nonces.get(who) ?? 0n;
  nonces.set(who, nonce + 1n);
  const u = { chainId, nonce, sender: who.publicKey, maxFee: 500_000n, payload };
  return { ...u, signature: sign(transactionSigningBytes(u), who.secretKey) };
}

async function submit(rpc: NodeRpcClient, tx: Transaction) {
  const hash = await rpc.submitTx(encodeTransaction(tx));
  const info = await rpc.waitForTx(hash, { timeoutMs: 30_000 });
  if (!info.success) throw new Error(`tx failed: ${info.error}`);
  return info;
}

beforeAll(async () => {
  testnet = await createTestnet(3);

  l1 = await Node.start({
    dir: tmp('hssn-ac-l1-'),
    genesis: {
      chainId: L1_CHAIN,
      validators: [encodeAddress(l1Validator.publicKey)],
      allocations: [
        { address: encodeAddress(owner.publicKey), balance: 10_000_000n },
        { address: encodeAddress(relayer.publicKey), balance: 10_000_000n },
      ],
    },
    keyPair: l1Validator,
    blockIntervalMs: 100,
    bootstrap: testnet.bootstrap,
  });
  l1Rpc = NodeRpcClient.connect(l1.rpcPublicKey, { bootstrap: testnet.bootstrap });

  await submit(
    l1Rpc,
    stx(owner, L1_CHAIN, {
      kind: 'register_app',
      appId: APP,
      pearKey: new Uint8Array(32).fill(1),
      version: '1.0.0',
      contractAddress: new Uint8Array(32),
      metadataHash: new Uint8Array(32).fill(2),
      chainValidators: [alice.publicKey, bob.publicKey],
    }),
  );

  const chainValidators = [alice.publicKey, bob.publicKey];
  [chainA, chainB] = await Promise.all([
    AppChain.start({
      appId: APP,
      chainValidators,
      dir: tmp('hssn-ac-a-'),
      keyPair: alice,
      bootstrap: testnet.bootstrap,
      blockIntervalMs: 100,
    }),
    AppChain.start({
      appId: APP,
      chainValidators,
      dir: tmp('hssn-ac-b-'),
      keyPair: bob,
      bootstrap: testnet.bootstrap,
      blockIntervalMs: 100,
    }),
  ]);

  daemon = new AnchorDaemon({
    chain: chainA.chain,
    appId: APP,
    validators: chainValidators,
    keyPair: alice,
    l1: { chainId: L1_CHAIN, nodeKey: l1.rpcPublicKey, bootstrap: testnet.bootstrap },
    relayer,
  });
}, 120_000);

afterAll(async () => {
  if (daemon) await daemon.close();
  if (chainA) await chainA.stop();
  if (chainB) await chainB.stop();
  if (l1Rpc) await l1Rpc.close();
  if (l1) await l1.stop();
  if (testnet) await testnet.destroy();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}, 120_000);

describe('app chains over the swarm', () => {
  it('derives one deterministic genesis for every joiner', () => {
    const a = appChainGenesis(APP, [alice.publicKey, bob.publicKey]);
    const b = appChainGenesis(APP, [alice.publicKey, bob.publicKey]);
    expect(a).toEqual(b);
    expect(genesisHash(a)).toEqual(genesisHash(b));
    expect(a.chainId).toBe(`app:${APP}`);
    expect(chainA.genesis).toEqual(chainB.genesis);
    expect(chainA.isValidator).toBe(true);
    expect(chainB.isValidator).toBe(true);
  });

  it('plays app transactions and both validators converge', { timeout: 60_000 }, async () => {
    const appRpc = NodeRpcClient.connect(chainA.rpcPublicKey, { bootstrap: testnet.bootstrap });
    try {
      // "game moves": app-chain transfers between the two players
      for (let i = 0; i < 3; i++) {
        await submit(
          appRpc,
          stx(alice, `app:${APP}`, { kind: 'transfer', to: bob.publicKey, amount: 100n }),
        );
      }
    } finally {
      await appRpc.close();
    }

    const target = chainA.chain.height;
    const deadline = Date.now() + 30_000;
    while (chainB.chain.height < target) {
      if (Date.now() > deadline) throw new Error('validator B never converged');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(
      Buffer.compare(
        (await chainB.chain.getBlock(target))!.header.stateRoot,
        (await chainA.chain.getBlock(target))!.header.stateRoot,
      ),
    ).toBe(0);
  });

  it('anchors the head to L1 with a co-signature from the peer', { timeout: 60_000 }, async () => {
    const info = await daemon.anchorNow();
    expect(info).not.toBeNull();
    expect(info!.success).toBe(true);

    const anchor = await l1Rpc.getAppAnchor(APP);
    expect(anchor).not.toBeNull();
    expect(anchor!.epoch).toBe('1');
    const attested = await chainA.chain.getBlock(BigInt(anchor!.appHeight));
    expect(Buffer.from(attested!.header.stateRoot).toString('hex')).toBe(anchor!.stateRoot);
  });

  it('skips anchoring when nothing new happened', { timeout: 60_000 }, async () => {
    // Wait for block production to go quiet at the anchored height, then
    // the daemon declines to re-anchor the same head.
    const anchored = await l1Rpc.getAppAnchor(APP);
    const height = BigInt(anchored!.appHeight);
    if (chainA.chain.height === height) {
      expect(await daemon.anchorNow()).toBeNull();
    } else {
      // Chain moved (empty blocks); a second anchor must take epoch 2.
      const info = await daemon.anchorNow();
      expect(info!.success).toBe(true);
      expect((await l1Rpc.getAppAnchor(APP))!.epoch).toBe('2');
    }
  });
});
