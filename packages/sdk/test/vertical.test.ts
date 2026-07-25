/**
 * Spec §28 First Technical Milestone — the v1 exit criterion.
 * A user launches an app (registry install), authenticates with their
 * wallet, syncs shared state over Hypercore, executes an on-chain payment,
 * receives finalized confirmation, and keeps using the app — on a real
 * multi-validator network over a real DHT.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import createTestnet from 'hyperdht/testnet';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Genesis } from '@mordecai/chain';
import { encodeAddress, generateSeed, keyPairFromSeed, verify } from '@mordecai/crypto';
import { Node } from '@mordecai/node';
import { Wallet } from '@mordecai/wallet';
import { Mordecai } from '../src/index.js';

const CHAIN_ID = 'mordecai-vertical-1';
const APP_ID = 'com.example.chess';
const BUNDLE = new TextEncoder().encode('{"name":"chess","main":"app.js"} <bundle bytes>');

const validators = [0, 1].map(() => keyPairFromSeed(generateSeed()));
const { wallet: developer } = Wallet.create();
const { wallet: user } = Wallet.create();

let testnet: Awaited<ReturnType<typeof createTestnet>>;
const dirs: string[] = [];
const nodes: Node[] = [];
let dev: Mordecai;
let app: Mordecai;

const tmp = (tag: string) => {
  const dir = mkdtempSync(join(tmpdir(), `mordecai-vert-${tag}-`));
  dirs.push(dir);
  return dir;
};

beforeAll(async () => {
  testnet = await createTestnet(3);
  const genesis: Genesis = {
    chainId: CHAIN_ID,
    validators: validators.map((v) => encodeAddress(v.publicKey)),
    allocations: [
      { address: developer.address, balance: 5_000_000n },
      { address: user.address, balance: 5_000_000n },
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
  dev = Mordecai.connect({
    wallet: developer,
    nodeKey: nodes[0]!.rpcPublicKey,
    storageDir: tmp('dev'),
    chainId: CHAIN_ID,
    bootstrap: testnet.bootstrap,
  });
  app = Mordecai.connect({
    wallet: user,
    nodeKey: nodes[1]!.rpcPublicKey,
    storageDir: tmp('user'),
    chainId: CHAIN_ID,
    bootstrap: testnet.bootstrap,
  });
}, 90_000);

afterAll(async () => {
  await dev.close();
  await app.close();
  for (const node of nodes) await node.stop().catch(() => {});
  await testnet.destroy();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}, 90_000);

describe('spec §28 vertical slice', () => {
  it('runs all seven steps end to end', { timeout: 120_000 }, async () => {
    // 1. Developer publishes the app: bundle feed + on-chain registration.
    const published = await dev.publishApp({ appId: APP_ID, version: '1.0.0', bundle: BUNDLE });
    expect(published.tx.success).toBe(true);

    // 2. User installs from the registry: untrusted swarm fetch, verified
    //    against the on-chain hash — then "launches" the app.
    const installed = await app.installApp(APP_ID);
    expect(installed.bundle).toEqual(BUNDLE);
    expect(installed.entry.owner).toBe(developer.address);

    // 3. The app automatically authenticates the user with their wallet.
    const challenge = new TextEncoder().encode(`login:${APP_ID}:42`);
    const auth = await app.authenticate(challenge);
    expect(auth.address).toBe(user.address);
    expect(verify(auth.signature, challenge, auth.publicKey)).toBe(true);

    // 4. Shared state syncs peer-to-peer, both directions, no chain involved.
    const moves = await dev.createFeed('chess-moves');
    await moves.append('e4');
    await dev.joinFeed(moves);
    const movesAtUser = await app.openFeed(moves.key);
    await app.joinFeed(movesAtUser);
    expect(new TextDecoder().decode(await movesAtUser.get(0))).toBe('e4');

    const replies = await app.createFeed('chess-replies');
    await replies.append('e5');
    const repliesAtDev = await dev.openFeed(replies.key);
    expect(new TextDecoder().decode(await repliesAtDev.get(0))).toBe('e5');

    // 5+6. The user pays the developer on-chain and gets a finalized receipt.
    const devBefore = BigInt((await dev.account()).balance);
    const receipt = await app.transfer(developer.address, 250_000n);
    expect(receipt.success).toBe(true);
    expect(Number(receipt.height)).toBeGreaterThan(0);
    expect(BigInt((await dev.account()).balance)).toBe(devBefore + 250_000n);

    // 7. The application keeps working after settlement.
    await moves.append('Nf3');
    await movesAtUser.update();
    expect(new TextDecoder().decode(await movesAtUser.get(1))).toBe('Nf3');
  });
});
