import RPC from '@hyperswarm/rpc';
import { randomBytes } from 'node:crypto';
import createTestnet from 'hyperdht/testnet';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  NodeRpcClient,
  type AppInfo,
  type BlockInfo,
  type HeadInfo,
  type TxInfo,
} from '@mordecai/rpc';
import { AppReadError, readAppChain } from '../src/explorer.js';

const app: AppInfo = {
  appId: 'peers-test',
  owner: '',
  pearKey: '',
  version: '1',
  contractAddress: '',
  metadataHash: '',
  chainValidators: [],
};
const head: HeadInfo = {
  chainId: 'app:peers-test',
  height: '7',
  headHash: '11'.repeat(32),
  stateRoot: '22'.repeat(32),
  timestampMs: '1000',
};
const block: BlockInfo = {
  hash: head.headHash,
  header: {
    version: 1,
    chainId: head.chainId,
    height: '7',
    prevHash: '00'.repeat(32),
    timestampMs: '1000',
    proposer: '',
    txsRoot: '00'.repeat(32),
    stateRoot: head.stateRoot,
  },
  txs: [],
};
const tx: TxInfo = {
  hash: '33'.repeat(32),
  height: '7',
  index: 0,
  success: true,
  fee: '1',
  events: [],
  returnData: '',
};
let testnet: Awaited<ReturnType<typeof createTestnet>>;
let peers: RPC[] = [];

beforeAll(async () => {
  testnet = await createTestnet(3);
}, 15_000);
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(peers.map((rpc) => rpc.destroy()));
  peers = [];
});
afterAll(async () => {
  await testnet?.destroy();
});

async function peer(
  options: {
    chainId?: string;
    block?: BlockInfo | null;
    tx?: TxInfo | null;
    headDelay?: number;
    itemDelay?: number;
    failHead?: boolean;
  } = {},
) {
  const rpc = new RPC({ bootstrap: testnet.bootstrap });
  peers.push(rpc);
  const server = rpc.createServer();
  const requests: string[] = [];
  for (const [method, result, delay] of [
    ['get_head', { ...head, chainId: options.chainId ?? head.chainId }, options.headDelay],
    ['get_block', options.block ?? null, options.itemDelay],
    ['get_tx', options.tx ?? null, options.itemDelay],
  ] as const) {
    server.respond(method, async () => {
      requests.push(method);
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      return Buffer.from(
        JSON.stringify(
          method === 'get_head' && options.failHead
            ? { ok: false, error: 'unavailable head' }
            : { ok: true, result },
        ),
      );
    });
  }
  await server.listen();
  return { key: Buffer.from(server.publicKey!).toString('hex'), requests };
}
const entry = (...keys: string[]): AppInfo => ({ ...app, chainValidators: keys });
const options = () => ({ bootstrap: testnet.bootstrap });

describe('registered app peer reads', () => {
  it('borrows a mounted client and keeps it usable after reading', async () => {
    const mountedPeer = await peer({ block });
    const mounted = NodeRpcClient.connect(Buffer.from(mountedPeer.key, 'hex'), options());
    const close = vi.spyOn(mounted, 'close');
    try {
      expect(await readAppChain(app, { kind: 'head' }, { ...options(), mounted })).toEqual(head);
      expect(
        await readAppChain(app, { kind: 'block', height: 7n }, { ...options(), mounted }),
      ).toEqual(block);
      expect(close).not.toHaveBeenCalled();
      expect(await mounted.getHead()).toEqual(head);
    } finally {
      await mounted.close();
    }
  });

  it('tries the second validator when the first key is offline', async () => {
    const healthy = await peer();
    const close = vi.spyOn(NodeRpcClient.prototype, 'close');
    expect(
      await readAppChain(
        entry(randomBytes(32).toString('hex'), healthy.key),
        { kind: 'head' },
        options(),
      ),
    ).toEqual(head);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('rejects a wrong-chain head before requesting data and closes dynamic clients', async () => {
    const wrong = await peer({ chainId: 'app:another', block });
    const healthy = await peer({ block });
    const close = vi.spyOn(NodeRpcClient.prototype, 'close');
    expect(
      await readAppChain(entry(wrong.key, healthy.key), { kind: 'block', height: 7n }, options()),
    ).toEqual(block);
    expect(wrong.requests).toEqual(['get_head']);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('retries a missing transaction on another registered validator', async () => {
    const missing = await peer();
    const healthy = await peer({ tx });
    expect(
      await readAppChain(entry(missing.key, healthy.key), { kind: 'tx', hash: tx.hash }, options()),
    ).toEqual(tx);
    expect(missing.requests).toEqual(['get_head', 'get_tx']);
  });

  it('falls back from a mounted peer with missing data without closing it', async () => {
    const missing = await peer();
    const healthy = await peer({ block });
    const mounted = NodeRpcClient.connect(Buffer.from(missing.key, 'hex'), options());
    const close = vi.spyOn(mounted, 'close');
    try {
      expect(
        await readAppChain(
          entry(healthy.key),
          { kind: 'block', height: 7n },
          { ...options(), mounted },
        ),
      ).toEqual(block);
      expect(close).not.toHaveBeenCalled();
    } finally {
      await mounted.close();
    }
  });

  it('leaves a timed-out mounted client open while falling back to registered validators', async () => {
    const slow = await peer({ headDelay: 1500 });
    const healthy = await peer();
    const mounted = NodeRpcClient.connect(Buffer.from(slow.key, 'hex'), options());
    const close = vi.spyOn(mounted, 'close');
    try {
      expect(
        await readAppChain(entry(healthy.key), { kind: 'head' }, { ...options(), mounted }),
      ).toEqual(head);
      expect(close).not.toHaveBeenCalled();
      expect(await mounted.getHead({ timeout: 2000 })).toEqual(head);
    } finally {
      await mounted.close();
    }
  });

  it('returns null when a matching peer responds but all attempted peers lack the item', async () => {
    const missing = await peer();
    const wrong = await peer({ chainId: 'settlement' });
    expect(
      await readAppChain(entry(missing.key, wrong.key), { kind: 'block', height: 99n }, options()),
    ).toBeNull();
  });

  it('reports unavailable and closes clients when every head fails', async () => {
    const wrong = await peer({ chainId: 'settlement' });
    const failing = await peer({ failHead: true });
    const close = vi.spyOn(NodeRpcClient.prototype, 'close');
    await expect(
      readAppChain(entry(wrong.key, failing.key), { kind: 'head' }, options()),
    ).rejects.toMatchObject({
      name: 'AppReadError',
      code: 'UPSTREAM_UNAVAILABLE',
    });
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('caps the entire head plus item attempt before trying the next validator', async () => {
    const slow = await peer({
      headDelay: 650,
      itemDelay: 650,
      block: { ...block, hash: '44'.repeat(32) },
    });
    const healthy = await peer({ block });
    const started = performance.now();
    expect(
      await readAppChain(entry(slow.key, healthy.key), { kind: 'block', height: 7n }, options()),
    ).toEqual(block);
    expect(performance.now() - started).toBeLessThan(1600);
  });

  it('fails within the deadline and closes clients when all validators are offline', async () => {
    const connect = vi.spyOn(NodeRpcClient, 'connect');
    const close = vi.spyOn(NodeRpcClient.prototype, 'close');
    const started = performance.now();
    await expect(
      readAppChain(
        entry(...Array.from({ length: 8 }, () => randomBytes(32).toString('hex'))),
        { kind: 'head' },
        options(),
      ),
    ).rejects.toBeInstanceOf(AppReadError);
    expect(performance.now() - started).toBeLessThan(5700);
    expect(close).toHaveBeenCalledTimes(connect.mock.calls.length);
  }, 10_000);

  it('shares a five-second budget across stalled validator heads', async () => {
    const stalled = await Promise.all(Array.from({ length: 8 }, () => peer({ headDelay: 1500 })));
    const connect = vi.spyOn(NodeRpcClient, 'connect');
    const close = vi.spyOn(NodeRpcClient.prototype, 'close');
    const started = performance.now();
    await expect(
      readAppChain(entry(...stalled.map(({ key }) => key)), { kind: 'head' }, options()),
    ).rejects.toBeInstanceOf(AppReadError);
    expect(performance.now() - started).toBeLessThan(5700);
    expect(connect.mock.calls.length).toBeLessThanOrEqual(5);
    expect(close).toHaveBeenCalledTimes(connect.mock.calls.length);
  }, 10_000);
});
