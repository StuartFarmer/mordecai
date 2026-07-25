import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import createTestnet from 'hyperdht/testnet';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Network } from '../src/index.js';

const text = (b: Uint8Array) => new TextDecoder().decode(b);

let testnet: Awaited<ReturnType<typeof createTestnet>>;
let dirs: string[];
let alice: Network;
let bob: Network;

beforeAll(async () => {
  testnet = await createTestnet(3);
  dirs = [
    mkdtempSync(join(tmpdir(), 'mordecai-net-a-')),
    mkdtempSync(join(tmpdir(), 'mordecai-net-b-')),
  ];
  alice = Network.create({ storageDir: dirs[0]!, bootstrap: testnet.bootstrap });
  bob = Network.create({ storageDir: dirs[1]!, bootstrap: testnet.bootstrap });
}, 60_000);

afterAll(async () => {
  await alice.close();
  await bob.close();
  await testnet.destroy();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}, 60_000);

describe('peer-to-peer feed replication (M2 acceptance)', () => {
  it('replicates a feed from alice to bob over the swarm', { timeout: 60_000 }, async () => {
    const chat = await alice.createFeed('chat');
    await chat.append('hello');
    await chat.append('from alice');

    await alice.joinFeed(chat);
    const chatAtBob = await bob.openFeed(chat.key);
    await bob.joinFeed(chatAtBob);

    expect(text(await chatAtBob.get(0))).toBe('hello');
    expect(text(await chatAtBob.get(1))).toBe('from alice');
    expect(alice.connectionCount).toBeGreaterThan(0);
    expect(bob.connectionCount).toBeGreaterThan(0);
  });

  it(
    'replicates in the other direction over the same connections',
    { timeout: 60_000 },
    async () => {
      const reply = await bob.createFeed('reply');
      await reply.append('hi alice');

      const replyAtAlice = await alice.openFeed(reply.key);
      expect(text(await replyAtAlice.get(0))).toBe('hi alice');
    },
  );

  it('streams live appends to subscribed peers', { timeout: 60_000 }, async () => {
    const chat = await alice.createFeed('chat');
    const chatAtBob = await bob.openFeed(chat.key);

    const seen = new Promise<void>((resolve) => {
      const unsubscribe = chatAtBob.onAppend(() => {
        unsubscribe();
        resolve();
      });
    });
    const updated = chatAtBob.update();
    await chat.append('late breaking news');
    await updated;
    await seen;

    expect(chatAtBob.length).toBe(3);
    expect(text(await chatAtBob.get(2))).toBe('late breaking news');
  });
});
