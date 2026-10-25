import { expect, it, vi } from 'vitest';
import { createBrowserWallet } from '@mordecai/wallet/browser';
import { createDemoSession } from '../web/demo-session.js';

it('shares a key-free wallet facade and invalidates it after closing or changing wallets', async () => {
  let wallet: ReturnType<typeof createBrowserWallet> | null = null;
  const send = vi.fn(async () => ({ height: 1 }));
  const session = createDemoSession(() => wallet, send);
  const changed = vi.fn();
  const unsubscribe = session.subscribe(changed);
  expect(session.getSnapshot()).toBeNull();
  wallet = createBrowserWallet();
  session.refresh();
  const player = session.getSnapshot();
  expect(player.address).toBe(wallet.address);
  expect(player).not.toHaveProperty('seed');
  expect(player).not.toHaveProperty('privateKey');
  await player.sendTransaction('', 'test', {}, 1000n);
  expect(send).toHaveBeenCalledOnce();
  wallet = null;
  session.refresh();
  expect(session.getSnapshot()).toBeNull();
  await expect(player.sendTransaction('', 'test', {}, 1000n)).rejects.toThrow(/wallet/i);
  expect(send).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenCalledTimes(2);
  unsubscribe();
});
