import { afterEach, expect, it, vi } from 'vitest';
import { createBrowserWallet } from '@mordecai/wallet/browser';
import { fetchFundingStatus } from '../src/chain.js';

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
