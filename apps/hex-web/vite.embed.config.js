import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: fileURLToPath(new URL('../../packages/gateway/public/demo-assets', import.meta.url)),
    emptyOutDir: true,
    lib: {
      entry: fileURLToPath(new URL('./src/embed.jsx', import.meta.url)),
      name: 'MordecaiHex',
      formats: ['iife'],
      fileName: () => 'hex.js',
    },
  },
});
