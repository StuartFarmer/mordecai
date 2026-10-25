import { test } from 'vitest';
import assert from 'node:assert/strict';
import { selectSettlement } from '../../../scripts/lib/outpost-outcome.mjs';
import { play, trade, fundApp } from '../src/chain.js';
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const str = (s) => {
  const b = Buffer.from(s);
  const n = Buffer.alloc(4);
  n.writeUInt32LE(b.length);
  return Buffer.concat([n, b]);
};
const buyer = Buffer.alloc(32, 1),
  seller = Buffer.alloc(32, 2);
const order = (id, good = 'wood', amount = 10, phase = 0) => ({
  key: Buffer.concat([Buffer.from('s:Order:'), u64(id)]).toString('hex'),
  value: Buffer.concat([buyer, str(good), u64(amount), u64(50), u64(phase)]).toString('hex'),
});
const delivery = (id, who = buyer, good = 'wood', amount = 10) => [
  Buffer.concat([Buffer.from('s:Delivery:'), u64(id)]),
  Buffer.concat([seller, who, str(good), u64(amount)]),
];
test('only exact open deliveries settle; mismatch does not block unrelated valid order', () => {
  for (const invalid of [
    delivery(0, Buffer.alloc(32, 3)),
    delivery(0, buyer, 'wheat'),
    delivery(0, buyer, 'wood', 9),
  ]) {
    assert.equal(selectSettlement([invalid], [order(0)], buyer), null);
    const result = selectSettlement([invalid, delivery(1)], [order(0), order(1)], buyer);
    assert.equal(Buffer.from(result.args).readBigUInt64LE(), 1n);
  }
  for (const phase of [1, 2])
    assert.equal(selectSettlement([delivery(0)], [order(0, 'wood', 10, phase)], buyer), null);
});
test('facade sends use correct chains without fetching nonce or accessing seed', async () => {
  const calls = [];
  const p = {
    sendTransaction: async (...args) => {
      calls.push(args);
      return { height: 1 };
    },
  };
  const cfg = {
    appApi: '/api/demos/outpost',
    appChainId: 'app',
    chainId: 'l1',
    outpost: '11'.repeat(32),
    market: '22'.repeat(32),
  };
  await play(p, cfg, { claim_tile: { tile_id: 0 } });
  await trade(p, cfg, { place_order: { good: 'wood', amount: 2 } }, 3n);
  assert.deepEqual(
    calls.map((c) => c.slice(0, 2)),
    [
      ['/api/demos/outpost', 'app'],
      ['', 'l1'],
    ],
  );
  assert.equal(calls[1][2].value, 3n);
  assert.throws(() => trade(p, cfg, { place_order: { good: 'wood', amount: 1.5 } }, 3n));
  assert.throws(() => trade(p, cfg, { place_order: { good: 'wood', amount: 0 } }, 3n));
});
test('funding only calls mounted app faucet and app receipt', async () => {
  const old = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push([url, init]);
    return {
      ok: true,
      json: async () =>
        url.endsWith('/api/faucet') ? { hash: 'abc' } : { success: true, height: 4 },
    };
  };
  try {
    await fundApp(
      { address: 'player' },
      { appApi: '/api/demos/outpost', appFaucet: '/api/demos/outpost/api/faucet' },
    );
    assert.deepEqual(
      calls.map((c) => c[0]),
      ['/api/demos/outpost/api/faucet', '/api/demos/outpost/api/tx/abc'],
    );
    assert.equal(JSON.parse(calls[0][1].body).address, 'player');
  } finally {
    globalThis.fetch = old;
  }
});

test('Outpost identities and bootstrap receipts persist without repeated submissions', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { loadDemoIdentity, bootstrapTransaction } =
    await import('../../../scripts/lib/demo-state.mjs');
  const { decodeTransaction } = await import('../../../packages/protocol/dist/index.js');
  const { transactionHash } = await import('../../../packages/wallet/dist/index.js');
  const dir = mkdtempSync(join(tmpdir(), 'outpost-test-'));
  try {
    const a = loadDemoIdentity(dir, 'l1', 0),
      b = loadDemoIdentity(dir, 'l1', 0);
    assert.deepEqual(a.key('host-a').publicKey, b.key('host-a').publicKey);
    assert.notDeepEqual(a.key('host-a').publicKey, a.key('host-b').publicKey);
    let submits = 0;
    const receipts = new Map();
    const rpc = {
      getAccount: async () => ({ nonce: '0' }),
      getTx: async (hash) => receipts.get(hash),
      submitTx: async (bytes) => {
        submits++;
        return Buffer.from(transactionHash(decodeTransaction(bytes))).toString('hex');
      },
      waitForTx: async (hash) => {
        const receipt = { success: true, returnData: 'aa' };
        receipts.set(hash, receipt);
        return receipt;
      },
    };
    const payload = { kind: 'transfer', to: a.key('relayer').publicKey, amount: 10_000_000n };
    await bootstrapTransaction(dir, 'outpost-relayer-fund', rpc, 'l1', a.key('host-a'), payload);
    await bootstrapTransaction(dir, 'outpost-relayer-fund', rpc, 'l1', b.key('host-a'), payload);
    assert.equal(submits, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
