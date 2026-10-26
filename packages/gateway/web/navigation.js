/* global document, window */
import { DEMOS } from './demos.js';
export function initNavigation(doc = document, win = window, onChange = () => {}) {
  const pages = [...doc.querySelectorAll('[data-page]')];
  if (!pages.length) return;
  const links = [...doc.querySelectorAll('[data-route]')];
  function render(focus = false) {
    const hash = win.location.hash.replace(/^#\/?/, '').split('?')[0];
    const requested = ['wallet', 'faucet'].includes(hash) ? 'account' : hash;
    const route =
      pages.find((page) => page.dataset.page === requested)?.dataset.page ?? pages[0].dataset.page;
    for (const page of pages) {
      page.hidden = page.dataset.page !== route;
      if (!page.hidden && focus) page.querySelector('h1').focus();
    }
    for (const link of links) {
      if (link.dataset.route === route) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    const title = route.startsWith('demos/')
      ? DEMOS[route.slice(6)]?.title
      : {
          home: 'Node',
          account: 'Account',
          'about/manifesto': 'Manifesto',
          'about/design': 'Design',
        }[route];
    doc.title = `Mordecai — ${title ?? 'Node'}`;
    for (const menu of doc.querySelectorAll('nav details')) menu.open = false;
    onChange(route);
    if (focus) win.scrollTo(0, 0);
  }
  win.addEventListener('hashchange', () => render(true));
  render();
}
