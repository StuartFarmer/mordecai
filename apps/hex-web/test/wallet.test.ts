import { afterEach, expect, it, vi } from 'vitest';
import { createBrowserWallet } from '@mordecai/wallet/browser';
import { fetchFundingStatus, requestFunds, play } from '../src/chain.js';

afterEach(() => vi.unstubAllGlobals());

it('requests app-chain fees even when an imported wallet already has enough L1 CAI', async () => {
  const wallet = createBrowserWallet();
  const fetch = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => ({ balance: url.startsWith('http://app') ? '0' : '10000000' }),
  }));
  vi.stubGlobal('fetch', fetch);
  expect(await fetchFundingStatus(wallet, { appApi: 'http://app' })).toEqual({
    balance: 10000000,
    needsFunds: true,
  });
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    `/api/account/${wallet.address}`,
    `http://app/api/account/${wallet.address}`,
  ]);
  fetch.mockImplementation(async () => ({ ok: true, json: async () => ({ balance: '10000000' }) }));
  expect(await fetchFundingStatus(wallet, { appApi: 'http://app' })).toEqual({
    balance: 10000000,
    needsFunds: false,
  });
});

it('uses the mounted app faucet without automatically topping up L1', async () => {
  const player = createBrowserWallet();
  const fetch = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => ({ balance: url.startsWith('/api/demos') ? '10000000' : '0' }),
  }));
  vi.stubGlobal('fetch', fetch);
  const config = {
    appApi: '/api/demos/hex',
    appFaucet: '/api/demos/hex/api/faucet',
    manualFunding: true,
  };
  expect(await fetchFundingStatus(player, config)).toEqual({ balance: 0, needsFunds: false });
  await requestFunds(config, player);
  expect(fetch.mock.calls.at(-1)?.[0]).toBe('/api/demos/hex/api/faucet');
});

it('uses the supplied wallet transaction facade for embedded moves', async () => {
  const player = { address: 'public-only', sendTransaction: vi.fn(async () => ({ height: 3 })) };
  const result = await play(
    player,
    { appApi: '/api/demos/hex', appChainId: 'app:hex', hex: '01'.repeat(32) },
    { create: { game_id: 9n } },
  );
  expect(result).toEqual({ height: 3 });
  expect(player.sendTransaction).toHaveBeenCalledWith(
    '/api/demos/hex',
    'app:hex',
    expect.objectContaining({ kind: 'execute_contract', action: 'create' }),
    500000n,
  );
});
