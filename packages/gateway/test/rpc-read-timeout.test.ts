import RPC from '@hyperswarm/rpc';
import createTestnet from 'hyperdht/testnet';
import { expect, it, vi } from 'vitest';
import { NodeRpcClient } from '../../rpc/src/client.js';

it('expires stalled reads without preventing later healthy reads', async () => {
  const testnet = await createTestnet(3);
  const rpc = new RPC({ bootstrap: testnet.bootstrap });
  const server = rpc.createServer();
  let stalled = false;
  const waiting: (() => void)[] = [];
  const respond = async () => {
    if (stalled)
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
        setTimeout(resolve, 300);
      });
    return Buffer.from(JSON.stringify({ ok: true, result: null }));
  };
  server.respond('get_tx', respond);
  server.respond('get_block', respond);
  server.respond('get_head', respond);
  server.respond('get_apps', respond);
  server.respond('get_app', respond);
  server.respond('get_app_anchor', respond);
  await server.listen();
  const client = NodeRpcClient.connect(server.publicKey!, { bootstrap: testnet.bootstrap });
  try {
    await expect(client.getTx('00'.repeat(32), { timeout: 1000 })).resolves.toBeNull();
    stalled = true;
    await expect(client.getTx('01'.repeat(32), { timeout: 50 })).rejects.toThrow(/timeout/i);
    await expect(client.getBlock(1n, { timeout: 50 })).rejects.toThrow(/timeout/i);
    await expect(client.getHead({ timeout: 50 })).rejects.toThrow(/timeout/i);
    await expect(client.getApps({}, { timeout: 50 })).rejects.toThrow(/timeout/i);
    await expect(client.getApp('app.test', { timeout: 50 })).rejects.toThrow(/timeout/i);
    await expect(client.getAppAnchor('app.test', { timeout: 50 })).rejects.toThrow(/timeout/i);
    stalled = false;
    await expect(client.getTx('02'.repeat(32), { timeout: 1000 })).resolves.toBeNull();
    await expect(client.getBlock(2n, { timeout: 1000 })).resolves.toBeNull();
    await expect(client.getHead({ timeout: 1000 })).resolves.toBeNull();
    await expect(client.getApps({}, { timeout: 1000 })).resolves.toBeNull();
    await expect(client.getApp('app.test', { timeout: 1000 })).resolves.toBeNull();
    await expect(client.getAppAnchor('app.test', { timeout: 1000 })).resolves.toBeNull();
  } finally {
    for (const resolve of waiting) resolve();
    await client.close();
    await rpc.destroy();
    await testnet.destroy();
  }
}, 15000);

it('bounds a read even when transport never completes connection setup', async () => {
  const testnet = await createTestnet(3);
  let rejectRead: ((error: Error) => void) | undefined;
  const connect = vi.spyOn(RPC.prototype, 'connect').mockReturnValue({
    request: () =>
      new Promise<Buffer>((_, reject) => {
        rejectRead = reject;
      }),
    destroy: async () => {},
  });
  const client = NodeRpcClient.connect(new Uint8Array(32), { bootstrap: testnet.bootstrap });
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    await expect(
      Promise.race([
        client.getHead({ timeout: 50 }),
        new Promise((_, reject) => {
          guard = setTimeout(() => reject(new Error('read exceeded its connection deadline')), 500);
        }),
      ]),
    ).rejects.toThrow(/timeout/i);
  } finally {
    clearTimeout(guard);
    rejectRead?.(new Error('late transport failure'));
    await client.close();
    await testnet.destroy();
    connect.mockRestore();
  }
}, 15000);
