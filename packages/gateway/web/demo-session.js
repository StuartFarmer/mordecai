// Bundled demos receive a revocable transaction facade, never the wallet seed.
export function createDemoSession(getWallet, send) {
  const listeners = new Set();
  let current = null;
  let player = null;
  return {
    getSnapshot: () => player,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh() {
      const next = getWallet();
      if (next === current) return;
      current = next;
      player = next
        ? {
            address: next.address,
            publicKey: next.publicKey.slice(),
            async sendTransaction(...args) {
              if (getWallet() !== next)
                throw new Error('Wallet closed or changed. Open the current wallet to continue.');
              return send(next, ...args);
            },
          }
        : null;
      for (const listener of listeners) listener();
    },
  };
}
