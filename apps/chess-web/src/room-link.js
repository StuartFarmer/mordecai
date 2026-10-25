export function roomFromHash(hash) {
  const [route, query = ''] = hash.split('?');
  if (route !== '#/demos/chess') return '';
  const room = new URLSearchParams(query).get('room') || '';
  return /^[a-f0-9]{64}$/.test(room) ? room : '';
}

export function roomHash(roomId = '') {
  if (roomId && !/^[a-f0-9]{64}$/.test(roomId)) throw new Error('Invalid room id');
  return `#/demos/chess${roomId ? `?room=${roomId}` : ''}`;
}

export function watchRoomLink(select, win = window) {
  const change = () => {
    const [route, query = ''] = win.location.hash.split('?');
    const params = new URLSearchParams(query);
    const explicit = route === '#/demos/chess' && (params.has('room') || params.get('new') === '1');
    select(explicit ? roomFromHash(win.location.hash) : undefined);
  };
  win.addEventListener('hashchange', change);
  return () => win.removeEventListener('hashchange', change);
}

// A checkpoint is revoked even before the hashchange event is delivered.
export function roomCheckpoint(win = window) {
  let hash = win.location.hash;
  let live = true;
  return {
    valid: () => live && hash === win.location.hash,
    revoke: () => {
      live = false;
    },
    navigate(roomId) {
      if (!live || hash !== win.location.hash) throw new Error('Room changed. Please retry.');
      hash = roomHash(roomId);
      const url = new URL(win.location.href);
      url.searchParams.delete('room');
      url.hash = hash;
      win.history.replaceState(null, '', url);
    },
  };
}
