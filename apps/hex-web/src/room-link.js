export function watchRoomLink(select, win = window) {
  const change = () => {
    if (!win.location.hash.startsWith('#/demos/hex?')) return;
    const code = new URLSearchParams(win.location.hash.split('?')[1]).get('room')?.trim();
    if (code && code.length <= 64) select(code);
  };
  win.addEventListener('hashchange', change);
  change();
  return () => win.removeEventListener('hashchange', change);
}
