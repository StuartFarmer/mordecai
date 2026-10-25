import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import App from '../src/App.jsx';
import { afterEach, expect, it, vi } from 'vitest';
import { act, connect, validAmount, validAddress } from '../src/chain.js';

afterEach(() => vi.unstubAllGlobals());
it('routes embedded actions through the wallet facade without fetching a nonce', async () => {
  const sendTransaction = vi.fn().mockResolvedValue({ height: 7, fee: '42' });
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(
    act(
      { sendTransaction },
      { chainId: 'shared', contract: 'ab'.repeat(32) },
      { claim_tile: { tile_id: 0 } },
    ),
  ).resolves.toMatchObject({ height: 7, gasUsed: '42' });
  expect(sendTransaction).toHaveBeenCalledWith(
    '',
    'shared',
    expect.objectContaining({ action: 'claim_tile', value: 0n }),
    500000n,
  );
  expect(fetch).not.toHaveBeenCalled();
});
it('rejects unsafe numeric amounts and malformed recipients before signing', async () => {
  for (const n of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(validAmount(n)).toBe(false);
  expect(validAmount(1)).toBe(true);
  expect(validAddress('abc')).toBe(false);
  const sendTransaction = vi.fn();
  for (const msg of [
    { place_order: { give: 'wood', give_amount: 1.5, want: 'wheat', want_amount: 1 } },
    { transfer_tile: { tile_id: 0, to: 'bad' } },
    { claim_tile: { tile_id: 144 } },
  ])
    await expect(act({ sendTransaction }, { contract: 'ab'.repeat(32) }, msg)).rejects.toThrow();
  expect(sendTransaction).not.toHaveBeenCalled();
});
it('requires a loaded wallet', async () => {
  await expect(act(null, {}, { claim_tile: { tile_id: 0 } })).rejects.toThrow(/wallet/i);
});

it('shows Wallet when disconnected and the supplied wallet instead of development identities', () => {
  const config = { chainId: 'shared', contract: 'ab'.repeat(32) };
  const session = (player) => ({ subscribe: () => () => {}, getSnapshot: () => player });
  expect(
    renderToStaticMarkup(
      React.createElement(App, { session: session(null), initialConfig: config }),
    ),
  ).toContain('href="#wallet"');
  const html = renderToStaticMarkup(
    React.createElement(App, {
      session: session({ address: 'wallet-address-123456789' }),
      initialConfig: config,
    }),
  );
  expect(html).toContain('Manage wallet');
  expect(html).not.toContain('player-btn');
  expect(html).toContain('Faucet');
  expect(html).toContain('Waiting alone');
});

it('preserves standalone development signing and confirms receipts', async () => {
  const player = connect({}, { name: 'alice', seed: '01'.repeat(32) });
  expect(validAddress(player.address)).toBe(true);
  const fetch = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ nonce: '0', balance: '500000' }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ hash: 'tx' }) })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true, height: '1', fee: '5' }),
    });
  vi.stubGlobal('fetch', fetch);
  await expect(
    act(player, { chainId: 'dev', contract: 'ab'.repeat(32) }, { claim_tile: { tile_id: 0 } }),
  ).resolves.toEqual({ height: 1, gasUsed: '5' });
  expect(JSON.parse(fetch.mock.calls[1][1].body).tx).toMatch(/^[0-9a-f]+$/);
});
