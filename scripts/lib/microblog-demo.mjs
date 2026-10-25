import { randomBytes } from 'node:crypto';
import { setInterval, clearInterval } from 'node:timers';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Microblog } from '../../packages/gateway/dist/microblog.js';

export async function bootMicroblog({ base, rpc, chainId, trustRailwayProxy, trustRenderProxy }) {
  const dir = join(base, 'microblog');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const identity = join(dir, 'feed-id');
  try {
    const file = await open(identity, 'wx', 0o600);
    try {
      await file.writeFile(randomBytes(32).toString('hex'));
      await file.sync();
    } finally {
      await file.close();
    }
    const directory = await open(dir, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const feedId = await readFile(identity, 'utf8');
  if (!/^[a-f0-9]{64}$/.test(feedId)) throw new Error('Invalid persisted microblog feed identity');
  const feed = new Microblog({ dir, chainId, feedId, rpc, trustRailwayProxy, trustRenderProxy });
  await feed.feed();
  let resolving = false;
  const resolve = async () => {
    if (resolving) return;
    resolving = true;
    try {
      await feed.resolveTips();
    } catch (error) {
      console.error('Microblog confirmation unavailable:', error.message);
    } finally {
      resolving = false;
    }
  };
  const timer = setInterval(resolve, 3000);
  timer.unref();
  void resolve();
  return {
    config: { chainId, feedId, api: '/api/demos/microblog' },
    handleRequest: feed.handleRequest.bind(feed),
    async close() {
      clearInterval(timer);
      await feed.close();
    },
  };
}
