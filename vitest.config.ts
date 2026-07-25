import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests exercise package sources directly instead of built dist output.
    alias: {
      '@mordecai/protocol': pkg('protocol'),
      '@mordecai/crypto': pkg('crypto'),
      '@mordecai/wallet': pkg('wallet'),
      '@mordecai/networking': pkg('networking'),
      '@mordecai/state': pkg('state'),
      '@mordecai/chain': pkg('chain'),
      '@mordecai/rpc': pkg('rpc'),
      '@mordecai/consensus': pkg('consensus'),
      '@mordecai/vm': pkg('vm'),
      '@mordecai/sdk': pkg('sdk'),
      '@mordecai/pear-integration': pkg('pear-integration'),
      '@mordecai/node': pkg('node'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
  },
});
