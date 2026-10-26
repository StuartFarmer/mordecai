import { afterEach, expect, it, vi } from 'vitest';
import { loadBrowserWallet } from '@mordecai/wallet/browser';
import type { createDemoSession } from '../web/demo-session.js';

const captured = vi.hoisted(() => ({
  session: null as ReturnType<typeof createDemoSession> | null,
}));
vi.mock('../web/demos.js', async (original) => ({
  ...(await original<typeof import('../web/demos.js')>()),
  createDemoLoader: (
    _doc: unknown,
    _win: unknown,
    session: ReturnType<typeof createDemoSession>,
  ) => {
    captured.session = session;
    return vi.fn();
  },
}));

type Handler = (event?: { preventDefault(): void }) => unknown;
type Element = {
  value: string;
  textContent: string;
  hidden: boolean;
  disabled: boolean;
  events: Record<string, Handler>;
  addEventListener(name: string, fn: Handler): void;
  querySelector(): Element;
  focus(): void;
  reset(): void;
  replaceChildren(): void;
  append(): void;
};

afterEach(() => vi.unstubAllGlobals());
async function setup(uncertain = false) {
  const elements = new Map<string, Element>();
  const get = (id: string): Element => {
    if (!elements.has(id))
      elements.set(id, {
        value: '',
        textContent: '',
        hidden: false,
        disabled: false,
        events: {},
        addEventListener(name, fn) {
          this.events[name] = fn;
        },
        querySelector: () => get(`${id}-button`),
        focus() {},
        reset() {},
        replaceChildren() {},
        append() {},
      });
    return elements.get(id)!;
  };
  const submitted: string[] = [];
  let hash = '';
  let configWait: Promise<void> | null = null;
  const feedId = 'ab'.repeat(32);
  vi.stubGlobal('document', {
    getElementById: (id: string) =>
      ['explorer-content', 'apps-content'].includes(id) ? null : get(id),
    querySelectorAll: () => [],
    createElement: get,
  });
  vi.stubGlobal('window', { addEventListener: vi.fn(), confirm: () => true });
  vi.stubGlobal('setTimeout', (fn: () => void, ms: number) => {
    if (ms === 500) queueMicrotask(fn);
    return 0;
  });
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      submitted.push(JSON.parse(init.body as string).tx);
      if (uncertain) throw new Error('Response lost');
      return Response.json({ hash });
    }
    if (url.endsWith('/config')) {
      if (configWait) await configWait;
      return Response.json({ demos: { microblog: { chainId: 'test', feedId } } });
    }
    if (url.endsWith('/head')) return Response.json({ chainId: 'test' });
    if (url.includes('/api/tx/'))
      return Response.json({ hash, success: true, height: 1, fee: '100' });
    return Response.json({ balance: '10000', nonce: '0' });
  });
  vi.resetModules();
  await import('../web/wallet.js');
  get('wallet-key').value = '03'.repeat(32);
  get('wallet-load').events.submit({ preventDefault() {} });
  return {
    get,
    submitted,
    feedId,
    player: captured.session!.getSnapshot(),
    setHash: (value: string) => {
      hash = value;
    },
    pauseConfig: () => {
      let release!: () => void;
      configWait = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

it('reserves a reviewed tip without broadcasting, rejects foreign domains and revokes it on close', async () => {
  const { get, submitted, player, feedId } = await setup();
  const recipient = loadBrowserWallet('04'.repeat(32)).address;
  const draft = await player.prepareMicroblogTip(recipient, '25');
  expect(submitted).toEqual([]);
  expect(get('transfer-fields').disabled).toBe(true);
  await expect(player.sendTransaction('', 'test', {}, 1000n)).rejects.toThrow(/pending/);
  await expect(player.prepareMicroblogTip(recipient, '25')).rejects.toThrow(/pending/);
  const message = {
    version: 1,
    chainId: 'test',
    feedId,
    postId: 'cd'.repeat(32),
    transactionHash: draft.hash,
  };
  await expect(player.signMicroblogTip({ ...message, feedId: 'ef'.repeat(32) })).rejects.toThrow(
    /does not match/,
  );
  await expect(player.signMicroblogTip(message)).resolves.toHaveProperty('signature');
  await expect(player.submitMicroblogTip({ ...draft, amount: '250' })).rejects.toThrow(/expired/);
  await player.cancelMicroblogTip(draft);
  expect(get('transfer-fields').disabled).toBe(false);
  const next = await player.prepareMicroblogTip(recipient, '50');
  get('wallet-close').events.click();
  await expect(player.submitMicroblogTip(next)).rejects.toThrow(/Account closed/);
  expect(submitted).toEqual([]);
});

it('broadcasts exactly the reserved transfer and releases the coordinator on confirmation', async () => {
  const { get, submitted, player, setHash } = await setup();
  const draft = await player.prepareMicroblogTip(loadBrowserWallet('04'.repeat(32)).address, '25');
  setHash(draft.hash);
  await expect(player.submitMicroblogTip(draft)).resolves.toEqual({
    success: true,
    hash: draft.hash,
    height: 1,
    fee: '100',
  });
  expect(submitted).toEqual([draft.hex]);
  expect(get('transfer-fields').disabled).toBe(false);
  await expect(player.submitMicroblogTip(draft)).rejects.toThrow(/expired/);
});

it('signs the reviewed hash even if caller input changes during the configuration read', async () => {
  const { player, feedId, pauseConfig } = await setup();
  const draft = await player.prepareMicroblogTip(loadBrowserWallet('04'.repeat(32)).address, '25');
  const message = {
    version: 1,
    chainId: 'test',
    feedId,
    postId: 'cd'.repeat(32),
    transactionHash: draft.hash,
  };
  const release = pauseConfig();
  const signature = player.signMicroblogTip(message);
  message.transactionHash = 'ff'.repeat(32);
  release();
  expect((await signature).message.transactionHash).toBe(draft.hash);
  await player.cancelMicroblogTip(draft);
});

it.each(['cancel', 'close'])('revokes an in-flight tip signature on %s', async (action) => {
  const { player, feedId, pauseConfig, get } = await setup();
  const draft = await player.prepareMicroblogTip(loadBrowserWallet('04'.repeat(32)).address, '25');
  const release = pauseConfig();
  const signing = player.signMicroblogTip({
    version: 1,
    chainId: 'test',
    feedId,
    postId: 'cd'.repeat(32),
    transactionHash: draft.hash,
  });
  if (action === 'cancel') await player.cancelMicroblogTip(draft);
  else get('wallet-close').events.click();
  release();
  await expect(signing).rejects.toThrow(/cancelled|Account changed/);
});

it('keeps an uncertain tip pending and retries identical bytes from Wallet', async () => {
  const { get, submitted, player } = await setup(true);
  const draft = await player.prepareMicroblogTip(loadBrowserWallet('04'.repeat(32)).address, '25');
  await expect(player.submitMicroblogTip(draft)).rejects.toThrow(/Response lost/);
  expect(get('transfer-fields').disabled).toBe(true);
  await expect(
    player.prepareMicroblogTip(loadBrowserWallet('04'.repeat(32)).address, '25'),
  ).rejects.toThrow(/pending/);
  get('tx-retry').events.click();
  await vi.waitFor(() => expect(submitted).toEqual([draft.hex, draft.hex]));
});
