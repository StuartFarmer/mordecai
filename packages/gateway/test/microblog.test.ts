import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeTransaction } from '@mordecai/protocol';
import {
  loadBrowserWallet,
  signBrowserTransaction,
  browserTransactionHash,
} from '../../wallet/src/browser.js';
import {
  signMicroblogPost,
  signMicroblogTip,
  signMicroblogHide,
} from '../../wallet/src/microblog.js';
import { Microblog } from '../src/microblog.js';
import type { TxInfo, BlockInfo } from '@mordecai/rpc';

const author = loadBrowserWallet('11'.repeat(32)),
  reader = loadBrowserWallet('22'.repeat(32));
const binding = { chainId: 'test', feedId: '33'.repeat(32) };
const paths: string[] = [];
afterEach(async () => {
  await Promise.all(paths.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'microblog-'));
  paths.push(dir);
  let receipt: TxInfo | null = null,
    block: BlockInfo | null = null;
  const options = {
    dir,
    ...binding,
    rpc: { getTx: async () => receipt, getBlock: async () => block },
  };
  const service = new Microblog(options);
  const envelope = signMicroblogPost(author, {
    version: 1,
    ...binding,
    nonce: '44'.repeat(32),
    text: 'Public signed text',
  });
  const post = await service.publish(envelope);
  const tx = signBrowserTransaction(reader, {
    chainId: binding.chainId,
    nonce: 0n,
    maxFee: 1000n,
    payload: { kind: 'transfer', to: author.publicKey, amount: 123n },
  });
  const hex = Buffer.from(encodeTransaction(tx)).toString('hex'),
    hash = browserTransactionHash(tx);
  const tip = {
    envelope: signMicroblogTip(reader, {
      version: 1,
      ...binding,
      postId: post.id,
      transactionHash: hash,
    }),
    tx: hex,
  };
  return {
    service,
    options,
    envelope,
    post,
    tx,
    tip,
    hash,
    setReceipt: (
      r: Pick<TxInfo, 'hash' | 'height' | 'index' | 'success'>,
      b: { header: Pick<BlockInfo['header'], 'chainId' | 'height'>; txs: string[] },
    ) => {
      receipt = { fee: '1', events: [], returnData: '', ...r };
      block = {
        hash: '00'.repeat(32),
        header: {
          version: 1,
          prevHash: '',
          timestampMs: '0',
          proposer: '',
          txsRoot: '',
          stateRoot: '',
          ...b.header,
        },
        txs: b.txs,
      };
    },
  };
}
test('durable signed posts survive restart and identical retries return the same sequence', async () => {
  const f = await fixture();
  expect((await f.service.publish(f.envelope)).sequence).toBe(f.post.sequence);
  await f.service.close();
  const restarted = new Microblog(f.options);
  expect((await restarted.feed()).posts).toHaveLength(1);
  await expect(restarted.publish(signMicroblogPost(reader, f.envelope.message))).rejects.toThrow(
    'identity collision',
  );
  await expect(
    restarted.publish(
      signMicroblogPost(author, { ...f.envelope.message, feedId: '77'.repeat(32) }),
    ),
  ).rejects.toThrow();
  await restarted.close();
});
test('intents survive restart, count only exact successful indexed payments and cannot be attributed twice', async () => {
  const f = await fixture();
  await f.service.addTip(f.tip);
  expect((await f.service.feed()).posts[0].confirmedAmount).toBe('0');
  await f.service.close();
  const restarted = new Microblog(f.options);
  f.setReceipt(
    { hash: f.hash, height: '1', index: 0, success: true },
    { header: { chainId: binding.chainId, height: '1' }, txs: ['00'] },
  );
  await restarted.resolveTips();
  expect((await restarted.feed()).posts[0].confirmedAmount).toBe('0');
  f.setReceipt(
    { hash: f.hash, height: '1', index: 0, success: true },
    { header: { chainId: binding.chainId, height: '1' }, txs: [f.tip.tx] },
  );
  await restarted.resolveTips();
  await restarted.addTip(f.tip);
  expect((await restarted.feed()).posts[0].confirmedAmount).toBe('123');
  const second = await restarted.publish(
    signMicroblogPost(author, { ...f.envelope.message, nonce: '88'.repeat(32) }),
  );
  await expect(
    restarted.addTip({
      ...f.tip,
      envelope: signMicroblogTip(reader, { ...f.tip.envelope.message, postId: second.id }),
    }),
  ).rejects.toThrow();
  await restarted.close();
});
test('rejects wrong recipient, forged attribution and self tips; failed receipts never increase totals', async () => {
  const f = await fixture();
  await expect(
    f.service.addTip({ ...f.tip, envelope: signMicroblogTip(author, f.tip.envelope.message) }),
  ).rejects.toThrow();
  const wrong = signBrowserTransaction(reader, {
    ...f.tx,
    payload: { kind: 'transfer', to: reader.publicKey, amount: 123n },
  });
  await expect(
    f.service.addTip({
      tx: Buffer.from(encodeTransaction(wrong)).toString('hex'),
      envelope: signMicroblogTip(reader, {
        ...f.tip.envelope.message,
        transactionHash: browserTransactionHash(wrong),
      }),
    }),
  ).rejects.toThrow();
  await f.service.addTip(f.tip);
  f.setReceipt(
    { hash: f.hash, height: '1', index: 0, success: false },
    { header: { chainId: binding.chainId, height: '1' }, txs: [f.tip.tx] },
  );
  await f.service.resolveTips();
  expect((await f.service.feed()).posts[0].confirmedAmount).toBe('0');
  expect((await f.service.feed()).posts[0].tips[0].status).toBe('failed');
  await f.service.hide(f.post.id);
  expect((await f.service.feed()).posts).toHaveLength(0);
  expect((await f.service.post(f.post.id)).hidden).toBe(true);
  expect((await f.service.post(f.post.id)).text).toBeUndefined();
  await f.service.close();
});
test('author hide proofs are authenticated, idempotent and survive restart; blocked wallets cannot publish', async () => {
  const f = await fixture(),
    message = { version: 1 as const, ...binding, postId: f.post.id };
  await expect(f.service.hide(f.post.id, signMicroblogHide(reader, message))).rejects.toThrow(
    'Only the author',
  );
  const proof = signMicroblogHide(author, message);
  await f.service.hide(f.post.id, proof);
  await f.service.hide(f.post.id, proof);
  await expect(f.service.addTip(f.tip)).rejects.toThrow('hidden');
  await f.service.block(reader.address);
  await expect(
    f.service.publish(signMicroblogPost(reader, { ...f.envelope.message, nonce: '99'.repeat(32) })),
  ).rejects.toThrow('blocked');
  await f.service.close();
  const restarted = new Microblog(f.options);
  expect((await restarted.feed()).posts).toEqual([]);
  expect((await restarted.post(f.post.id)).envelope).toBeUndefined();
  await restarted.close();
});
test('a hung confirmation RPC cannot block feed reads, publishing or shutdown', async () => {
  const f = await fixture();
  await f.service.addTip(f.tip);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.options.rpc.getTx = () => {
    entered();
    return new Promise(() => {});
  };
  const realTimeout = setTimeout,
    realClearTimeout = clearTimeout;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  vi.useFakeTimers();
  try {
    const resolving = f.service.resolveTips();
    await started;
    const timeout = new Promise<never>((_resolve, reject) => {
      deadline = realTimeout(() => reject(new Error('Feed blocked by RPC')), 1000);
    });
    const operations = (async () => {
      expect((await f.service.feed()).posts).toHaveLength(1);
      await f.service.publish(
        signMicroblogPost(author, { ...f.envelope.message, nonce: 'aa'.repeat(32) }),
      );
      await f.service.close();
    })();
    const race = Promise.race([operations, timeout]);
    await expect(race).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(5000);
    await resolving;
  } finally {
    realClearTimeout(deadline);
    vi.useRealTimers();
  }
});
test('confirmation merges preserve posts and moderation accepted while RPC was in flight', async () => {
  const f = await fixture();
  await f.service.addTip(f.tip);
  f.setReceipt(
    { hash: f.hash, height: '1', index: 0, success: true },
    { header: { chainId: binding.chainId, height: '1' }, txs: [f.tip.tx] },
  );
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const getReceipt = f.options.rpc.getTx;
  f.options.rpc.getTx = async () => {
    entered();
    await gate;
    return getReceipt();
  };
  const resolving = f.service.resolveTips();
  await started;
  const second = await f.service.publish(
    signMicroblogPost(author, { ...f.envelope.message, nonce: 'ab'.repeat(32) }),
  );
  await f.service.hide(f.post.id);
  await f.service.block(reader.address);
  release();
  await resolving;
  expect((await f.service.feed()).posts.map((p) => p.id)).toEqual([second.id]);
  expect(await f.service.post(f.post.id)).toMatchObject({ hidden: true, confirmedAmount: '123' });
  await expect(
    f.service.publish(signMicroblogPost(reader, { ...f.envelope.message, nonce: 'ac'.repeat(32) })),
  ).rejects.toThrow('blocked');
  await f.service.close();
});
test('transport deadlines release stalled probe slots so a later healthy tip confirms', async () => {
  const f = await fixture();
  await f.service.addTip(f.tip);
  for (let nonce = 1; nonce < 10; nonce++) {
    const tx = signBrowserTransaction(reader, { ...f.tx, nonce: BigInt(nonce) });
    await f.service.addTip({
      tx: Buffer.from(encodeTransaction(tx)).toString('hex'),
      envelope: signMicroblogTip(reader, {
        ...f.tip.envelope.message,
        transactionHash: browserTransactionHash(tx),
      }),
    });
  }
  await f.service.close();
  let healthy = false;
  const laterTx = signBrowserTransaction(reader, { ...f.tx, nonce: 10n });
  const laterHash = browserTransactionHash(laterTx),
    laterHex = Buffer.from(encodeTransaction(laterTx)).toString('hex');
  const deadlines: (number | undefined)[] = [];
  const service = new Microblog({
    ...f.options,
    rpc: {
      async getTx(hash, options) {
        deadlines.push(options?.timeout);
        if (!healthy)
          return new Promise((_resolve, reject) =>
            setTimeout(() => reject(new Error('RPC timed out')), options?.timeout ?? 100_000),
          );
        return hash === laterHash
          ? { hash, height: '1', index: 0, success: true, fee: '1', events: [], returnData: '' }
          : null;
      },
      async getBlock(_height, options) {
        expect(options?.timeout).toBe(2000);
        return {
          hash: '00'.repeat(32),
          header: {
            chainId: binding.chainId,
            height: '1',
            version: 1,
            prevHash: '',
            timestampMs: '0',
            proposer: '',
            txsRoot: '',
            stateRoot: '',
          },
          txs: [laterHex],
        };
      },
    },
  });
  await service.feed();
  vi.useFakeTimers();
  try {
    const stalled = service.resolveTips();
    await vi.advanceTimersByTimeAsync(2000);
    expect(deadlines).toEqual(Array(10).fill(2000));
    await stalled;
    healthy = true;
    await service.addTip({
      tx: laterHex,
      envelope: signMicroblogTip(reader, { ...f.tip.envelope.message, transactionHash: laterHash }),
    });
    await service.resolveTips();
    expect((await service.post(f.post.id)).confirmedAmount).toBe('123');
  } finally {
    vi.useRealTimers();
    await service.close();
  }
});
