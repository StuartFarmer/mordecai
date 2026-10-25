import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

function page(enabled = true, claimOk = true, confirmed = true) {
  let submit: (event: { preventDefault(): void }) => Promise<void>;
  const elements = Object.fromEntries(
    ['faucet-form', 'faucet-fields', 'faucet-address', 'faucet-message', 'faucet-tx'].map((id) => [
      id,
      {
        textContent: '',
        disabled: true,
        hidden: true,
        value: 'recipient-address',
        href: '',
        addEventListener: (_event: string, handler: typeof submit) => {
          submit = handler;
        },
      },
    ]),
  );
  const fetch = vi.fn(async (url: string) => {
    if (url === './api/faucet' && fetch.mock.calls.length === 1)
      return { ok: true, json: async () => ({ enabled, amount: '10000', cooldownSeconds: 60 }) };
    if (url.startsWith('./api/tx/'))
      return {
        ok: confirmed,
        status: confirmed ? 200 : 404,
        json: async () => ({ success: true }),
      };
    return {
      ok: claimOk,
      json: async () =>
        claimOk
          ? { hash: 'ab'.repeat(32), amount: '10000', status: 'submitted' }
          : { error: 'Please wait before requesting more test CAI.' },
    };
  });
  runInNewContext(readFileSync(new URL('../public/faucet.js', import.meta.url), 'utf8'), {
    document: { getElementById: (id: string) => elements[id] },
    fetch,
    AbortSignal,
    setTimeout: (fn: () => void) => fn(),
  });
  return { elements, fetch, submit: () => submit({ preventDefault() {} }) };
}

it('keeps an unconfigured faucet disabled', async () => {
  const { elements, fetch, submit } = page(false);
  await vi.waitFor(() => expect(elements['faucet-message']!.textContent).toContain('not enabled'));
  await submit();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(elements['faucet-fields']!.disabled).toBe(true);
});

it('submits only an address, exposes the receipt, and confirms the transfer', async () => {
  const { elements, fetch, submit } = page();
  await vi.waitFor(() => expect(elements['faucet-fields']!.disabled).toBe(false));
  await submit();
  expect(fetch.mock.calls[1]).toMatchObject([
    './api/faucet',
    { method: 'POST', body: JSON.stringify({ address: 'recipient-address' }) },
  ]);
  expect(elements['faucet-message']!.textContent).toContain('confirmed');
  expect(elements['faucet-tx']!.href).toBe(`./api/tx/${'ab'.repeat(32)}`);
  expect(elements['faucet-tx']!.hidden).toBe(false);
  expect(elements['faucet-fields']!.disabled).toBe(false);
});

it('shows rate-limit errors and restores the form', async () => {
  const { elements, submit } = page(true, false);
  await vi.waitFor(() => expect(elements['faucet-fields']!.disabled).toBe(false));
  await submit();
  expect(elements['faucet-message']!.textContent).toContain('Please wait');
  expect(elements['faucet-tx']!.hidden).toBe(true);
  expect(elements['faucet-fields']!.disabled).toBe(false);
});

it('does not describe an unconfirmed transaction as paid', async () => {
  const { elements, submit } = page(true, true, false);
  await vi.waitFor(() => expect(elements['faucet-fields']!.disabled).toBe(false));
  await submit();
  expect(elements['faucet-message']!.textContent).toContain('awaiting confirmation');
  expect(elements['faucet-tx']!.hidden).toBe(false);
});
