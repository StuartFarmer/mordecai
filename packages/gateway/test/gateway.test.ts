/**
 * Gateway e2e: a real node on an in-process DHT testnet, bridged to plain
 * HTTP. The "browser" here is fetch(): it signs transactions locally and
 * talks JSON — exactly what the web client does.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import createTestnet from 'hyperdht/testnet';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Node, initNodeDir } from '@mordecai/node';
import { Wallet } from '@mordecai/wallet';
import { encodeTransaction, type Payload } from '@mordecai/protocol';
import { Gateway } from '../src/gateway.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

let testnet: Awaited<ReturnType<typeof createTestnet>>;
let dir: string;
let node: Node;
let gateway: Gateway;
let base: string;
const { wallet: alice } = Wallet.create();
const { wallet: bob } = Wallet.create();
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
    allocations: [{ address: alice.address, balance: 10_000_000n }],
  });
  node = await Node.start({
    dir,
    genesis: config.genesis,
    keyPair: config.keyPair,
    blockIntervalMs: 50,
    bootstrap: testnet.bootstrap,
  });
  gateway = await Gateway.start({
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
