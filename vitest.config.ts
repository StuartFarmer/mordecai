import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests exercise package sources directly instead of built dist output.
    alias: {
      '@hssn/protocol': pkg('protocol'),
      '@hssn/crypto': pkg('crypto'),
      '@hssn/wallet': pkg('wallet'),
      '@hssn/networking': pkg('networking'),
      '@hssn/state': pkg('state'),
      '@hssn/chain': pkg('chain'),
      '@hssn/rpc': pkg('rpc'),
      '@hssn/consensus': pkg('consensus'),
      '@hssn/vm': pkg('vm'),
      '@hssn/node': pkg('node'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
  },
});
