import { execFileSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const builds = [
  ['packages/gateway', 'vite.config.js'],
  ...['hex', 'frontier', 'outpost', 'chess'].map((name) => [
    `apps/${name}-web`,
    'vite.embed.config.js',
  ]),
];
for (const [dir, config] of builds) {
  execFileSync(
    process.execPath,
    [
      join(root, dir, 'node_modules/vite/bin/vite.js'),
      'build',
      '--config',
      join(root, dir, config),
    ],
    { cwd: root, stdio: 'inherit' },
  );
}
