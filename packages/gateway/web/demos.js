/* global fetch, AbortSignal */
export const DEMOS = {
  hex: { title: 'Hex', global: 'MordecaiHex', network: '/api/demos/hex' },
  frontier: { title: 'Frontier', global: 'MordecaiFrontier' },
  outpost: { title: 'Outpost', global: 'MordecaiOutpost', network: '/api/demos/outpost' },
  chess: { title: 'Chess', global: 'MordecaiChess' },
  microblog: { title: 'Microblog', global: 'MordecaiMicroblog' },
  bounties: { title: 'Bounties', global: 'MordecaiBounties' },
};

export function createDemoLoader(doc, win, session, fetcher = fetch) {
  const mounted = new Set();
  const loading = new Set();
  return async (route) => {
    const name = route.startsWith('demos/') ? route.slice(6) : '';
    if (!Object.hasOwn(DEMOS, name) || mounted.has(name) || loading.has(name)) return;
    const container = doc.getElementById(`${name}-demo`);
    if (!container) return;
    const demo = DEMOS[name];
    loading.add(name);
    try {
      const response = await fetcher('./api/config', {
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('Demo configuration is unavailable.');
      const config = (await response.json()).demos?.[name];
      if (!config)
        throw new Error(
          `${demo.title} is not enabled on this node. Start the node demo launcher to play.`,
        );
      if (!win[demo.global])
        await new Promise((resolve, reject) => {
          const script = doc.createElement('script');
          script.src = `./demo-assets/${name}.js`;
          script.onload = resolve;
          script.onerror = () => {
            script.remove();
            reject(new Error(`${demo.title} assets are unavailable. Run the project build.`));
          };
          doc.head.append(script);
        });
      container.textContent = '';
      win[demo.global].mount(container, { session, config });
      mounted.add(name);
    } catch (error) {
      container.textContent = error.message;
    } finally {
      loading.delete(name);
    }
  };
}
