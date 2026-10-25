import { expect, it, vi } from 'vitest';
import { createDemoLoader } from '../web/demos.js';

it('loads each known demo once and passes only its config and wallet session', async () => {
  const containers = new Map<string, { textContent: string }>();
  const scripts: string[] = [];
  const mount = vi.fn();
  const win: Record<string, { mount: typeof mount }> = {};
  const doc = {
    getElementById(id: string) {
      if (!containers.has(id)) containers.set(id, { textContent: '' });
      return containers.get(id);
    },
    createElement: () => ({ src: '', onload() {} }),
    head: {
      append(script: { src: string; onload(): void }) {
        scripts.push(script.src);
        const name = script.src.split('/').at(-1)!.split('.')[0]!;
        win['Mordecai' + name[0]!.toUpperCase() + name.slice(1)] = { mount };
        script.onload();
      },
    },
  };
  const session = { getSnapshot: () => null };
  const fetcher = vi.fn(async () =>
    Response.json({
      demos: {
        hex: { chainId: 'test' },
        frontier: { contract: 'frontier' },
        outpost: { contract: 'outpost' },
        chess: { contract: 'chess' },
        microblog: { feedId: 'feed' },
        bounties: { contract: 'bounties' },
      },
    }),
  );
  const open = createDemoLoader(doc, win, session, fetcher);
  for (const name of ['hex', 'frontier', 'outpost', 'chess', 'microblog', 'bounties']) {
    await Promise.all([open(`demos/${name}`), open(`demos/${name}`)]);
    await open(`demos/${name}`);
  }
  expect(scripts).toEqual([
    './demo-assets/hex.js',
    './demo-assets/frontier.js',
    './demo-assets/outpost.js',
    './demo-assets/chess.js',
    './demo-assets/microblog.js',
    './demo-assets/bounties.js',
  ]);
  expect(mount).toHaveBeenCalledTimes(6);
  expect(mount).toHaveBeenLastCalledWith(containers.get('bounties-demo'), {
    session,
    config: { contract: 'bounties' },
  });
  await open('demos/unknown');
  expect(fetcher).toHaveBeenCalledTimes(6);
});

it('shows an unavailable demo and permits retry after configuration is enabled', async () => {
  const container = { textContent: '' };
  const doc = {
    getElementById: () => container,
    createElement: () => ({ onload() {} }),
    head: {
      append(s: { onload(): void }) {
        s.onload();
      },
    },
  };
  const mount = vi.fn();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ demos: {} }))
    .mockResolvedValueOnce(Response.json({ demos: { frontier: { contract: 'ready' } } }));
  const open = createDemoLoader(doc, { MordecaiFrontier: { mount } }, {}, fetcher);
  await open('demos/frontier');
  expect(container.textContent).toMatch(/Frontier is not enabled/);
  expect(mount).not.toHaveBeenCalled();
  await open('demos/frontier');
  expect(mount).toHaveBeenCalledOnce();
});
