import { mkdirSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
for (const args of [
  [
    'packages/gateway/node_modules/astro/bin/astro.mjs',
    'build',
    '--config',
    'packages/gateway/astro.config.mjs',
  ],
  [
    'packages/gateway/node_modules/pagefind/lib/runner/bin.cjs',
    '--site',
    'packages/gateway/public/site',
  ],
  ['scripts/check-site.mjs'],
]) {
  if (args[0].includes('pagefind')) {
    const site = join(root, 'packages/gateway/public/site');
    mkdirSync(join(site, 'docs'), { recursive: true });
    renameSync(join(site, 'docs.html'), join(site, 'docs/index.html'));
  }
  execFileSync(process.execPath, [join(root, args[0]), ...args.slice(1)], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
  });
}
