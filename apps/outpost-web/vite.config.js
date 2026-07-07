import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev mode proxies the L1 gateway; the app-chain gateway URL comes from
// /api/config (appApi) and is called cross-origin (the gateway sends
// permissive CORS). Production is served by the L1 gateway itself.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': process.env.GATEWAY_URL || 'http://127.0.0.1:8787',
    },
  },
});
