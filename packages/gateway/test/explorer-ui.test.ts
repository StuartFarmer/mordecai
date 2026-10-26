import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encodeTransaction, type Payload, type Transaction } from '@mordecai/protocol';
import { browserTransactionHash } from '@mordecai/wallet/browser';
import { createExplorer } from '../web/explorer.js';

// A small DOM tree keeps browser lifecycle tests dependency-free, as in wallet-ui.test.ts.
class Element {
  children: Element[] = [];
  ownText = '';
  value = '';
  href = '';
  type = '';
  name = '';
  hidden = false;
  disabled = false;
  attrs: Record<string, string> = {};
  events: Record<string, (event: { preventDefault(): void }) => void> = {};
  constructor(public tagName: string) {}
  set textContent(text: string) {
    this.children = [];
    this.ownText = String(text);
  }
  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join('');
  }
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: Element[]) {
    this.ownText = '';
    this.children = children;
  }
  setAttribute(name: string, value: string) {
    this.attrs[name] = value;
  }
  addEventListener(name: string, fn: Element['events'][string]) {
    this.events[name] = fn;
  }
  all(tag: string): Element[] {
    return this.children.flatMap((child) => [
      ...(child.tagName === tag ? [child] : []),
      ...child.all(tag),
    ]);
  }
  fire(name: string) {
    this.events[name]?.({ preventDefault() {} });
  }
}

const key = new Uint8Array(32).fill(1);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const hash = 'ab'.repeat(32);
const app = {
  appId: 'test/app?<&',
  owner: 'owner-address',
  version: '1.0',
  pearKey: hex(key),
  contractAddress: hex(key),
  metadataHash: hex(key),
  chainValidators: [hex(key)],
  anchor: { appId: 'test/app?<&', epoch: '3', appHeight: '80', stateRoot: hash },
};
function tx(payload: Payload, chainId = 'settlement'): Transaction {
  return {
    chainId,
    sender: key,
    nonce: 18446744073709551615n,
    maxFee: 18446744073709551615n,
    payload,
    signature: new Uint8Array(64),
  };
}
function block(height: string, txs: Transaction[] = [], chainId = 'settlement') {
  return {
    hash,
    header: {
      version: 1,
      chainId,
      height,
      prevHash: hash,
      timestampMs: '1700000000000',
      proposer: 'yryonyebyryonyebyryonyebyryonyebyryonyebyryonyebyryo',
      txsRoot: hash,
      stateRoot: hash,
    },
    txs: txs.map((value) => hex(encodeTransaction(value))),
  };
}
function receipt(transaction: Transaction, extra = {}) {
  return {
    hash: browserTransactionHash(transaction),
    height: '42',
    index: 1,
    success: true,
    fee: '18446744073709551615',
    events: ['abcd'],
    returnData: 'cafe',
    ...extra,
  };
}
const controllers: ReturnType<typeof createExplorer>[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  controllers.forEach((controller) => controller.close());
  controllers.length = 0;
  vi.useRealTimers();
});
async function flush() {
  for (let i = 0; i < 80; i++) await Promise.resolve();
}
function setup(route: string, respond: (url: string, init: RequestInit) => unknown = () => ({})) {
  const explorer = new Element('section');
  const apps = new Element('section');
  const events: Record<string, () => void> = {};
  const doc = {
    hidden: false,
    createElement: (tag: string) => new Element(tag),
    getElementById: (id: string) => (id === 'explorer-content' ? explorer : apps),
    addEventListener: (name: string, fn: () => void) => {
      events[name] = fn;
    },
  };
  const win = { location: { hash: `#/${route}` } };
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const result = await respond(url, init);
    return result instanceof Response ? result : Response.json(result);
  });
  const controller = createExplorer(doc, win, fetcher);
  controllers.push(controller);
  const open = (next = route) => {
    win.location.hash = `#/${next}`;
    controller.open(next.split('?')[0]);
  };
  open();
  return { explorer, apps, doc, win, fetcher, controller, open, events };
}
const head = (height = '9', chainId = 'settlement') => ({
  height,
  chainId,
  headHash: hash,
  stateRoot: hash,
  timestampMs: '1700000000000',
});

it('is inert without explorer containers', () => {
  const fetcher = vi.fn();
  const controller = createExplorer({ getElementById: () => null }, {}, fetcher);
  controller.open('explorer');
  controller.close();
  expect(fetcher).not.toHaveBeenCalled();
});

it('shows ten descending blocks including genesis and limits block concurrency to two', async () => {
  let active = 0;
  let peak = 0;
  const releases: (() => void)[] = [];
  const ui = setup('explorer', (url) => {
    if (url.endsWith('/head')) return head();
    active++;
    peak = Math.max(peak, active);
    return new Promise((resolve) =>
      releases.push(() => {
        active--;
        resolve(block(url.split('/').at(-1)!));
      }),
    );
  });
  await flush();
  expect(releases).toHaveLength(2);
  for (let i = 0; i < 5; i++) {
    releases.splice(0).forEach((release) => release());
    await flush();
  }
  expect(peak).toBe(2);
  expect(ui.explorer.all('table')[0].attrs.tabindex).toBe('0');
  expect(
    ui.explorer
      .all('tbody')[0]
      .all('tr')
      .map((row) => row.all('a')[0].textContent),
  ).toEqual(['9', '8', '7', '6', '5', '4', '3', '2', '1', '0']);
  expect(ui.explorer.textContent).toContain('Settlement (L0)');
});

it('uses exclusive older pagination and preserves app IDs in every block link', async () => {
  const ui = setup(`explorer?app=${encodeURIComponent(app.appId)}&before=12`, (url) =>
    url.endsWith('/head')
      ? head('20', `app:${app.appId}`)
      : block(url.split('/').at(-1)!, [], `app:${app.appId}`),
  );
  await flush();
  const heights = ui.explorer
    .all('tbody')[0]
    .all('tr')
    .map((row) => row.all('a')[0].textContent);
  expect(heights).toEqual(['11', '10', '9', '8', '7', '6', '5', '4', '3', '2']);
  for (const link of ui.explorer.all('a')) {
    expect(new URLSearchParams(link.href.split('?')[1]).get('app')).toBe(app.appId);
  }
  expect(
    ui.explorer
      .all('a')
      .some((link) => new URLSearchParams(link.href.split('?')[1]).get('before') === '2'),
  ).toBe(true);
  expect(
    ui.fetcher.mock.calls.every(([url]) =>
      url.includes(`/app/${encodeURIComponent(app.appId)}/chain/`),
    ),
  ).toBe(true);
});

it.each([
  'height=-1',
  'height=18446744073709551616',
  'tx=nope',
  'height=1&tx=' + hash,
  'before=2&height=1',
  'height=1&height=2',
  'app=',
  'app=' + 'é'.repeat(33),
])('rejects invalid or conflicting query selectors: %s', async (query) => {
  const ui = setup(`explorer?${query}`);
  await flush();
  expect(ui.explorer.textContent).toMatch(/invalid|choose|conflict|only one/i);
  expect(ui.fetcher).not.toHaveBeenCalled();
});

it('requires the explicit lookup type and validates values before navigating', async () => {
  const ui = setup('explorer?height=0', () => block('0'));
  await flush();
  const form = ui.explorer.all('form')[0];
  const input = form.all('input')[0];
  const select = form.all('select')[0];
  select.value = 'height';
  input.value = hash;
  form.fire('submit');
  expect(ui.win.location.hash).toBe('#/explorer?height=0');
  expect(ui.explorer.textContent).toMatch(/height/i);
  select.value = 'tx';
  input.value = hash.toUpperCase();
  form.fire('submit');
  expect(ui.win.location.hash).toBe(`#/explorer?tx=${hash}`);
});

it('renders registry cursor links and labels demos only when config appId matches', async () => {
  const malicious = '<img src=x onerror=alert(1)>';
  const ui = setup('apps', (url) =>
    url === './api/config'
      ? { demos: { hex: { appId: 'different' }, chess: { appId: app.appId } } }
      : { apps: [app, { ...app, appId: malicious, chainValidators: [] }], nextAfter: malicious },
  );
  await flush();
  expect(ui.apps.textContent).toContain('Chess');
  expect(ui.apps.textContent).not.toContain('Hex');
  expect(ui.apps.textContent).toContain(malicious);
  expect(ui.apps.textContent).toContain('No app chain');
  expect(ui.apps.all('img')).toHaveLength(0);
  expect(
    ui.apps
      .all('a')
      .some((link) => new URLSearchParams(link.href.split('?')[1]).get('after') === malicious),
  ).toBe(true);
  expect(ui.fetcher.mock.calls.some(([url]) => url === './api/apps?limit=50')).toBe(true);
});

it.each(['no validators', 'no anchor', 'offline', 'missing history'])(
  'keeps app registration and settlement details visible with %s',
  async (condition) => {
    const ui = setup(`apps?app=${encodeURIComponent(app.appId)}`, (url) => {
      if (url === './api/config') return { demos: {} };
      if (url.endsWith('/chain/head'))
        return Response.json(
          {
            error:
              condition === 'missing history'
                ? 'Data unavailable from reachable peers'
                : 'App peers unavailable',
          },
          { status: condition === 'missing history' ? 404 : 503 },
        );
      return {
        ...app,
        chainValidators: condition === 'no validators' ? [] : app.chainValidators,
        anchor: condition === 'no anchor' ? null : app.anchor,
      };
    });
    await flush();
    expect(ui.apps.textContent).toContain(app.appId);
    expect(ui.apps.textContent).toContain('owner-address');
    expect(ui.apps.textContent).toContain(
      condition === 'no anchor' ? 'No anchor yet' : 'Last anchored height',
    );
    expect(ui.apps.textContent).toContain(
      condition === 'no validators'
        ? 'No app chain'
        : condition === 'missing history'
          ? 'Data unavailable from reachable peers'
          : 'App peers unavailable',
    );
    if (condition === 'no validators')
      expect(ui.fetcher.mock.calls.some(([url]) => url.endsWith('/chain/head'))).toBe(false);
  },
);

const record = {
  appId: app.appId,
  pearKey: key,
  version: '1',
  contractAddress: key,
  metadataHash: key,
  chainValidators: [key],
};
const payloads: Payload[] = [
  { kind: 'transfer', to: key, amount: 18446744073709551615n },
  { kind: 'deploy_contract', code: new Uint8Array([0, 97, 115, 109]) },
  {
    kind: 'execute_contract',
    contract: key,
    action: '<action>',
    args: new Uint8Array([0xab]),
    value: 18446744073709551615n,
  },
  { kind: 'register_app', ...record },
  { kind: 'update_app', ...record },
  {
    kind: 'anchor',
    appId: app.appId,
    epoch: 18446744073709551615n,
    appHeight: 18446744073709551615n,
    stateRoot: key,
    call: { contract: key, action: '<call>', args: new Uint8Array([0xcd]) },
    signatures: [{ validator: key, signature: new Uint8Array(64).fill(2) }],
  },
];
it.each(payloads)(
  'decodes $kind from the receipt height/index with exact u64 fields',
  async (payload) => {
    const transaction = tx(payload);
    const id = browserTransactionHash(transaction);
    const ui = setup(`explorer?tx=${id}`, (url) =>
      url.includes('/tx/')
        ? receipt(transaction, { success: payload.kind !== 'anchor' })
        : block('42', [tx({ kind: 'transfer', to: key, amount: 1n }), transaction]),
    );
    await flush();
    expect(ui.explorer.textContent).toContain(payload.kind);
    expect(ui.explorer.textContent).toContain('18446744073709551615');
    expect(ui.explorer.textContent).toContain('CAI base units');
    expect(ui.explorer.textContent).toContain('abcd');
    expect(ui.explorer.textContent).toContain('cafe');
    expect(ui.fetcher.mock.calls.map(([url]) => url)).toEqual([`./api/tx/${id}`, './api/block/42']);
    if (payload.kind === 'anchor') {
      expect(ui.explorer.textContent).toMatch(/not accepted/i);
      expect(ui.explorer.textContent).toContain('02020202');
      expect(ui.explorer.textContent).toContain('<call>');
      expect(
        ui.explorer
          .all('a')
          .some((link) => new URLSearchParams(link.href.split('?')[1]).get('app') === app.appId),
      ).toBe(true);
    }
  },
);

it('labels app-chain amounts and uses app-scoped transaction and block URLs', async () => {
  const transaction = tx(payloads[0], `app:${app.appId}`);
  const id = browserTransactionHash(transaction);
  const ui = setup(`explorer?app=${encodeURIComponent(app.appId)}&tx=${id}`, (url) =>
    url.includes('/tx/')
      ? receipt(transaction, { index: 0 })
      : block('42', [transaction], `app:${app.appId}`),
  );
  await flush();
  expect(ui.explorer.textContent).toContain('app-chain base units');
  expect(ui.explorer.textContent).not.toContain('CAI base units');
  expect(
    ui.fetcher.mock.calls.every(([url]) =>
      url.startsWith(`./api/app/${encodeURIComponent(app.appId)}/chain/`),
    ),
  ).toBe(true);
});

it.each(['.', '..', '%2e', 'chain', app.appId])(
  'preserves app ID %s through actual URL parsing for every app read',
  async (id) => {
    const chainId = `app:${id}`;
    const transaction = tx(payloads[0], chainId);
    const txId = browserTransactionHash(transaction);
    const selectedIds: string[] = [];
    const respond = (value: string) => {
      const url = new URL(value, 'https://gateway.example/');
      if (url.pathname === '/api/config') return {};
      const pathMatch = url.pathname.match(/^\/api\/app\/([^/]+)(?:\/chain\/(.*))?$/);
      const aliasSuffix =
        url.pathname === '/api/app' ? '' : url.pathname.slice('/api/app/chain/'.length);
      const selectedId = url.searchParams.has('appId')
        ? url.searchParams.get('appId')!
        : pathMatch
          ? decodeURIComponent(pathMatch[1])
          : '';
      const suffix = url.searchParams.has('appId') ? aliasSuffix : pathMatch?.[2] || '';
      selectedIds.push(selectedId);
      if (selectedId !== id)
        return Response.json({ error: 'App ID lost during URL parsing' }, { status: 404 });
      if (!suffix) return { ...app, appId: id };
      if (suffix === 'head') return head('0', chainId);
      if (suffix.startsWith('block/')) return block(suffix.slice(6), [transaction], chainId);
      if (suffix === `tx/${txId}`) return receipt(transaction, { index: 0 });
      return Response.json({ error: 'Invalid app read URL' }, { status: 404 });
    };
    const query = `app=${encodeURIComponent(id)}`;
    const ui = setup(`apps?${query}`, respond);
    await flush();
    expect(ui.apps.textContent).toContain('owner-address');
    expect(ui.apps.textContent).toContain('Live app height');
    ui.open(`explorer?${query}`);
    await flush();
    expect(ui.explorer.all('tbody')[0]?.all('tr')).toHaveLength(1);
    ui.open(`explorer?${query}&height=42`);
    await flush();
    expect(ui.explorer.textContent).toContain('Block 42');
    expect(ui.explorer.textContent).toContain('transfer');
    ui.open(`explorer?${query}&tx=${txId}`);
    await flush();
    expect(ui.explorer.textContent).toContain('Maximum fee');
    expect(ui.explorer.textContent).toContain('app-chain base units');
    expect(selectedIds).toEqual(Array(7).fill(id));
  },
);

it('rejects a decoded transaction hash mismatch', async () => {
  const transaction = tx(payloads[0]);
  const ui = setup(`explorer?tx=${hash}`, (url) =>
    url.includes('/tx/') ? receipt(transaction, { hash, index: 0 }) : block('42', [transaction]),
  );
  await flush();
  expect(ui.explorer.textContent).toMatch(/hash.*match/i);
  expect(ui.explorer.textContent).not.toContain('Maximum fee');
});

it('retains a receipt when the containing block body is unavailable', async () => {
  const transaction = tx(payloads[0]);
  const id = browserTransactionHash(transaction);
  const ui = setup(`explorer?tx=${id}`, (url) =>
    url.includes('/tx/')
      ? receipt(transaction)
      : Response.json({ error: 'Data unavailable from reachable peers' }, { status: 404 }),
  );
  await flush();
  expect(ui.explorer.textContent).toContain('18446744073709551615');
  expect(ui.explorer.textContent).toMatch(/body.*unavailable/i);
  expect(ui.explorer.textContent).not.toContain('pending');
});

it('polls only latest views every five seconds and fetches only new block heights', async () => {
  let height = '9';
  const ui = setup('explorer', (url) =>
    url.endsWith('/head') ? head(height) : block(url.split('/').at(-1)!),
  );
  await flush();
  await vi.advanceTimersByTimeAsync(4999);
  expect(ui.fetcher).toHaveBeenCalledTimes(11);
  await vi.advanceTimersByTimeAsync(1);
  await flush();
  expect(ui.fetcher).toHaveBeenCalledTimes(12);
  height = '10';
  await vi.advanceTimersByTimeAsync(5000);
  await flush();
  expect(ui.fetcher).toHaveBeenCalledTimes(14);
  expect(ui.explorer.all('tbody')[0].all('tr')[0].all('a')[0].textContent).toBe('10');
  ui.open('explorer?height=0');
  await flush();
  const count = ui.fetcher.mock.calls.length;
  await vi.advanceTimersByTimeAsync(15000);
  expect(ui.fetcher).toHaveBeenCalledTimes(count);
});

it('aborts hidden and navigated reads, ignores late results and refreshes on return', async () => {
  let release!: (value: unknown) => void;
  const ui = setup('explorer?app=old', (url) =>
    url.includes('/old/')
      ? new Promise((resolve) => {
          release = resolve;
        })
      : url.endsWith('/head')
        ? head('0')
        : block('0'),
  );
  await flush();
  const oldSignal = ui.fetcher.mock.calls[0][1].signal!;
  ui.open('explorer');
  await flush();
  expect(oldSignal.aborted).toBe(true);
  release(head('99', 'app:old'));
  await flush();
  expect(ui.explorer.textContent).not.toContain('app:old');
  ui.open('explorer?app=old');
  await flush();
  const hiddenSignal = ui.fetcher.mock.calls.at(-1)![1].signal!;
  ui.doc.hidden = true;
  ui.events.visibilitychange();
  expect(hiddenSignal.aborted).toBe(true);
  const count = ui.fetcher.mock.calls.length;
  await vi.advanceTimersByTimeAsync(20000);
  expect(ui.fetcher).toHaveBeenCalledTimes(count);
  ui.doc.hidden = false;
  ui.events.visibilitychange();
  await flush();
  expect(ui.fetcher.mock.calls.length).toBeGreaterThan(count);
  const navigatedSignal = ui.fetcher.mock.calls.at(-1)![1].signal!;
  ui.controller.open('account');
  expect(navigatedSignal.aborted).toBe(true);
});

it('turns a ten-second stalled fetch into a retryable error', async () => {
  const ui = setup('explorer', () => new Promise(() => {}));
  await vi.advanceTimersByTimeAsync(10000);
  await flush();
  expect(ui.explorer.textContent).toMatch(/timed out/i);
  expect(ui.fetcher.mock.calls[0][1].signal!.aborted).toBe(true);
  const retry = ui.explorer.all('button').find((button) => /retry/i.test(button.textContent));
  expect(retry).toBeDefined();
  retry!.fire('click');
  await flush();
  expect(ui.fetcher).toHaveBeenCalledTimes(2);
});

it.each(['explorer?before=1', 'explorer?height=0', 'apps', 'apps?app=test'])(
  'does not poll the immutable or directory view %s',
  async (route) => {
    const ui = setup(route, (url) => {
      if (url === './api/config') return { demos: {} };
      if (url.startsWith('./api/apps?')) return { apps: [], nextAfter: null };
      if (url === './api/app/test') return { ...app, appId: 'test', chainValidators: [] };
      if (url.endsWith('/head')) return head('0');
      return block('0');
    });
    await flush();
    const count = ui.fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15000);
    expect(ui.fetcher).toHaveBeenCalledTimes(count);
  },
);

it('requests the registry page after an encoded cursor and rejects oversized page limits', async () => {
  const ui = setup(`apps?after=${encodeURIComponent(app.appId)}&limit=100`, (url) =>
    url === './api/config' ? {} : { apps: [], nextAfter: null },
  );
  await flush();
  const url = ui.fetcher.mock.calls.find(([value]) => value.startsWith('./api/apps?'))![0];
  const params = new URLSearchParams(url.split('?')[1]);
  expect(params.get('after')).toBe(app.appId);
  expect(params.get('limit')).toBe('100');
  const count = ui.fetcher.mock.calls.length;
  ui.open('apps?limit=101');
  await flush();
  expect(ui.apps.textContent).toMatch(/invalid.*limit/i);
  expect(ui.fetcher).toHaveBeenCalledTimes(count);
});

it('shows matching block transactions without fetching every receipt', async () => {
  const transaction = tx(payloads[0]);
  const ui = setup('explorer?height=42', () => block('42', [transaction]));
  await flush();
  expect(ui.explorer.textContent).toContain('yryonyebyryonyebyryonyebyryonyebyryonyebyryonyebyryo');
  expect(ui.explorer.textContent).toContain('transfer');
  expect(ui.explorer.all('tbody')[0].all('tr')).toHaveLength(1);
  expect(ui.explorer.all('a')[0].href).toBe(`#/explorer?tx=${browserTransactionHash(transaction)}`);
  expect(ui.fetcher.mock.calls.map(([url]) => url)).toEqual(['./api/block/42']);
});

it('reports wrong-chain app results without rendering their blocks', async () => {
  const ui = setup('explorer?app=test', () => head('0', 'app:other'));
  await flush();
  expect(ui.explorer.textContent).toMatch(/chain ID.*match/i);
  expect(ui.explorer.all('table')).toHaveLength(0);
  expect(ui.fetcher).toHaveBeenCalledTimes(1);
});

it('recovers live polling after repeated errors without rereading unchanged blocks or accumulating alerts', async () => {
  let failing = false;
  let latest = '0';
  const ui = setup('explorer', (url) => {
    if (!url.endsWith('/head')) return block(url.split('/').at(-1)!);
    return failing
      ? Response.json({ error: 'Temporary peer outage' }, { status: 503 })
      : head(latest);
  });
  await flush();
  failing = true;
  await vi.advanceTimersByTimeAsync(5000);
  expect(ui.explorer.textContent).toContain('Temporary peer outage');
  expect(ui.explorer.all('tbody')[0].all('tr')).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(5000);
  expect(
    ui.explorer.all('p').filter((node) => node.textContent === 'Temporary peer outage'),
  ).toHaveLength(1);
  failing = false;
  await vi.advanceTimersByTimeAsync(5000);
  expect(ui.explorer.textContent).not.toContain('Temporary peer outage');
  expect(ui.fetcher.mock.calls.filter(([url]) => url.includes('/block/'))).toHaveLength(1);
  latest = '1';
  await vi.advanceTimersByTimeAsync(5000);
  expect(ui.explorer.all('tbody')[0].all('tr')[0].all('a')[0].textContent).toBe('1');
  expect(ui.fetcher.mock.calls.filter(([url]) => url.includes('/block/'))).toHaveLength(2);
  failing = true;
  await vi.advanceTimersByTimeAsync(5000);
  ui.doc.hidden = true;
  ui.events.visibilitychange();
  const count = ui.fetcher.mock.calls.length;
  await vi.advanceTimersByTimeAsync(15000);
  expect(ui.fetcher).toHaveBeenCalledTimes(count);
  expect(vi.getTimerCount()).toBe(0);
  ui.doc.hidden = false;
  ui.events.visibilitychange();
  await flush();
  ui.controller.close();
  expect(vi.getTimerCount()).toBe(0);
});

it('retries an initially missing recent block on the next live poll', async () => {
  let missing = true;
  const ui = setup('explorer', (url) =>
    url.endsWith('/head')
      ? head('0')
      : missing
        ? Response.json({ error: 'Block briefly unavailable' }, { status: 503 })
        : block('0'),
  );
  await flush();
  expect(ui.explorer.textContent).toContain('Block briefly unavailable');
  missing = false;
  await vi.advanceTimersByTimeAsync(5000);
  expect(ui.explorer.textContent).not.toContain('Block briefly unavailable');
  expect(ui.explorer.all('tbody')[0].all('tr')[0].all('a')[0].textContent).toBe('0');
});

it('evicts earlier page summaries even when each advancing page has an unavailable block', async () => {
  let latest = '9';
  let missing = true;
  const ui = setup('explorer', (url) => {
    if (url.endsWith('/head')) return head(latest);
    const at = url.split('/').at(-1)!;
    return missing && at === latest
      ? Response.json({ error: 'Head block unavailable' }, { status: 503 })
      : block(at);
  });
  await flush();
  latest = '19';
  await vi.advanceTimersByTimeAsync(5000);
  latest = '29';
  await vi.advanceTimersByTimeAsync(5000);
  // A restored head must load the old page again, since failed reads still evict old pages.
  latest = '9';
  missing = false;
  await vi.advanceTimersByTimeAsync(5000);
  expect(ui.fetcher.mock.calls.filter(([url]) => url === './api/block/0')).toHaveLength(2);
  expect(ui.explorer.all('tbody')[0].all('tr')).toHaveLength(10);
  expect(ui.explorer.textContent).not.toContain('Head block unavailable');
});

it.each([true, false])(
  'scopes app-chain anchor acceptance to its chain (success: %s)',
  async (success) => {
    const transaction = tx(payloads[5], 'app:outer');
    const id = browserTransactionHash(transaction);
    const ui = setup(`explorer?app=outer&tx=${id}`, (url) =>
      url.includes('/tx/')
        ? receipt(transaction, { success, index: 0 })
        : block('42', [transaction], 'app:outer'),
    );
    await flush();
    expect(ui.explorer.textContent).toContain(
      success ? 'Anchor accepted by app chain: outer' : 'app-chain transaction failed',
    );
    expect(ui.explorer.textContent).not.toMatch(/settlement/i);
  },
);

it.each(payloads.filter((payload) => 'appId' in payload))(
  'does not link an app-chain $kind payload to a settlement registry entry with the same ID',
  async (payload) => {
    const transaction = tx(payload, 'app:outer');
    const id = browserTransactionHash(transaction);
    const ui = setup(`explorer?app=outer&tx=${id}`, (url) =>
      url.includes('/tx/')
        ? receipt(transaction, { index: 0 })
        : block('42', [transaction], 'app:outer'),
    );
    await flush();
    expect(ui.explorer.textContent).toContain(app.appId);
    expect(ui.explorer.all('a').some((link) => link.href.startsWith('#/apps'))).toBe(false);
  },
);
