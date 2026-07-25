#!/usr/bin/env node
/**
 * mordecai-peer — run an always-on peer on one app's chain.
 *
 * The peer syncs the *app* chain only. Its sole L1 contact is an RPC
 * client: reading the registry entry (which is the whole root of trust —
 * the validator set there derives the genesis), and, with --anchor,
 * relaying anchors back.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { encodeAddress } from '@mordecai/crypto';
import { readKeyFile, writeKeyFile } from '@mordecai/node';
import { NodeRpcClient } from '@mordecai/rpc';
import { AppChain } from './appchain.js';
import { AnchorDaemon } from './daemon.js';

const USAGE = `mordecai-peer — a peer on an app's chain

Usage:
  mordecai-peer keygen --dir <path>
  mordecai-peer start  --dir <path> --app <appId> --l1-node <rpc-key-hex>
                       [--bootstrap <host:port,...>] [--block-interval <ms>]
                       [--anchor --l1-chain-id <id> --relayer <file>
                        [--epoch-interval <ms>]]

keygen mints <dir>/peer.key and prints its public key — that hex string is
       what goes into the app's registered validator set. Do this before
       registering the app; the key must survive redeploys.
start  looks the app up on L1, derives the genesis from the registered
       validator set, and runs the node. In the set: produces blocks and
       answers anchor_sign. Not in it: follows and serves reads.
--anchor additionally relays anchors to L1, paid for by --relayer. It
       anchors the state root alone; outcome calls are app-specific, so
       those need AnchorDaemon's \`outcome\` hook from a script.
`;

const KEY_FILE = 'peer.key';

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n\n${USAGE}`);
  process.exit(1);
}

function parseBootstrap(value: string | undefined): { host: string; port: number }[] | undefined {
  if (!value) return undefined;
  return value.split(',').map((entry) => {
    const [host, port] = entry.split(':');
    if (!host || !port) fail(`--bootstrap entries must be host:port, got: ${entry}`);
    return { host, port: Number(port) };
  });
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(USAGE);
    return;
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      dir: { type: 'string' },
      app: { type: 'string' },
      'l1-node': { type: 'string' },
      'l1-chain-id': { type: 'string' },
      bootstrap: { type: 'string' },
      'block-interval': { type: 'string', default: '300' },
      anchor: { type: 'boolean', default: false },
      relayer: { type: 'string' },
      'epoch-interval': { type: 'string', default: '5000' },
    },
  });

  const dir = values.dir;
  if (!dir) fail('--dir is required');
  const keyPath = join(dir, KEY_FILE);

  if (command === 'keygen') {
    mkdirSync(dir, { recursive: true });
    if (existsSync(keyPath)) fail(`refusing to overwrite an existing key: ${keyPath}`);
    const keyPair = writeKeyFile(keyPath);
    process.stdout.write(
      JSON.stringify(
        {
          key: keyPath,
          publicKey: Buffer.from(keyPair.publicKey).toString('hex'),
          address: encodeAddress(keyPair.publicKey),
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  if (command !== 'start') fail(`unknown command: ${command}`);

  const appId = values.app;
  if (!appId) fail('--app <appId> is required');
  const l1NodeKey = values['l1-node'];
  if (!l1NodeKey || !/^[0-9a-fA-F]{64}$/.test(l1NodeKey)) {
    fail('--l1-node <rpc-key-hex> is required (64 hex chars)');
  }
  if (!existsSync(keyPath))
    fail(`no peer key at ${keyPath} — run: mordecai-peer keygen --dir ${dir}`);

  const keyPair = readKeyFile(keyPath);
  const bootstrap = parseBootstrap(values.bootstrap);
  const log = (message: string) => process.stdout.write(`${new Date().toISOString()} ${message}\n`);

  const l1 = NodeRpcClient.connect(new Uint8Array(Buffer.from(l1NodeKey, 'hex')), {
    ...(bootstrap ? { bootstrap } : {}),
  });

  // The registry entry is the root of trust: it carries the validator set
  // the genesis is derived from. Fetched here rather than via AppChain.join
  // so the anchor daemon can reuse it without a second lookup.
  const entry = await l1.getApp(appId);
  if (!entry) fail(`app not registered on L1: ${appId}`);
  const chainValidators = entry.chainValidators.map(
    (hex) => new Uint8Array(Buffer.from(hex, 'hex')),
  );

  const app = await AppChain.start({
    appId,
    chainValidators,
    dir,
    keyPair,
    blockIntervalMs: Number(values['block-interval']),
    ...(bootstrap ? { bootstrap } : {}),
    log,
  });

  process.stdout.write(`app:      ${appId}\n`);
  process.stdout.write(`chain:    ${app.genesis.chainId}\n`);
  process.stdout.write(`height:   ${app.chain.height}\n`);
  process.stdout.write(`role:     ${app.isValidator ? 'validator' : 'follower'}\n`);
  process.stdout.write(`address:  ${encodeAddress(keyPair.publicKey)}\n`);
  process.stdout.write(`rpc key:  ${Buffer.from(app.rpcPublicKey).toString('hex')}\n`);

  let daemon: AnchorDaemon | undefined;
  if (values.anchor) {
    if (!app.isValidator) fail('--anchor requires this peer to be in the registered validator set');
    const l1ChainId = values['l1-chain-id'];
    if (!l1ChainId) fail('--anchor requires --l1-chain-id <id>');
    if (!values.relayer) fail('--anchor requires --relayer <file> (a funded L1 account)');
    const relayer = readKeyFile(values.relayer);
    daemon = new AnchorDaemon({
      chain: app.chain,
      appId,
      validators: chainValidators,
      keyPair,
      l1: {
        chainId: l1ChainId,
        nodeKey: new Uint8Array(Buffer.from(l1NodeKey, 'hex')),
        ...(bootstrap ? { bootstrap } : {}),
      },
      relayer,
      epochIntervalMs: Number(values['epoch-interval']),
      log: (m) => log(`[anchor] ${m}`),
    });
    process.stdout.write(
      `anchor:   every ${values['epoch-interval']}ms as ${encodeAddress(relayer.publicKey)}\n`,
    );
  }

  process.stdout.write('peer running — Ctrl-C to stop\n');
  const shutdown = () => {
    void (async () => {
      await daemon?.close();
      await app.stop();
      await l1.close();
      process.exit(0);
    })();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise(() => {});
}

main().catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
