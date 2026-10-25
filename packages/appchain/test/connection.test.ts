import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { peerUrl, parseConnection, readConnection } from '../src/connection.js';
import { appChainGenesis } from '../src/genesis.js';
import { genesisHash } from '@mordecai/chain';
import { AppChain } from '../src/appchain.js';

it('rejects malformed settlement settings before opening an RPC connection', async () => {
  await expect(
    AppChain.connect('com.example.game', {
      dir: './unused-invalid-connection',
      settlement: { nodeKey: 'bad' },
    }),
  ).rejects.toThrow(/32-byte hex/);
});

it('distinguishes explicit URLs and IP addresses from registered names', () => {
  for (const [input, expected] of [
    ['com.example.game', undefined],
    ['game.example.com', undefined],
    ['https://game.example.com', 'https://game.example.com/api/connect'],
    ['http://localhost:8787/game/', 'http://localhost:8787/game/api/connect'],
    ['http://localhost:8787/api/connect', 'http://localhost:8787/api/connect'],
    ['http://localhost:8787/api/connect/', 'http://localhost:8787/api/connect'],
    ['192.168.1.20:8787', 'http://192.168.1.20:8787/api/connect'],
    ['192.168.1.20', 'http://192.168.1.20/api/connect'],
    ['[::1]:8787', 'http://[::1]:8787/api/connect'],
    ['::1', 'http://[::1]/api/connect'],
  ])
    expect(peerUrl(input!)?.href).toBe(expected);
  for (const input of [
    'ftp://example.com',
    '192.168.1.20:99999',
    'http://',
    'https://user:secret@example.com',
    'game.example.com:8787',
  ]) {
    expect(() => peerUrl(input)).toThrow();
  }
});

it('rejects HTTP failures and oversized connection documents', async () => {
  let large = false;
  const server = createServer((_req, res) => {
    res.writeHead(large ? 200 : 404);
    res.end(large ? ' '.repeat((1 << 20) + 1) : 'not an app gateway');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const url = new URL(`http://127.0.0.1:${address.port}/api/connect`);
    await expect(readConnection(url)).rejects.toThrow(/HTTP 404/);
    large = true;
    await expect(readConnection(url)).rejects.toThrow(/exceeds 1 MiB/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('validates a peer connection document before using network settings', () => {
  const key = new Uint8Array(32).fill(1);
  const hex = Buffer.from(key).toString('hex');
  const doc = {
    version: 1,
    appId: 'com.example.game',
    nodeKey: hex,
    chainValidators: [hex],
    feedKeys: [hex],
    genesisHash: Buffer.from(genesisHash(appChainGenesis('com.example.game', [key]))).toString(
      'hex',
    ),
    bootstrap: [{ host: '127.0.0.1', port: 1234 }],
  };
  expect(parseConnection(doc)).toEqual(doc);
  for (const invalid of [
    null,
    {},
    { ...doc, version: 2 },
    { ...doc, appId: '' },
    { ...doc, chainValidators: [] },
    { ...doc, chainValidators: [hex, hex] },
    { ...doc, chainValidators: ['bad'] },
    { ...doc, feedKeys: ['bad'] },
    { ...doc, genesisHash: '00'.repeat(32) },
    { ...doc, nodeKey: 'bad' },
    { ...doc, bootstrap: [{ host: 'localhost', port: 0 }] },
    { ...doc, settlement: { nodeKey: 'bad' } },
  ])
    expect(() => parseConnection(invalid)).toThrow();
});
