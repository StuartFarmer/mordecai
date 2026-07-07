import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev mode proxies the L1 gateway; the app-chain gateway and faucet are
// reached by port (from /api/config) on the same host the page was loaded
// from, so a second player on another machine works out of the box.
// Production is served by the L1 gateway itself.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': process.env.GATEWAY_URL || 'http://127.0.0.1:8787',
    },
  },
});
