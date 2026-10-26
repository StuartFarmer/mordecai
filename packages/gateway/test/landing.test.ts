import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { initNavigation } from '../web/navigation.js';

it('makes the built-in explorer and app directory reachable through focusable site sections', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const views = [
    ...html.matchAll(/<section\b([^>]*\bdata-page="([^"]+)"[^>]*)>([\s\S]*?)<\/section>/g),
  ].map(([, attrs, route, body]) => ({
    dataset: { page: route },
    hidden: /\bhidden\b/.test(attrs!),
    body: body!,
    querySelector: () => ({ focus: vi.fn() }),
  }));
  const links = [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*data-route="([^"]+)"[^>]*>/g)].map(
    ([, href, route]) => ({
      href: href!,
      dataset: { route },
      setAttribute() {},
      removeAttribute() {},
    }),
  );
  for (const route of ['explorer', 'apps']) {
    const link = links.find((item) => item.dataset.route === route);
    expect(link).toBeDefined();
    const doc = {
      title: '',
      querySelectorAll: (selector: string) =>
        selector === '[data-page]' ? views : selector === '[data-route]' ? links : [],
    };
    initNavigation(doc, { location: { hash: link!.href }, addEventListener() {} });
    const current = views.filter((view) => !view.hidden);
    expect(current.map((view) => view.dataset.page)).toEqual([route]);
    expect(current[0]!.body).toMatch(/<h1\b[^>]*tabindex="-1"/);
    expect(current[0]!.body).toContain(`id="${route}-content"`);
  }
});

it('updates the readout, clears stale data on failure, and recovers on the next poll', async () => {
  const elements = Object.fromEntries(
    ['status', 'chain-id', 'height', 'head-hash', 'last-checked'].map((id) => [
      id,
      { textContent: '', dataset: { state: '' } },
    ]),
  );
  let response = {
    chainId: '<img src=x onerror=alert(1)>',
    height: '9007199254740993',
    headHash: 'ab'.repeat(32),
    stateRoot: 'cd'.repeat(32),
    timestampMs: '1750000000000',
  };
  let available = true;
  let poll: () => Promise<void>;
  runInNewContext(readFileSync(new URL('../public/mordecai.js', import.meta.url), 'utf8'), {
    document: { getElementById: (id: string) => elements[id] },
    AbortSignal,
    fetch: async () => ({ ok: available, json: async () => response }),
    setTimeout: (callback: typeof poll, delay: number) => {
      expect(delay).toBe(1000);
      poll = callback;
    },
  });
  await vi.waitFor(() => expect(elements.status!.dataset.state).toBe('reachable'));
  // Untrusted labels stay plain text, and heights retain precision beyond Number.MAX_SAFE_INTEGER.
  expect(elements['chain-id']!.textContent).toBe('<img src=x onerror=alert(1)>');
  expect(elements.height!.textContent.replace(/\D/g, '')).toBe('9007199254740993');
  expect(elements['head-hash']!.textContent).toBe('ab'.repeat(32));

  available = false;
  await poll!();
  expect(elements.status!.dataset.state).toBe('unavailable');
  expect(elements['head-hash']!.textContent).toBe('—');

  available = true;
  response = { ...response, height: 'not a height' };
  await poll!();
  expect(elements.status!.dataset.state).toBe('unavailable');

  response = { ...response, chainId: 'mordecai-dev-1', height: '42' };
  await poll!();
  expect(elements.status!.dataset.state).toBe('reachable');
  expect(elements.height!.textContent).toBe('42');
});
