/**
 * Gateway e2e: a real node on an in-process DHT testnet, bridged to plain
 * HTTP. The "browser" here is fetch(): it signs transactions locally and
 * talks JSON — exactly what the web client does.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import createTestnet from 'hyperdht/testnet';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Node, initNodeDir } from '@mordecai/node';
import { Wallet } from '@mordecai/wallet';
import { NodeRpcServer } from '@mordecai/rpc';
import { createBrowserWallet } from '@mordecai/wallet/browser';
import { encodeTransaction, encodePayload, type Payload } from '@mordecai/protocol';
import { Gateway } from '../src/gateway.js';
import { TransactionClient } from '../web/transactions.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

let testnet: Awaited<ReturnType<typeof createTestnet>>;
let dir: string;
let node: Node;
let gateway: Gateway;
let base: string;
const { wallet: alice } = Wallet.create();
const { wallet: bob } = Wallet.create();
const { wallet: faucetWallet } = Wallet.create();
const browserWallet = createBrowserWallet();
let nonce = 0n;

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, init);
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `http ${res.status}`);
  return body;
}

async function submit(payload: Payload): Promise<{ hash: string }> {
  const tx = alice.signTransaction({
    chainId: 'mordecai-gw-test',
    nonce: nonce++,
    maxFee: 500_000n,
    payload,
  });
  return api('/api/tx', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tx: Buffer.from(encodeTransaction(tx)).toString('hex') }),
  });
}

async function waitForTx(hash: string): Promise<{ success: boolean; returnData: string }> {
  for (let i = 0; i < 100; i++) {
    const res = await fetch(`${base}/api/tx/${hash}`);
    if (res.ok) return (await res.json()) as { success: boolean; returnData: string };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`tx ${hash} never landed`);
}

beforeAll(async () => {
  testnet = await createTestnet(3);
  dir = mkdtempSync(join(tmpdir(), 'mordecai-gateway-'));
  const config = initNodeDir({
    dir,
    chainId: 'mordecai-gw-test',
    allocations: [
      { address: alice.address, balance: 10_000_000n },
      { address: faucetWallet.address, balance: 1_000_000n },
      { address: browserWallet.address, balance: 100_000n },
    ],
  });
  node = await Node.start({
    dir,
    genesis: config.genesis,
    keyPair: config.keyPair,
    blockIntervalMs: 50,
    bootstrap: testnet.bootstrap,
  });
  gateway = await Gateway.start({
    faucet: faucetWallet,
    nodeKey: node.rpcPublicKey,
    bootstrap: testnet.bootstrap,
    config: { chainId: 'mordecai-gw-test', hello: 'frontier' },
  });
  base = `http://127.0.0.1:${gateway.port}`;
}, 60_000);

afterAll(async () => {
  if (gateway) await gateway.close();
  if (node) await node.stop();
  if (testnet) await testnet.destroy();
  rmSync(dir, { recursive: true, force: true });
}, 60_000);

describe('HTTP gateway to node RPC', () => {
  it('submits browser transfers and locally signed transaction payloads with real receipts', async () => {
    const client = new TransactionClient((path: string, init?: RequestInit) =>
      fetch(new URL(path, `${base}/`), init),
    );
    const recipient = Wallet.create().wallet;
    await client.submit(await client.prepareTransfer(browserWallet, recipient.address, '123'));
    await waitForTx(client.pending.hash);
    await client.checkPending();
    expect(client.history[0].status).toBe('confirmed');
    const second = await client.prepareTransfer(browserWallet, recipient.address, '456');
    await client.submit(
      await client.prepareTransaction(
        browserWallet,
        Buffer.from(encodePayload(second.tx.payload)).toString('hex'),
        '1000',
      ),
    );
    await waitForTx(client.pending.hash);
    await client.checkPending();
    expect(client.history[0].status).toBe('confirmed');
    expect(await api(`/api/account/${recipient.address}`)).toMatchObject({ balance: '579' });
  });

  it('marks definite admission rejection and retains uncertainty after admission', async () => {
    const client = new TransactionClient((path: string, init?: RequestInit) =>
      fetch(new URL(path, `${base}/`), init),
    );
    const prepared = await client.prepareTransfer(
      browserWallet,
      Wallet.create().wallet.address,
      '123',
    );
    const invalid = Buffer.from(prepared.hex, 'hex');
    invalid[invalid.length - 1] ^= 1;
    const rejected = await fetch(`${base}/api/tx`, {
      method: 'POST',
      body: JSON.stringify({ tx: invalid.toString('hex') }),
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ rejected: true });

    const rpc = await NodeRpcServer.start(
      {
        chain: node.chain,
        mempool: node.mempool,
        onTxAcceptedBytes() {
          throw new Error('gossip unavailable');
        },
      },
      { bootstrap: testnet.bootstrap },
    );
    let uncertainGateway: Gateway | undefined;
    try {
      uncertainGateway = await Gateway.start({
        nodeKey: rpc.publicKey,
        bootstrap: testnet.bootstrap,
      });
      const response = await fetch(`http://127.0.0.1:${uncertainGateway.port}/api/tx`, {
        method: 'POST',
        body: JSON.stringify({ tx: prepared.hex }),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).not.toHaveProperty('rejected');
      expect((await waitForTx(prepared.hash)).success).toBe(true);
    } finally {
      await uncertainGateway?.close();
      await rpc.close();
    }
  });

  it('mounts named app APIs and their faucets independently of the root', async () => {
    const mounted = await Gateway.start({
      nodeKey: node.rpcPublicKey,
      bootstrap: testnet.bootstrap,
      networks: {
        hex: {
          nodeKey: node.rpcPublicKey,
          bootstrap: testnet.bootstrap,
          faucet: faucetWallet,
          faucetAmount: 1000000000n,
        },
      },
    });
    try {
      const url = `http://127.0.0.1:${mounted.port}`;
      expect(await (await fetch(`${url}/api/faucet`)).json()).toEqual({ enabled: false });
      expect(await (await fetch(`${url}/api/demos/hex/api/faucet`)).json()).toMatchObject({
        enabled: true,
        amount: '1000000000',
      });
      expect(await (await fetch(`${url}/api/demos/hex/api/head`)).json()).toMatchObject({
        chainId: 'mordecai-gw-test',
      });
      expect((await fetch(`${url}/api/demos/missing/api/head`)).status).toBe(404);
    } finally {
      await mounted.close();
    }
  });

  it('keeps the faucet disabled unless the operator supplies a wallet', async () => {
    const defaultBase = `http://127.0.0.1:${node.gateway.port}`;
    expect(await (await fetch(`${defaultBase}/api/faucet`)).json()).toEqual({ enabled: false });
    expect((await fetch(`${defaultBase}/api/faucet`, { method: 'POST', body: '{}' })).status).toBe(
      503,
    );
  });

  it('validates claims, pays a real recipient, and enforces the cooldown', async () => {
    const post = (body: string, headers = {}) =>
      fetch(`${base}/api/faucet`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      });
    for (const body of [
      '{',
      'null',
      '{}',
      '{"address":"bad"}',
      JSON.stringify({ address: 'a'.repeat(600) }),
    ]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(await api('/api/faucet')).toEqual({
      enabled: true,
      address: faucetWallet.address,
      amount: '10000',
      cooldownSeconds: 60,
    });
    const recipient = Wallet.create().wallet;
    const response = await post(JSON.stringify({ address: recipient.address, amount: '99999999' }));
    expect(response.status).toBe(202);
    const { hash } = (await response.json()) as { hash: string };
    expect((await waitForTx(hash)).success).toBe(true);
    expect(await api(`/api/account/${recipient.address}`)).toMatchObject({ balance: '10000' });
    const repeated = await post(JSON.stringify({ address: Wallet.create().wallet.address }), {
      'x-forwarded-for': '203.0.113.1',
    });
    expect(repeated.status).toBe(429);
    expect(Number(repeated.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it.each([
    '/',
    '/wallet.html',
    '/docs/',
    '/docs/field-guide.html',
    '/docs/architecture/overview.html',
  ])('serves %s and its local assets', async (route) => {
    const page = await fetch(`${base}${route}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    expect(html).toContain('<h1');
    // Follow the page's actual asset references, so missing packaged assets fail.
    const assets = [...html.matchAll(/(?:src|href)="([^"#?]+\.(?:css|js|jpg|svg|png))"/g)];
    expect(assets.length).toBeGreaterThanOrEqual(3);
    for (const [, path] of assets) {
      const asset = await fetch(new URL(path!, page.url));
      expect(asset.status).toBe(200);
      expect(asset.headers.get('content-type')).not.toContain('text/html');
      expect((await asset.arrayBuffer()).byteLength).toBeGreaterThan(0);
    }
    const head = await fetch(`${base}${route}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    for (const path of ['/missing', '/api/missing', '/package.json']) {
      expect((await fetch(`${base}${path}`)).status).toBe(404);
    }
    expect((await fetch(`${base}${route}`, { method: 'POST' })).status).toBe(404);
  });

  it.each(['/guide', '/guide/', '/guide.html'])('redirects legacy %s to the book', async (path) => {
    const res = await fetch(`${base}${path}?from=old`, { redirect: 'manual' });
    expect(res.status).toBe(308);
    expect(new URL(res.headers.get('location')!, res.url).href).toBe(
      `${base}/docs/field-guide.html?from=old`,
    );
  });

  it('redirects the book root so its relative assets resolve correctly', async () => {
    const res = await fetch(`${base}/docs?search=wallet`, { redirect: 'manual' });
    expect(res.status).toBe(308);
    expect(new URL(res.headers.get('location')!, res.url).href).toBe(`${base}/docs/?search=wallet`);
  });

  it.each([
    '/docs/missing.html',
    '/docs/missing.js',
    '/docs/%2e%2e%2findex.html',
    '/docs/%2e%2e%5cindex.html',
    '/docs/%E0%A4%A',
    '/docs/%00',
  ])('rejects missing or invalid documentation path %s', async (path) => {
    expect((await fetch(`${base}${path}`)).status).toBe(404);
  });

  it('keeps the field guide section anchors and serves the book search index', async () => {
    const html = await (await fetch(`${base}/docs/field-guide.html`)).text();
    for (const id of ['tools', 'join-network', 'wallet', 'create-app', 'join-app', 'payments']) {
      expect(html).toContain(`id="${id}"`);
    }
    const script = html.match(/window\.path_to_searchindex_js = "([^"]+)"/);
    expect(script).not.toBeNull();
    const index = await fetch(new URL(script![1]!, `${base}/docs/field-guide.html`));
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toContain('javascript');
    expect(await index.text()).toContain('Create a wallet');
  });

  it('lets a custom frontend replace the landing page and keep its SPA fallback', async () => {
    const staticDir = mkdtempSync(join(tmpdir(), 'mordecai-frontend-'));
    writeFileSync(join(staticDir, 'index.html'), '<h1>My app</h1>');
    const custom = await Gateway.start({
      nodeKey: node.rpcPublicKey,
      bootstrap: testnet.bootstrap,
      staticDir,
    });
    try {
      for (const path of [
        '/',
        '/app/route',
        '/guide',
        '/guide/',
        '/docs',
        '/docs/',
        '/docs/field-guide.html',
      ]) {
        const res = await fetch(`http://127.0.0.1:${custom.port}${path}`);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('<h1>My app</h1>');
      }
      const wallet = await fetch(`http://127.0.0.1:${custom.port}/wallet`);
      expect(wallet.url).toBe(`http://127.0.0.1:${custom.port}/wallet.html`);
      expect(await wallet.text()).toContain('id="wallet-generate"');
      for (const asset of ['wallet.js', 'mordecai.css', 'faucet.js']) {
        const res = await fetch(`http://127.0.0.1:${custom.port}/wallet-assets/${asset}`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).not.toContain('text/html');
      }
    } finally {
      await custom.close();
      rmSync(staticDir, { recursive: true, force: true });
    }
  });

  it('serves the operator config and chain head', { timeout: 30_000 }, async () => {
    expect(await api('/api/config')).toEqual({ chainId: 'mordecai-gw-test', hello: 'frontier' });
    const head = await api<{ chainId: string; height: string }>('/api/head');
    expect(head.chainId).toBe('mordecai-gw-test');
  });

  it('serves accounts and settles a browser-signed transfer', { timeout: 30_000 }, async () => {
    const before = await api<{ balance: string }>(`/api/account/${alice.address}`);
    expect(before.balance).toBe('10000000');

    const { hash } = await submit({
      kind: 'transfer',
      to: bob.publicKey,
      amount: 400_000n,
    });
    expect((await waitForTx(hash)).success).toBe(true);
    const after = await api<{ balance: string }>(`/api/account/${bob.address}`);
    expect(after.balance).toBe('400000');
  });

  it('deploys a contract and reads its state over HTTP', { timeout: 30_000 }, async () => {
    const wasm = readFileSync(join(repoRoot, 'contracts/dist/land.wasm'));
    const { hash } = await submit({ kind: 'deploy_contract', code: new Uint8Array(wasm) });
    const deployed = await waitForTx(hash);
    expect(deployed.success).toBe(true);
    const contract = deployed.returnData;

    const u64 = (n: bigint) => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(n);
      return new Uint8Array(b);
    };
    const exec = async (action: string, args: Uint8Array) => {
      const { hash } = await submit({
        kind: 'execute_contract',
        contract: new Uint8Array(Buffer.from(contract, 'hex')),
        value: 0n,
        action,
        args,
      });
      return waitForTx(hash);
    };
    expect((await exec('init', u64(100n))).success).toBe(true);
    expect((await exec('claim_tile', u64(7n))).success).toBe(true);

    const entries = await api<{ key: string; value: string }[]>(`/api/contract/${contract}/state`);
    const keys = entries.map((e) => Buffer.from(e.key, 'hex').toString('latin1'));
    expect(keys.some((k) => k.startsWith('s:Tile:'))).toBe(true);

    // prefix narrowing: only Tile rows come back
    const tilePrefix = Buffer.from('s:Tile:', 'utf8').toString('hex');
    const tiles = await api<{ key: string; value: string }[]>(
      `/api/contract/${contract}/state?prefix=${tilePrefix}`,
    );
    expect(tiles.length).toBe(1);
    // value starts with the 32-byte owner = alice's public key
    expect(tiles[0]!.value.slice(0, 64)).toBe(Buffer.from(alice.publicKey).toString('hex'));
  });

  it('rejects malformed submissions cleanly', { timeout: 30_000 }, async () => {
    await expect(
      api('/api/tx', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tx: 'zznothex' }),
      }),
    ).rejects.toThrow(/expected/);
    const res = await fetch(`${base}/api/tx/${'0'.repeat(64)}`);
    expect(res.status).toBe(404);
  });
});
