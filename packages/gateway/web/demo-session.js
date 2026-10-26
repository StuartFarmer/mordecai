// Bundled demos receive a revocable transaction facade, never the wallet seed.
export function createDemoSession(getWallet, send, signChess, microblog = {}) {
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
                throw new Error('Account closed or changed. Open the current account to continue.');
              return send(next, ...args);
            },
            async signChessMessage(message) {
              if (getWallet() !== next)
                throw new Error('Account closed or changed. Open the current account to continue.');
              if (!signChess) throw new Error('Chess signing is unavailable.');
              return signChess(next, message);
            },
            ...Object.fromEntries(
              Object.entries(microblog).map(([name, action]) => [
                name,
                async (...args) => {
                  if (getWallet() !== next)
                    throw new Error(
                      'Account closed or changed. Open the current account to continue.',
                    );
                  return action(next, ...args);
                },
              ]),
            ),
          }
        : null;
      for (const listener of listeners) listener();
    },
  };
}
