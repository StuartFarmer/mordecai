import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev mode the gateway runs separately; proxy its API through so the
// app can always fetch same-origin "/api/...". The production build is
// served by the gateway itself (mordecai-gateway --static dist).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': process.env.GATEWAY_URL || 'http://127.0.0.1:8787',
    },
  },
});
