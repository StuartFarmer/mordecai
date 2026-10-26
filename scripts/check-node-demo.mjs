/* global fetch, AbortSignal, URL */
import assert from 'node:assert/strict';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:8790');
async function get(path, type = 'application/json') {
  const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, path);
  assert.ok(response.headers.get('content-type')?.includes(type), `${path}: wrong content type`);
  return type === 'application/json' ? response.json() : response.text();
}

const [head, config] = await Promise.all([get('/api/head'), get('/api/config')]);
const names = ['bounties', 'chess', 'frontier', 'hex', 'microblog', 'outpost'];
assert.equal(head.chainId, 'mordecai-demo');
assert.deepEqual(Object.keys(config.demos).sort(), names);
for (const name of names) {
  const demo = config.demos[name];
  assert.equal(demo.chainId, head.chainId, `${name}: wrong network`);
  assert.ok((await get(`/demo-assets/${name}.js`, 'text/javascript')).length > 100);
  if (demo.contract) assert.ok(Array.isArray(await get(`/api/contract/${demo.contract}/state`)));
  if (demo.appApi) {
    assert.equal((await get(`${demo.appApi}/api/head`)).chainId, demo.appChainId);
    assert.equal((await get(`${demo.appApi}/api/faucet`)).enabled, false);
  }
}
assert.equal((await get('/api/faucet')).enabled, false);
assert.equal((await get('/api/accounts')).amount, '1000000');
assert.ok((await get('/wallet-assets/wallet.js', 'text/javascript')).length > 100);
assert.equal((await get('/api/demos/microblog/feed')).feedId, config.demos.microblog.feedId);
for (const path of ['/', '/docs/', '/docs/examples/microblog.html', '/docs/examples/bounties.html'])
  assert.ok((await get(path, 'text/html')).length > 1000, `${path}: missing page`);
console.log(
  `Healthy: all six demos, both app chains, account registration, website and documentation at ${base.origin}`,
);
