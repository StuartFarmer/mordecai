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
it.each([false, true])(
  'keeps the account key through registration and clears it on close (interrupted: %s)',
  async (interrupted) => {
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
    const registrations: unknown[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url === './api/accounts') {
        if (init?.method === 'POST') {
          registrations.push(JSON.parse(init.body as string));
          if (interrupted && registrations.length === 1)
            return Response.json({ error: 'Confirmation unavailable' }, { status: 503 });
          return Response.json({ status: 'confirmed' });
        }
        return Response.json({
          enabled: true,
          retryAfter: registrations.length > Number(interrupted) ? 60 : 0,
        });
      }
      if (url.startsWith('./api/accounts/')) return Response.json({ status: 'confirmed' });
      return Response.json(
        url.endsWith('/head') ? { chainId: 'test' } : { balance: '1000000', nonce: '0' },
      );
    });
    vi.resetModules();
    await import('../web/wallet.js');
    expect(get('wallet-actions').hidden).toBe(true);
    expect(get('wallet-notice').hidden).toBe(true);
    expect(get('transaction-fields').disabled).toBe(true);

    await vi.waitFor(() => expect(get('wallet-generate').disabled).toBe(false));
    get('wallet-generate').events.click();
    expect(get('wallet-start').hidden).toBe(true);
    expect(get('wallet-actions').hidden).toBe(false);
    expect(get('wallet-account').hidden).toBe(false);
    if (interrupted) {
      const key = get('wallet-private').value;
      await vi.waitFor(() => expect(get('account-registration-retry').hidden).toBe(false));
      await vi.waitFor(() => expect(get('account-registration-retry').disabled).toBe(false));
      get('account-registration-retry').events.click();
      await vi.waitFor(() => expect(registrations).toHaveLength(2));
      expect(registrations[1]).toEqual(registrations[0]);
      expect(get('wallet-private').value === key).toBe(true);
    }
    await vi.waitFor(() => expect(get('wallet-message').textContent).toContain('Account ready'));
    expect(registrations).toHaveLength(1 + Number(interrupted));
    expect(registrations[0]).toMatchObject({
      chainId: 'test',
      signature: expect.any(String),
      publicKey: expect.any(String),
    });
    expect(registrations[0]).not.toHaveProperty('privateKey');
    await vi.waitFor(() => expect(get('wallet-close').disabled).toBe(false));
    expect(get('wallet-generate').disabled).toBe(true);
    get('wallet-close').events.click();
    expect(get('wallet-actions').hidden).toBe(true);
    expect(get('wallet-start').hidden).toBe(false);

    get('wallet-key').value = '01'.repeat(32);
    get('wallet-load').events.submit({ preventDefault() {} });
    await vi.waitFor(() => expect(get('wallet-balance').textContent).toContain('1,000,000'));
    expect(registrations).toHaveLength(1 + Number(interrupted));
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
  },
);
