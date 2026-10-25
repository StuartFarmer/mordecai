import { afterEach, expect, it, vi } from 'vitest';

type Handler = (event?: { preventDefault(): void }) => void;
interface MockElement {
  value: string;
  textContent: string;
  hidden: boolean;
  disabled?: boolean;
  type?: string;
  events: Record<string, Handler>;
  addEventListener(name: string, fn: Handler): void;
  querySelector(): MockElement;
  focus(): void;
  reset(): void;
  replaceChildren(): void;
}

// Minimal DOM for exercising the real wallet entry's lifecycle, without a browser dependency.
afterEach(() => vi.unstubAllGlobals());
it('shows actions only for an open wallet and clears its draft when closed', async () => {
  const elements = new Map<string, MockElement>();
  const get = (id: string): MockElement => {
    if (!elements.has(id))
      elements.set(id, {
        value: '',
        textContent: '',
        hidden: ['wallet-account', 'tx-review'].includes(id),
        events: {} as Record<string, Handler>,
        addEventListener(name: string, fn: Handler) {
          this.events[name] = fn;
        },
        querySelector() {
          return get(`${id}-button`);
        },
        focus: vi.fn(),
        reset: vi.fn(),
        replaceChildren: vi.fn(),
      });
    return elements.get(id)!;
  };
  vi.stubGlobal('document', { getElementById: get, querySelectorAll: () => [] });
  vi.stubGlobal('window', { addEventListener: vi.fn(), confirm: () => true });
  vi.stubGlobal('setTimeout', () => 0);
  vi.stubGlobal('fetch', async (url: string) =>
    Response.json(url.endsWith('/head') ? { chainId: 'test' } : { balance: '10000', nonce: '0' }),
  );
  vi.resetModules();
  await import('../web/wallet.js');
  expect(get('wallet-actions').hidden).toBe(true);
  expect(get('wallet-notice').hidden).toBe(true);
  expect(get('transaction-fields').disabled).toBe(true);

  get('wallet-generate').events.click();
  expect(get('wallet-start').hidden).toBe(true);
  expect(get('wallet-actions').hidden).toBe(false);
  expect(get('wallet-account').hidden).toBe(false);
  await vi.waitFor(() => expect(get('wallet-balance').textContent).toContain('10,000'));
  get('wallet-close').events.click();
  expect(get('wallet-actions').hidden).toBe(true);
  expect(get('wallet-start').hidden).toBe(false);

  get('wallet-key').value = '01'.repeat(32);
  get('wallet-load').events.submit({ preventDefault() {} });
  await vi.waitFor(() => expect(get('wallet-balance').textContent).toContain('10,000'));
  expect(get('wallet-actions').hidden).toBe(false);
  get('transfer-to').value = get('wallet-address').textContent;
  get('transfer-amount').value = '100';
  get('transfer-form').events.submit({ preventDefault() {} });
  await vi.waitFor(() => expect(get('tx-review').hidden).toBe(false));
  get('wallet-close').events.click();
  expect(get('wallet-start').hidden).toBe(false);
  expect(get('wallet-account').hidden).toBe(true);
  expect(get('wallet-actions').hidden).toBe(true);
  expect(get('wallet-private').value).toBe('');
  expect(get('tx-review').hidden).toBe(true);
  expect(get('tx-summary').textContent).toBe('');
  expect(get('transaction-form').reset).toHaveBeenCalled();
  expect(get('transfer-form').reset).toHaveBeenCalled();
  expect(get('wallet-generate').focus).toHaveBeenCalled();
});
