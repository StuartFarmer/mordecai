import { mkdir, readFile, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { assertSameOrigin, clientIp } from './request-context.js';
import { decodeTransaction, encodeTransaction } from '@mordecai/protocol';
import {
  browserAddress,
  browserTransactionHash,
  verifyBrowserTransaction,
} from '@mordecai/wallet/browser';
import {
  microblogPostId,
  verifyMicroblogPost,
  verifyMicroblogTip,
  verifyMicroblogHide,
  type SignedMicroblogPost,
  type SignedMicroblogTip,
  type SignedMicroblogHide,
} from '@mordecai/wallet/microblog';
import type { NodeRpcClient } from '@mordecai/rpc';

interface Options {
  trustRailwayProxy?: boolean;
  trustRenderProxy?: boolean;
  dir: string;
  chainId: string;
  feedId: string;
  rpc: Pick<NodeRpcClient, 'getTx' | 'getBlock'>;
}
interface Post {
  id: string;
  author: string;
  sequence: number;
  acceptedAt: string;
  envelope: SignedMicroblogPost;
}
interface Tip {
  envelope: SignedMicroblogTip;
  tx: string;
  sender: string;
  amount: string;
  status: 'pending' | 'confirmed' | 'failed';
  height?: string;
}
interface State {
  posts: Post[];
  tips: Tip[];
  hidden: string[];
  blocked: string[];
}

export class Microblog {
  private tail: Promise<unknown> = Promise.resolve();
  private state: State | null = null;
  private loading: Promise<State> | undefined;
  private closed = false;
  private resolveCursor = 0;
  private probes = new Map<string, Promise<Tip | null>>();
  private limits = new Map<string, { start: number; count: number }>();
  constructor(private readonly options: Options) {}
  private load(): Promise<State> {
    if (this.state) return Promise.resolve(this.state);
    return (this.loading ??= this.readState().catch((error) => {
      this.loading = undefined;
      throw error;
    }));
  }
  private async readState(): Promise<State> {
    try {
      const state: State = JSON.parse(await readFile(join(this.options.dir, 'feed.json'), 'utf8'));
      if (
        !Array.isArray(state.posts) ||
        !Array.isArray(state.tips) ||
        !Array.isArray(state.hidden) ||
        !Array.isArray(state.blocked)
      )
        throw new Error('Invalid microblog store');
      for (const post of state.posts) {
        this.binding(post.envelope.message);
        if (
          post.author !== verifyMicroblogPost(post.envelope) ||
          post.id !== microblogPostId(post.envelope)
        )
          throw new Error('Invalid stored post');
      }
      if (
        new Set(state.posts.map((p) => p.id)).size !== state.posts.length ||
        state.posts.some((p, i) => p.sequence !== i + 1) ||
        new Set(state.tips.map((t) => t.envelope.message.transactionHash)).size !==
          state.tips.length
      )
        throw new Error('Invalid stored feed sequence');
      for (const tip of state.tips) {
        const payment = this.payment({ envelope: tip.envelope, tx: tip.tx }, state);
        if (
          payment.sender !== tip.sender ||
          payment.amount !== tip.amount ||
          !['pending', 'confirmed', 'failed'].includes(tip.status)
        )
          throw new Error('Invalid stored payment');
      }
      this.state = state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.state = { posts: [], tips: [], hidden: [], blocked: [] };
    }
    return this.state;
  }
  private binding(message: { chainId: string; feedId: string }) {
    if (message.chainId !== this.options.chainId || message.feedId !== this.options.feedId)
      throw new Error('Wrong network or feed');
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Microblog is closed'));
    const work = this.tail.then(operation);
    this.tail = work.catch(() => {});
    return work;
  }
  private async save(state: State) {
    // shortcut: full snapshots suit a small node feed; use indexed storage before large public feeds.
    await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
    const path = join(this.options.dir, 'feed.json'),
      temporary = `${path}.tmp`;
    const file = await open(temporary, 'w', 0o600);
    try {
      await file.writeFile(JSON.stringify(state));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(this.options.dir, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    this.state = state;
  }
  private limit(key: string) {
    const now = Date.now();
    for (const [id, record] of this.limits)
      if (record.start + 60_000 <= now) this.limits.delete(id);
    const record = this.limits.get(key) ?? { start: now, count: 0 };
    if (++record.count > 30 || (this.limits.size >= 10_000 && !this.limits.has(key)))
      throw new Error('Write limit reached. Wait a minute.');
    this.limits.set(key, record);
  }
  publish(envelope: SignedMicroblogPost) {
    return this.serial(async () => {
      const author = verifyMicroblogPost(envelope),
        id = microblogPostId(envelope);
      this.binding(envelope.message);
      const state = await this.load(),
        prior = state.posts.find((p) => p.id === id);
      if (prior) {
        if (prior.author !== author) throw new Error('Post identity collision');
        return this.view(prior, state);
      }
      if (state.blocked.includes(author)) throw new Error('Address blocked by this feed operator');
      this.limit(`wallet:${author}`);
      const post = {
        id,
        author,
        sequence: state.posts.length + 1,
        acceptedAt: new Date().toISOString(),
        envelope: structuredClone(envelope),
      };
      await this.save({ ...state, posts: [...state.posts, post] });
      return this.view(post, this.state!);
    });
  }
  private payment(input: { envelope: SignedMicroblogTip; tx: string }, state: State) {
    if (
      !input ||
      Object.keys(input).sort().join() !== 'envelope,tx' ||
      typeof input.tx !== 'string' ||
      !/^(?:[a-f0-9]{2}){1,4096}$/.test(input.tx)
    )
      throw new Error('Invalid signed tip transaction');
    const sender = verifyMicroblogTip(input.envelope),
      message = input.envelope.message;
    this.binding(message);
    const post = state.posts.find((p) => p.id === message.postId);
    const tx = decodeTransaction(Buffer.from(input.tx, 'hex'));
    if (
      !post ||
      !verifyBrowserTransaction(tx) ||
      Buffer.from(encodeTransaction(tx)).toString('hex') !== input.tx ||
      browserTransactionHash(tx) !== message.transactionHash ||
      tx.chainId !== this.options.chainId ||
      browserAddress(tx.sender) !== sender ||
      tx.payload.kind !== 'transfer' ||
      browserAddress(tx.payload.to) !== post.author ||
      tx.payload.amount <= 0n ||
      sender === post.author
    )
      throw new Error(
        'Tip must be a signed payment from the attribution author to this post author',
      );
    return { sender, amount: tx.payload.amount.toString() };
  }
  addTip(input: { envelope: SignedMicroblogTip; tx: string }) {
    return this.serial(async () => {
      const state = await this.load(),
        payment = this.payment(input, state);
      const prior = state.tips.find(
        (t) => t.envelope.message.transactionHash === input.envelope.message.transactionHash,
      );
      if (prior) {
        if (
          prior.envelope.message.postId !== input.envelope.message.postId ||
          prior.tx !== input.tx
        )
          throw new Error('Transaction already attributed to another post');
        return prior;
      }
      if (
        state.hidden.includes(input.envelope.message.postId) ||
        state.blocked.includes(payment.sender)
      )
        throw new Error('Post hidden or sender blocked');
      this.limit(`wallet:${payment.sender}`);
      const tip: Tip = { ...structuredClone(input), ...payment, status: 'pending' };
      await this.save({ ...state, tips: [...state.tips, tip] });
      return tip;
    });
  }
  async resolveTips() {
    if (this.closed) return;
    await this.tail;
    const state = await this.load(),
      pending = state.tips.filter((t) => t.status === 'pending');
    if (this.resolveCursor >= pending.length) this.resolveCursor = 0;
    const batch = pending.slice(this.resolveCursor, this.resolveCursor + 10);
    this.resolveCursor += batch.length;
    // Network reads never hold the mutation queue; one stalled node must not freeze this feed.
    const checked = await Promise.all(
      batch.map(async (tip) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const hash = tip.envelope.message.transactionHash;
          let probe = this.probes.get(hash);
          if (!probe && this.probes.size >= 10) return null;
          if (!probe) {
            probe = (async (): Promise<Tip | null> => {
              this.payment({ envelope: tip.envelope, tx: tip.tx }, state);
              const receipt = await this.options.rpc.getTx(hash, { timeout: 2000 });
              if (
                !receipt ||
                receipt.hash !== hash ||
                typeof receipt.success !== 'boolean' ||
                !Number.isSafeInteger(receipt.index) ||
                receipt.index < 0 ||
                !/^\d+$/.test(receipt.height)
              )
                return null;
              const block = await this.options.rpc.getBlock(BigInt(receipt.height), {
                timeout: 2000,
              });
              if (
                !block ||
                block.header.chainId !== this.options.chainId ||
                block.header.height !== receipt.height ||
                block.txs[receipt.index] !== tip.tx
              )
                return null;
              return {
                ...tip,
                status: receipt.success ? 'confirmed' : 'failed',
                height: receipt.height,
              };
            })()
              .catch(() => null)
              .finally(() => {
                this.probes.delete(hash);
              });
            this.probes.set(hash, probe);
          }
          return await Promise.race([
            probe,
            new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), 5000);
              timer.unref();
            }),
          ]);
        } catch {
          return null;
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    if (this.closed || !checked.some(Boolean)) return;
    await this.serial(async () => {
      const latest = await this.load();
      const verified = new Map(
        checked
          .filter((tip): tip is Tip => tip !== null)
          .map((t) => [t.envelope.message.transactionHash, t]),
      );
      const tips = latest.tips.map((t) =>
        t.status === 'pending' ? (verified.get(t.envelope.message.transactionHash) ?? t) : t,
      );
      await this.save({ ...latest, tips });
    });
  }
  private view(post: Post, state: State) {
    const tips = state.tips
      .filter((t) => t.envelope.message.postId === post.id)
      .map((t) => ({
        hash: t.envelope.message.transactionHash,
        sender: t.sender,
        amount: t.amount,
        status: t.status,
        height: t.height,
      }));
    return {
      id: post.id,
      author: post.author,
      sequence: post.sequence,
      acceptedAt: post.acceptedAt,
      hidden: state.hidden.includes(post.id),
      ...(state.hidden.includes(post.id)
        ? {}
        : { text: post.envelope.message.text, envelope: post.envelope }),
      confirmedAmount: tips
        .filter((t) => t.status === 'confirmed')
        .reduce((sum, t) => sum + BigInt(t.amount), 0n)
        .toString(),
      tipCount: tips.length,
      tips: tips.slice(-50),
    };
  }
  async feed(before = Number.MAX_SAFE_INTEGER, limit = 20) {
    await this.tail;
    const state = await this.load();
    if (
      !Number.isSafeInteger(before) ||
      before < 1 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      throw new Error('Invalid feed pagination');
    const posts = state.posts
      .filter((p) => p.sequence < before && !state.hidden.includes(p.id))
      .slice(-limit)
      .reverse();
    return {
      chainId: this.options.chainId,
      feedId: this.options.feedId,
      posts: posts.map((p) => this.view(p, state)),
      next: posts.length === limit ? posts.at(-1)!.sequence : null,
    };
  }
  async post(id: string) {
    await this.tail;
    const state = await this.load(),
      post = state.posts.find((p) => p.id === id);
    if (!post) throw new Error('Post not found');
    return this.view(post, state);
  }
  hide(id: string, envelope?: SignedMicroblogHide) {
    return this.serial(async () => {
      const state = await this.load(),
        post = state.posts.find((p) => p.id === id);
      if (!post) throw new Error('Post not found');
      if (envelope) {
        this.binding(envelope.message);
        if (envelope.message.postId !== id || verifyMicroblogHide(envelope) !== post.author)
          throw new Error('Only the author can hide this post');
      }
      if (!state.hidden.includes(id)) await this.save({ ...state, hidden: [...state.hidden, id] });
    });
  }
  block(address: string) {
    return this.serial(async () => {
      const state = await this.load();
      if (!state.blocked.includes(address))
        await this.save({ ...state, blocked: [...state.blocked, address] });
    });
  }
  async close() {
    this.closed = true;
    await this.tail;
  }
  async handleRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const base = '/api/demos/microblog';
    if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return false;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    try {
      let result;
      const path = url.pathname.slice(base.length);
      if (req.method === 'GET' && (path === '' || path === '/feed'))
        result = await this.feed(
          url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined,
          url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
        );
      else if (req.method === 'GET' && /^\/posts\/[a-f0-9]{64}$/.test(path))
        result = await this.post(path.slice(7));
      else if (
        req.method === 'POST' &&
        (path === '/posts' || path === '/tips' || /^\/posts\/[a-f0-9]{64}\/hide$/.test(path))
      ) {
        assertSameOrigin(req, this.options.trustRailwayProxy);
        this.limit(`source:${clientIp(req, this.options)}`);
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 16_384) throw new Error('Request too large');
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (path.endsWith('/hide')) {
          verifyMicroblogHide(body);
          await this.hide(path.slice(7, -5), body);
          result = { hidden: true };
        } else result = path === '/posts' ? await this.publish(body) : await this.addTip(body);
      } else {
        res.statusCode = 404;
        result = { error: 'Unknown microblog route' };
      }
      res.end(JSON.stringify(result));
    } catch (error) {
      res.statusCode = 400;
      res.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : 'Invalid microblog request',
        }),
      );
    }
    return true;
  }
}
