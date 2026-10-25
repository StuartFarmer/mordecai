import { expect, it } from 'vitest';
import { initNavigation } from '../web/navigation.js';

it('switches persistent views, supports deep links/back, and marks the active navigation item', () => {
  let change!: () => void;
  const views = ['home', 'wallet', 'faucet', 'demos/hex'].map((name) => ({
    dataset: { page: name },
    hidden: false,
    querySelector: () => ({ focus() {} }),
  }));
  const links = ['home', 'wallet', 'faucet', 'demos/hex'].map((name) => ({
    dataset: { route: name },
    attrs: {} as Record<string, string>,
    setAttribute(key: string, value: string) {
      this.attrs[key] = value;
    },
    removeAttribute(key: string) {
      delete this.attrs[key];
    },
  }));
  const doc = {
    title: '',
    querySelectorAll: (selector: string) =>
      selector === '[data-page]' ? views : selector === '[data-route]' ? links : [],
  };
  const win = {
    location: { hash: '#/wallet' },
    addEventListener: (_event: string, callback: () => void) => {
      change = callback;
    },
    scrollTo() {},
  };
  initNavigation(doc, win);
  expect(views.map((v) => v.hidden)).toEqual([true, false, true, true]);
  expect(links[1]!.attrs['aria-current']).toBe('page');
  win.location.hash = '#/';
  change();
  expect(views.map((v) => v.hidden)).toEqual([false, true, true, true]);
  expect(links[1]!.attrs['aria-current']).toBeUndefined();
  win.location.hash = '#wallet';
  change();
  expect(views[1]!.hidden).toBe(false);
  win.location.hash = '#/faucet';
  change();
  expect(views.map((v) => v.hidden)).toEqual([true, true, false, true]);
  expect(links[2]!.attrs['aria-current']).toBe('page');
  expect(doc.title).toContain('Faucet');
  win.location.hash = '#/demos/hex?room=test';
  change();
  expect(views[3]!.hidden).toBe(false);
  expect(doc.title).toContain('Hex');
  win.location.hash = '#unknown';
  change();
  expect(views[0]!.hidden).toBe(false);
});

it('opens additional demo deep links with their page title', () => {
  for (const [name, title] of [
    ['frontier', 'Frontier'],
    ['outpost', 'Outpost'],
    ['chess', 'Chess'],
  ]) {
    const page = { dataset: { page: `demos/${name}` }, hidden: true };
    const doc = {
      title: '',
      querySelectorAll: (selector: string) => (selector === '[data-page]' ? [page] : []),
    };
    initNavigation(doc, {
      location: { hash: `#/demos/${name}?room=example` },
      addEventListener() {},
    });
    expect(page.hidden).toBe(false);
    expect(doc.title).toBe(`Mordecai — ${title}`);
  }
});
