import RPC from '@hyperswarm/rpc';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import createTestnet from 'hyperdht/testnet';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Node, initNodeDir } from '@mordecai/node';
import { NodeRpcClient, type BlockInfo, type HeadInfo, type TxInfo } from '@mordecai/rpc';
import { encodeTransaction, type Payload } from '@mordecai/protocol';
import { Wallet } from '@mordecai/wallet';
import { Gateway } from '../src/gateway.js';

let testnet: Awaited<ReturnType<typeof createTestnet>>;
let appTestnet: Awaited<ReturnType<typeof createTestnet>>;
let dir: string;
let node: Node;
let rpc: NodeRpcClient;
let gateway: Gateway;
let base: string;
const { wallet } = Wallet.create();
const appId = 'demo/雪';
const appPath = `/api/app/${encodeURIComponent(appId)}/chain`;
let nonce = 0n;
const peers: RPC[] = [];
let holdHead: Promise<void> | undefined;
let heldHeads = 0;
const head: HeadInfo = {
  chainId: `app:${appId}`,
  height: '7',
  headHash: '11'.repeat(32),
  stateRoot: '22'.repeat(32),
  timestampMs: '123',
};
const block: BlockInfo = {
  hash: head.headHash,
  header: {
    version: 1,
    chainId: head.chainId,
    height: '7',
    prevHash: '00'.repeat(32),
    timestampMs: '123',
    proposer: '',
    txsRoot: '00'.repeat(32),
    stateRoot: head.stateRoot,
  },
  txs: [],
};
const receipt: TxInfo = {
  hash: '33'.repeat(32),
  height: '7',
  index: 0,
  success: true,
  fee: '1',
  events: [],
  returnData: '',
};
let mountedKey: string;
let mountedMissing = false;

async function peer(
  chainId = head.chainId,
  missing = false,
  bootstrap = appTestnet.bootstrap,
): Promise<string> {
  const peerRpc = new RPC({ bootstrap });
  const mounted = peers.length === 0;
  peers.push(peerRpc);
  const server = peerRpc.createServer();
  for (const [method, result] of [
    ['get_head', { ...head, chainId }],
    ['get_block', missing ? null : { ...block, header: { ...block.header, chainId } }],
    ['get_tx', missing ? null : receipt],
  ] as const) {
    server.respond(method, async () => {
      if (method === 'get_head' && holdHead) {
        heldHeads++;
        await holdHead;
      }
      return Buffer.from(
        JSON.stringify({
          ok: true,
          result: mounted && mountedMissing && method !== 'get_head' ? null : result,
        }),
      );
    });
  }
  await server.listen();
  return Buffer.from(server.publicKey!).toString('hex');
}

async function transact(payload: Payload) {
  const encoded = encodeTransaction(
    wallet.signTransaction({
      chainId: 'explorer-api-test',
      nonce: nonce++,
      maxFee: 500_000n,
      payload,
    }),
  );
  const hash = await rpc.submitTx(encoded);
  const info = await rpc.waitForTx(hash);
  expect(info.success).toBe(true);
  return { hash, info, encoded: Buffer.from(encoded).toString('hex') };
}

async function register(id: string, validators: string[] = [], update = false) {
  await transact({
    kind: update ? 'update_app' : 'register_app',
    appId: id,
    pearKey: new Uint8Array(32).fill(1),
    version: update ? '2' : '1',
    contractAddress: new Uint8Array(32),
    metadataHash: new Uint8Array(32),
    chainValidators: validators.map((key) => new Uint8Array(Buffer.from(key, 'hex'))),
  });
}

async function error(path: string, status: number, code: string, method = 'GET') {
  const response = await fetch(base + path, { method });
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ code, error: expect.any(String) });
}

beforeAll(async () => {
  testnet = await createTestnet(3);
  appTestnet = await createTestnet(3);
  dir = mkdtempSync(join(tmpdir(), 'explorer-api-'));
  const config = initNodeDir({
    dir,
    chainId: 'explorer-api-test',
    allocations: [{ address: wallet.address, balance: 100_000_000n }],
  });
  node = await Node.start({
    dir,
    genesis: config.genesis,
    keyPair: config.keyPair,
    blockIntervalMs: 50,
    bootstrap: testnet.bootstrap,
  });
  rpc = NodeRpcClient.connect(node.rpcPublicKey, { bootstrap: testnet.bootstrap });
  mountedKey = await peer();
  gateway = await Gateway.start({
    nodeKey: node.rpcPublicKey,
    bootstrap: testnet.bootstrap,
    config: { demos: { hex: { appId } } },
    networks: {
      hex: { nodeKey: Buffer.from(mountedKey, 'hex'), bootstrap: appTestnet.bootstrap },
      settlement: { nodeKey: node.rpcPublicKey, bootstrap: testnet.bootstrap },
    },
  });
  base = `http://127.0.0.1:${gateway.port}`;
}, 60_000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await gateway?.close();
  await rpc?.close();
  await node?.stop();
  await Promise.all(peers.map((peerRpc) => peerRpc.destroy()));
  await appTestnet?.destroy();
  await testnet?.destroy();
  if (dir) rmSync(dir, { recursive: true, force: true });
}, 60_000);

describe('settlement explorer HTTP reads', () => {
  it('returns an empty registry page', async () => {
    const response = await fetch(base + '/api/apps');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ apps: [], nextAfter: null });
  });

  it('reads genesis and finalized blocks, preserving receipt transaction indices', async () => {
    const response = await fetch(base + '/api/block/0');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(await rpc.getBlock(0n));
    const { info, encoded } = await transact({
      kind: 'transfer',
      to: Wallet.create().wallet.publicKey,
      amount: 1n,
    });
    for (const prefix of ['', '/api/demos/settlement']) {
      const result = await fetch(base + `${prefix}/api/block/${info.height}`);
      expect(result.status).toBe(200);
      const body = (await result.json()) as BlockInfo;
      expect(body).toEqual(await rpc.getBlock(BigInt(info.height)));
      expect(body.txs[info.index]).toBe(encoded);
    }
  }, 15_000);

  it('paginates current registrations and reflects registry updates', async () => {
    await register('a-app');
    await register(appId, [mountedKey]);
    const first = await (await fetch(base + '/api/apps?limit=1')).json();
    expect(first).toMatchObject({ apps: [{ appId: 'a-app', version: '1' }], nextAfter: 'a-app' });
    const second = await (await fetch(base + '/api/apps?limit=1&after=a-app')).json();
    expect(second).toMatchObject({ apps: [{ appId }], nextAfter: null });
    await register('a-app', [], true);
    expect(await (await fetch(base + '/api/apps?limit=1')).json()).toMatchObject({
      apps: [{ version: '2' }],
    });
    expect(await (await fetch(base + '/api/apps?after=zzzz')).json()).toEqual({
      apps: [],
      nextAfter: null,
    });
    expect(
      await (await fetch(base + `/api/apps?after=${encodeURIComponent(appId)}`)).json(),
    ).toEqual({ apps: [], nextAfter: null });
    expect(
      await (await fetch(base + `/api/app/${encodeURIComponent(appId)}`)).json(),
    ).toMatchObject({ appId, anchor: null });
  }, 15_000);

  it.each([
    '/api/block/-1',
    '/api/block/1.5',
    '/api/block/18446744073709551616',
    '/api/block/%E0%A4%A',
    '/api/block/0?limit=2',
    '/api/apps?limit=-1',
    '/api/apps?limit=1.5',
    '/api/apps?limit=101',
    '/api/apps?limit=',
    '/api/apps?limit=1&limit=2',
    '/api/apps?after=',
    '/api/apps?after=%FF',
    '/api/apps?after=%',
    '/api/apps?%FF=x',
    '/api/apps?peer=http://localhost',
    `/api/apps?after=${'x'.repeat(65)}`,
    `/api/apps?after=${encodeURIComponent('雪'.repeat(22))}`,
  ])('rejects invalid explorer input %s', async (path) => error(path, 400, 'INVALID_REQUEST'));

  it('distinguishes missing blocks from unavailable upstreams', async () => {
    await error('/api/block/18446744073709551615', 404, 'NOT_FOUND');
  });

  it('bounds stalled block and registry RPC reads', async () => {
    const stall = new RPC({ bootstrap: testnet.bootstrap });
    peers.push(stall);
    const server = stall.createServer();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const method of ['get_block', 'get_apps']) {
      server.respond(method, async () => {
        await pending;
        return Buffer.from(JSON.stringify({ ok: true, result: null }));
      });
    }
    await server.listen();
    const unavailable = await Gateway.start({
      nodeKey: server.publicKey!,
      bootstrap: testnet.bootstrap,
    });
    try {
      const started = performance.now();
      await Promise.all(
        ['/api/block/0', '/api/apps'].map(async (path) => {
          const response = await fetch(`http://127.0.0.1:${unavailable.port}${path}`);
          expect(response.status).toBe(503);
          expect(await response.json()).toEqual({
            code: 'UPSTREAM_UNAVAILABLE',
            error: expect.any(String),
          });
        }),
      );
      expect(performance.now() - started).toBeLessThan(6500);
    } finally {
      release();
      await unavailable.close();
    }
  }, 10_000);
});

describe('registered app-chain HTTP reads', () => {
  it.each(['.', '..'])(
    'reads dot-only app ID %s through query aliases',
    async (id) => {
      const chainId = `app:${id}`;
      await register(id, [await peer(chainId, false, testnet.bootstrap)]);
      const detail = await fetch(`${base}/api/app?appId=${id}`);
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ appId: id, anchor: null });
      for (const [suffix, expected] of [
        ['head', { ...head, chainId }],
        ['block/7', { ...block, header: { ...block.header, chainId } }],
        [`tx/${receipt.hash.toUpperCase()}`, receipt],
      ] as const) {
        const response = await fetch(`${base}/api/app/chain/${suffix}?appId=${id}`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(expected);
      }
    },
    15_000,
  );

  it('keeps literal percent IDs and the legacy chain app ID distinct from query aliases', async () => {
    await register('%2e');
    await register('chain');
    for (const [path, id] of [
      ['/api/app/%252e', '%2e'],
      ['/api/app?appId=%252e', '%2e'],
      ['/api/app/chain', 'chain'],
      ['/api/app?appId=chain', 'chain'],
    ]) {
      const response = await fetch(base + path);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ appId: id });
    }
    await error('/api/app/chain/head?appId=chain', 409, 'NO_APP_CHAIN');
    await error('/api/app/chain/chain/head', 409, 'NO_APP_CHAIN');
    await error('/api/app/chain/head?appId=unknown', 404, 'NOT_FOUND');
  }, 15_000);

  it.each([
    '',
    '?appId=',
    '?appId=.&appId=..',
    '?appId=.&%61ppId=..',
    '?appId=%',
    '?appId=%FF',
    '?appId=%E0%A4%A',
    '?appId=.&%FF=x',
    '?appId=.&peer=http://localhost',
    '?appId=' + 'x'.repeat(65),
    '?appId=' + encodeURIComponent('雪'.repeat(22)),
  ])('rejects invalid query alias selectors %s', async (query) => {
    for (const route of [
      '/api/app',
      '/api/app/chain/head',
      '/api/app/chain/block/7',
      `/api/app/chain/tx/${receipt.hash}`,
    ])
      await error(route + query, 400, 'INVALID_REQUEST');
  });

  it('validates alias reads and never submits through an alias', async () => {
    const submit = vi.spyOn(NodeRpcClient.prototype, 'submitTx');
    for (const suffix of ['block/-1', 'block/1.5', 'block/18446744073709551616', 'tx/xyz'])
      await error(`/api/app/chain/${suffix}?appId=.`, 400, 'INVALID_REQUEST');
    for (const route of ['/api/app', '/api/app/chain/head', '/api/app/chain/tx'])
      await error(`${route}?appId=.`, 404, 'NOT_FOUND', 'POST');
    await error('/api/app/chain/head/extra?appId=.', 400, 'INVALID_REQUEST');
    await error('/api/app/chain/head/extra', 404, 'NOT_FOUND');
    expect(submit).not.toHaveBeenCalled();
  });

  it('admits eight requests before registration lookup and releases timed-out slots', async () => {
    const registry = new RPC({ bootstrap: testnet.bootstrap });
    peers.push(registry);
    const server = registry.createServer();
    let release!: () => void;
    let received = 0;
    let stalled = true;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.respond('get_app', async () => {
      received++;
      if (stalled) await waiting;
      return Buffer.from(JSON.stringify({ ok: true, result: null }));
    });
    server.respond('get_apps', async () =>
      Buffer.from(
        JSON.stringify({
          ok: true,
          result: { apps: [], nextAfter: null },
        }),
      ),
    );
    await server.listen();
    const limited = await Gateway.start({
      nodeKey: server.publicKey!,
      bootstrap: testnet.bootstrap,
    });
    const origin = `http://127.0.0.1:${limited.port}`;
    const read = () => fetch(origin + '/api/app/unregistered/chain/head');
    await fetch(origin + '/api/apps');
    const pending = Array.from({ length: 8 }, read);
    try {
      for (let i = 0; i < 80 && received < 8; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(received).toBe(8);
      const busy = await read();
      expect(busy.status).toBe(503);
      expect(await busy.json()).toEqual({ code: 'BUSY', error: expect.any(String) });
      expect(received).toBe(8);
      expect((await fetch(origin + '/api/apps')).status).toBe(200);
      for (const response of await Promise.all(pending)) {
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({
          code: 'UPSTREAM_UNAVAILABLE',
          error: expect.any(String),
        });
      }
      stalled = false;
      release();
      for (let i = 0; i < 9; i++) {
        const response = await read();
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ code: 'NOT_FOUND', error: expect.any(String) });
      }
    } finally {
      stalled = false;
      release();
      await Promise.allSettled(pending);
      await limited.close();
    }
  }, 5000);

  it('does not dial an unregistered ID or accept alternate peer parameters', async () => {
    const connect = vi.spyOn(NodeRpcClient, 'connect');
    await error('/api/app/unknown/chain/head', 404, 'NOT_FOUND');
    await error(`${appPath}/head?nodeKey=${mountedKey}`, 400, 'INVALID_REQUEST');
    expect(connect).not.toHaveBeenCalled();
  });

  it('reuses the configured mounted peer for encoded slash and Unicode IDs', async () => {
    const connect = vi.spyOn(NodeRpcClient, 'connect');
    expect(await (await fetch(base + `${appPath}/head`)).json()).toEqual(head);
    expect(await (await fetch(base + `${appPath}/block/7`)).json()).toEqual(block);
    expect(
      await (await fetch(base + `${appPath}/tx/${receipt.hash.toUpperCase()}`)).json(),
    ).toEqual(receipt);
    expect(connect).not.toHaveBeenCalled();
    expect((await fetch(base + '/api/demos/hex/api/head')).status).toBe(200);
    await error('/api/app/demo/雪/chain/head', 404, 'NOT_FOUND');
  });

  it('uses the next request registration and the mount bootstrap for fallback', async () => {
    const fallback = await peer();
    await register(appId, [fallback], true);
    // The mounted peer lacks this block; fallback lives on its private DHT.
    mountedMissing = true;
    try {
      expect(await (await fetch(base + `${appPath}/block/7`)).json()).toEqual(block);
    } finally {
      mountedMissing = false;
    }
    const dynamicId = 'dynamic';
    const oldKey = await peer('app:dynamic', true, testnet.bootstrap);
    const newKey = await peer('app:dynamic', false, testnet.bootstrap);
    await register(dynamicId, [oldKey]);
    await error('/api/app/dynamic/chain/block/7', 404, 'DATA_UNAVAILABLE');
    await register(dynamicId, [newKey], true);
    expect((await fetch(base + '/api/app/dynamic/chain/block/7')).status).toBe(200);
  }, 15_000);

  it('maps empty validators and offline peers without hiding settlement registration', async () => {
    await error('/api/app/a-app/chain/head', 409, 'NO_APP_CHAIN');
    await register('offline', [randomBytes(32).toString('hex')]);
    await error('/api/app/offline/chain/head', 503, 'UPSTREAM_UNAVAILABLE');
    expect((await fetch(base + '/api/app/offline')).status).toBe(200);
    expect((await fetch(base + '/api/block/0')).status).toBe(200);
  }, 10_000);

  it.each([
    `${appPath}/block/-1`,
    `${appPath}/block/1.5`,
    `${appPath}/block/18446744073709551616`,
    `${appPath}/tx/xyz`,
    '/api/app/%FF/chain/head',
    `/api/app/${'x'.repeat(65)}/chain/head`,
  ])('rejects invalid registered reads %s', async (path) => error(path, 400, 'INVALID_REQUEST'));

  it('never treats POST or arbitrary app-chain suffixes as transaction submission', async () => {
    const submit = vi.spyOn(NodeRpcClient.prototype, 'submitTx');
    await error(`${appPath}/tx`, 404, 'NOT_FOUND', 'POST');
    await error(`${appPath}/head`, 404, 'NOT_FOUND', 'POST');
    await error(`${appPath}/head/extra`, 404, 'NOT_FOUND');
    await error(`${appPath}/tx/${receipt.hash}/extra`, 404, 'NOT_FOUND');
    expect(submit).not.toHaveBeenCalled();
  });

  it('rejects the ninth app request and releases all slots after success or failure', async () => {
    let release!: () => void;
    heldHeads = 0;
    holdHead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = Array.from({ length: 8 }, () => fetch(base + `${appPath}/head`));
    try {
      for (let i = 0; i < 80 && heldHeads < 8; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(heldHeads).toBe(8);
      await error(`${appPath}/head`, 503, 'BUSY');
    } finally {
      release();
      holdHead = undefined;
      await Promise.all(pending);
    }
    for (let i = 0; i < 9; i++) {
      await error('/api/app/unknown/chain/head', 404, 'NOT_FOUND');
      await error('/api/app/a-app/chain/head', 409, 'NO_APP_CHAIN');
      await error('/api/app/offline/chain/head', 503, 'UPSTREAM_UNAVAILABLE');
    }
    expect((await fetch(base + `${appPath}/head`)).status).toBe(200);
  });
});
