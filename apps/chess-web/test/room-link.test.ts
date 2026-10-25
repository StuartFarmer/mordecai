import { describe, expect, it } from 'vitest';
import { roomFromHash, roomHash, watchRoomLink, roomCheckpoint } from '../src/room-link.js';
const a = 'ab'.repeat(32),
  b = 'cd'.repeat(32);
function browser(hash = '#/demos/chess') {
  const win = new EventTarget();
  win.location = new URL(`https://node.test/${hash}`);
  win.history = {
    replaceState(_state, _title, url) {
      win.location = new URL(url);
    },
  };
  win.navigate = (hash) => {
    win.location.hash = hash;
    win.dispatchEvent(new Event('hashchange'));
  };
  return win;
}
describe('Chess SPA rooms', () => {
  it('accepts only bounded room ids in the Chess hash query', () => {
    expect(roomFromHash(roomHash(a))).toBe(a);
    expect(roomFromHash('#/demos/chess')).toBe('');
    expect(roomFromHash(`#/wallet?room=${a}`)).toBe('');
    expect(roomFromHash('#/demos/chess?room=../wallet')).toBe('');
    expect(roomFromHash('#/demos/chess?room=' + a.toUpperCase())).toBe('');
    expect(() => roomHash('../wallet')).toThrow();
  });
  it('selects a new invite and clears room state on New room without reloading', () => {
    const win = browser(roomHash(a));
    let room = roomFromHash(win.location.hash),
      selected = 'e2',
      pending = {},
      error = 'old';
    const stop = watchRoomLink((id) => {
      if (id === undefined) return;
      room = id;
      selected = '';
      pending = null;
      error = '';
    }, win);
    win.navigate(roomHash(b));
    expect(room).toBe(b);
    win.navigate('#/wallet');
    win.navigate('#/demos/chess');
    expect(room).toBe(b);
    win.navigate('#/demos/chess?new=1');
    expect({ room, selected, pending, error }).toEqual({
      room: '',
      selected: '',
      pending: null,
      error: '',
    });
    stop();
    win.navigate(roomHash(a));
    expect(room).toBe('');
  });
  it('discards pending responses after navigation, close, or unmount', async () => {
    const win = browser(roomHash(a));
    const scope = roomCheckpoint(win);
    let resolve;
    const pending = new Promise((done) => {
      resolve = done;
    });
    const result = pending.then(() => (scope.valid() ? 'apply old room' : 'discard'));
    // Hash updates revoke a response even before hashchange delivery.
    win.location.hash = roomHash(b);
    resolve();
    expect(await result).toBe('discard');
    const closed = roomCheckpoint(win);
    closed.revoke();
    expect(closed.valid()).toBe(false);
    expect(() => closed.navigate(a)).toThrow();
  });
  it('retains a recoverable invitation during uncertain creation without reloading', () => {
    const win = browser();
    const scope = roomCheckpoint(win);
    scope.navigate(a);
    expect(win.location.hash).toBe(roomHash(a));
    expect(scope.valid()).toBe(true);
    win.navigate(roomHash());
    expect(scope.valid()).toBe(false);
    // Old completion cannot navigate back or trigger a second room creation.
    expect(() => scope.navigate(a)).toThrow();
  });
});
