import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: fileURLToPath(new URL('./public/wallet-assets', import.meta.url)),
    emptyOutDir: true,
    lib: {
      entry: fileURLToPath(new URL('./web/wallet.js', import.meta.url)),
      name: 'MordecaiWallet',
      formats: ['iife'],
      fileName: () => 'wallet.js',
    },
  },
});
