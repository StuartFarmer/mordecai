import { expect, it, vi } from 'vitest';
import { initNavigation } from '../web/navigation.js';

it('switches persistent views, supports deep links/back, and marks the active navigation item', () => {
  let change!: () => void;
  const views = ['home', 'account', 'about/design', 'demos/hex'].map((name) => ({
    dataset: { page: name },
    hidden: false,
    querySelector: () => ({ focus() {} }),
  }));
  const links = ['home', 'account', 'about/design', 'demos/hex'].map((name) => ({
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
  expect(views.map((v) => v.hidden)).toEqual([true, false, true, true]);
  expect(links[1]!.attrs['aria-current']).toBe('page');
  expect(doc.title).toContain('Account');
  win.location.hash = '#/demos/hex?room=test';
  change();
  expect(views[3]!.hidden).toBe(false);
  expect(doc.title).toContain('Hex');
  win.location.hash = '#unknown';
  change();
  expect(views[0]!.hidden).toBe(false);
});

it('opens demo and About deep links with their page title', () => {
  for (const [route, title] of [
    ['demos/frontier', 'Frontier'],
    ['demos/outpost', 'Outpost'],
    ['demos/chess', 'Chess'],
    ['about/manifesto', 'Manifesto'],
    ['about/design', 'Design'],
  ]) {
    const page = { dataset: { page: route }, hidden: true };
    const doc = {
      title: '',
      querySelectorAll: (selector: string) => (selector === '[data-page]' ? [page] : []),
    };
    initNavigation(doc, {
      location: { hash: `#/${route}?room=example` },
      addEventListener() {},
    });
    expect(page.hidden).toBe(false);
    expect(doc.title).toBe(`Mordecai — ${title}`);
  }
});

it('opens explorer deep links and forwards query-only history changes with focus and titles', () => {
  const views = ['home', 'explorer', 'apps', 'account', 'demos/hex'].map((route) => ({
    dataset: { page: route },
    hidden: true,
    heading: { focus: vi.fn() },
    querySelector() {
      return this.heading;
    },
  }));
  const links = views.map((page) => ({
    dataset: { route: page.dataset.page },
    attrs: {} as Record<string, string>,
    setAttribute(key: string, value: string) {
      this.attrs[key] = value;
    },
    removeAttribute(key: string) {
      delete this.attrs[key];
    },
  }));
  let change!: () => void;
  const win = {
    location: { hash: '#/explorer?app=hex&height=42' },
    addEventListener: (_name: string, callback: () => void) => (change = callback),
    scrollTo: vi.fn(),
  };
  const doc = {
    title: '',
    querySelectorAll: (selector: string) =>
      selector === '[data-page]' ? views : selector === '[data-route]' ? links : [],
  };
  const visits: string[] = [];
  initNavigation(doc, win, (route) => visits.push(`${route}:${win.location.hash}`));
  expect(views[1]!.hidden).toBe(false);
  expect(doc.title).toBe('Mordecai — Explorer');
  expect(links[1]!.attrs['aria-current']).toBe('page');

  for (const [hash, route, title] of [
    ['#/explorer?app=hex&tx=' + 'ab'.repeat(32), 'explorer', 'Explorer'],
    ['#/apps?app=hex', 'apps', 'Apps'],
    ['#/apps?app=outpost', 'apps', 'Apps'],
    // Browser back/forward dispatches hashchange with the restored query intact.
    ['#/apps?app=hex', 'apps', 'Apps'],
    ['#/apps?app=outpost', 'apps', 'Apps'],
    ['#/explorer?height=42', 'explorer', 'Explorer'],
    ['#/wallet', 'account', 'Account'],
    ['#/faucet', 'account', 'Account'],
    ['#/demos/hex?room=invite%2Froom', 'demos/hex', 'Hex'],
  ]) {
    win.location.hash = hash!;
    change();
    const current = views.find((view) => view.dataset.page === route)!;
    expect(current.hidden).toBe(false);
    expect(current.heading.focus).toHaveBeenCalled();
    expect(doc.title).toBe(`Mordecai — ${title}`);
    expect(links.filter((link) => link.attrs['aria-current'] === 'page')).toEqual([
      links.find((link) => link.dataset.route === route),
    ]);
    expect(visits.at(-1)).toBe(`${route}:${hash}`);
  }
  expect(visits).toHaveLength(10);
});
