import RPC from '@hyperswarm/rpc';
import createTestnet from 'hyperdht/testnet';
import { expect, it } from 'vitest';
import { NodeRpcClient } from '../../rpc/src/client.js';

it('expires stalled receipt and block requests without preventing later healthy reads', async () => {
  const testnet = await createTestnet(3);
  const rpc = new RPC({ bootstrap: testnet.bootstrap });
  const server = rpc.createServer();
  let stalled = false;
  const waiting: (() => void)[] = [];
  const respond = async () => {
    if (stalled) await new Promise<void>((resolve) => waiting.push(resolve));
    return Buffer.from(JSON.stringify({ ok: true, result: null }));
  };
  server.respond('get_tx', respond);
  server.respond('get_block', respond);
  await server.listen();
  const client = NodeRpcClient.connect(server.publicKey!, { bootstrap: testnet.bootstrap });
  try {
    await expect(client.getTx('00'.repeat(32), { timeout: 1000 })).resolves.toBeNull();
    stalled = true;
    await expect(client.getTx('01'.repeat(32), { timeout: 50 })).rejects.toThrow(/timeout/i);
    await expect(client.getBlock(1n, { timeout: 50 })).rejects.toThrow(/timeout/i);
    stalled = false;
    await expect(client.getTx('02'.repeat(32), { timeout: 1000 })).resolves.toBeNull();
    await expect(client.getBlock(2n, { timeout: 1000 })).resolves.toBeNull();
  } finally {
    for (const resolve of waiting) resolve();
    await client.close();
    await rpc.destroy();
    await testnet.destroy();
  }
}, 15000);
