import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../packages/gateway/public/site/', import.meta.url));
const navigation = JSON.parse(readFileSync(new URL('../docs/navigation.json', import.meta.url)));
const chapters = navigation.flatMap((group) => group.pages);
assert.ok(chapters.length >= 36, 'All documentation chapters must be migrated');
const read = (path) => readFileSync(join(root, path), 'utf8');
assert.match(read('index.html'), /data-page="account"/);
assert.match(read('account.html'), /id="wallet-generate"/);
for (const { slug } of chapters) {
  const html = read(`docs/${slug}.html`);
  assert.match(html, /data-pagefind-body/);
  assert.match(html, /<h1/);
  assert.doesNotMatch(html, /\{\{#include/);
}
const guide = read('docs/field-guide.html');
for (const id of [
  'tools',
  'join-network',
  'wallet',
  'create-app',
  'join-app',
  'payments',
  'faucet',
])
  assert.ok(guide.includes(`id="${id}"`), `Missing legacy anchor ${id}`);
assert.match(guide, /<live-node/);
assert.ok(existsSync(join(root, 'pagefind/pagefind.js')), 'Documentation search must be indexed');
const files = readdirSync(root, { recursive: true }).filter((f) => f.endsWith('.html'));
for (const file of files) {
  const html = read(file);
  for (const [, href] of html.matchAll(/(?:href|src)="([^"<>]+)"/g)) {
    if (/^(https?:|mailto:|data:|javascript:)/.test(href)) continue;
    const url = new URL(href.replaceAll('&amp;', '&'), 'http://site/' + file);
    if (url.pathname.startsWith('/api/')) continue;
    const target = decodeURIComponent(url.pathname).replace(/^\//, '');
    const path = target.endsWith('/') || !target ? target + 'index.html' : target;
    const built = join(root, path);
    const publicAsset = join(
      root,
      '..',
      path.replace(/^wallet-assets\/(mordecai\.(css|js)|favicon.svg)$/, '$1'),
    );
    assert.ok(existsSync(built) || existsSync(publicAsset), `${file}: broken local link ${href}`);
    if (url.hash && !url.hash.startsWith('#/') && path.endsWith('.html') && existsSync(built)) {
      const id = decodeURIComponent(url.hash.slice(1));
      assert.ok(read(path).includes(`id="${id}"`), `${file}: missing anchor ${href}`);
    }
  }
}
console.log(
  `Site verified: ${chapters.length} chapters, legacy anchors, MDX widget, search, and local links/assets.`,
);
