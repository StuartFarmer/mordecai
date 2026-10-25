/* global document, window */
export function initNavigation(doc = document, win = window) {
  const pages = [...doc.querySelectorAll('[data-page]')];
  if (!pages.length) return;
  const links = [...doc.querySelectorAll('[data-route]')];
  function render(focus = false) {
    const requested = win.location.hash.replace(/^#\/?/, '');
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
    doc.title = `Mordecai — ${{ home: 'Node', wallet: 'Wallet', faucet: 'Faucet' }[route]}`;
    if (focus) win.scrollTo(0, 0);
  }
  win.addEventListener('hashchange', () => render(true));
  render();
}
