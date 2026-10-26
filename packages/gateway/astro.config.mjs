import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import { unified } from '@astrojs/markdown-remark';
import { documentationLinks } from './site/markdown.js';

const backend = process.env.MORDECAI_DEV_NODE || 'http://127.0.0.1:8790';

export default defineConfig({
  root: fileURLToPath(new URL('./site/', import.meta.url)),
  srcDir: fileURLToPath(new URL('./site/', import.meta.url)),
  outDir: fileURLToPath(new URL('./public/site/', import.meta.url)),
  output: 'static',
  build: { format: 'file' },
  integrations: [mdx()],
  markdown: { processor: unified({ remarkPlugins: [documentationLinks] }) },
  vite: {
    server: {
      proxy: {
        '/api': backend,
        '/demo-assets': backend,
        '/wallet-assets': backend,
        '/pagefind': backend,
        '/mordecai': backend,
        '/favicon.svg': backend,
      },
    },
  },
});
