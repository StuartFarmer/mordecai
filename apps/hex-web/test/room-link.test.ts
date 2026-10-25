import { expect, it, vi } from 'vitest';
import { watchRoomLink } from '../src/room-link.js';
it('follows new explicit room links without resetting a room on Wallet/Faucet navigation', () => {
  let change!: () => void;
  const win = {
    location: { hash: '#/demos/hex?room=one' },
    addEventListener: (_name: string, fn: () => void) => {
      change = fn;
    },
    removeEventListener: vi.fn(),
  };
  const select = vi.fn();
  const stop = watchRoomLink(select, win);
  expect(select).toHaveBeenLastCalledWith('one');
  win.location.hash = '#/wallet';
  change();
  expect(select).toHaveBeenCalledTimes(1);
  win.location.hash = '#/demos/hex?room=two';
  change();
  expect(select).toHaveBeenLastCalledWith('two');
  stop();
  expect(win.removeEventListener).toHaveBeenCalledWith('hashchange', change);
});
