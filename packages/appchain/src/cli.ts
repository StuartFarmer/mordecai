#!/usr/bin/env node
/**
 * mordecai app — run an always-on peer on one app's chain.
 *
 * Join directly through another peer's HTTP gateway, or resolve an app
 * ID through a settlement registry. Both paths start the same services.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { decodeAddress, encodeAddress } from '@mordecai/crypto';
import { readKeyFile, writeKeyFile } from '@mordecai/node';
import { AppChain } from './appchain.js';
import { AnchorDaemon } from './daemon.js';

const USAGE = `mordecai app — a peer on an app's chain

Usage:
  mordecai app init --dir <path>
  mordecai app connect --dir <path> --app <appId|peer-url|ip:port>
                       [--settlement-node <rpc-key-hex>]
                       [--bootstrap <host:port,...>] [--block-interval <ms>]
                       [--port <port>] [--static <dir>] [--config <file.json>]
                       [--feed <feed-key-hex>]...
                       [--anchor --l1-chain-id <id> --relayer <file>
                        [--epoch-interval <ms>]]

init mints <dir>/peer.key and prints its public key — that hex string is
       what goes into the app's validator set. Do this before creating
       or registering the app; the key must survive redeploys.
connect (or start) creates/reuses your identity and starts all services.
       URLs/IPs fetch connection details directly; app IDs require
       --settlement-node (--l1-node is an alias). Domain URLs need http(s)://.
       Direct connections need no settlement network. In the
       validator set: also votes and answers anchor_sign. Otherwise: peer.
       Advertised feeds are seeded automatically; --feed adds app data.
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
      'settlement-node': { type: 'string' },
      'l1-chain-id': { type: 'string' },
      bootstrap: { type: 'string' },
      'block-interval': { type: 'string', default: '300' },
      anchor: { type: 'boolean', default: false },
      relayer: { type: 'string' },
      'epoch-interval': { type: 'string', default: '5000' },
      port: { type: 'string', default: process.env.PORT ?? '0' },
      static: { type: 'string' },
      config: { type: 'string' },
      feed: { type: 'string', multiple: true, default: [] },
    },
  });

  const dir = values.dir;
  if (!dir) fail('--dir is required');
  const keyPath = join(dir, KEY_FILE);

  if (command === 'init') {
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

  if (command !== 'start' && command !== 'connect') fail(`unknown command: ${command}`);

  const target = values.app;
  if (!target) fail('--app <appId|peer-url|ip:port> is required');
  const settlementKey = values['settlement-node'] ?? values['l1-node'];
  if (
    values['settlement-node'] &&
    values['l1-node'] &&
    values['settlement-node'].toLowerCase() !== values['l1-node'].toLowerCase()
  ) {
    fail('--settlement-node and --l1-node refer to different nodes');
  }
  if (settlementKey && !/^[0-9a-fA-F]{64}$/.test(settlementKey)) {
    fail('--settlement-node must be a 32-byte hex RPC key');
  }
  for (const key of values.feed ?? []) {
    if (!/^[0-9a-fA-F]{64}$/.test(key)) fail('--feed must be a 32-byte hex public key');
  }
  mkdirSync(dir, { recursive: true });
  const keyPair = existsSync(keyPath) ? readKeyFile(keyPath) : writeKeyFile(keyPath);
  const bootstrap = parseBootstrap(values.bootstrap);
  const log = (message: string) => process.stdout.write(`${new Date().toISOString()} ${message}\n`);

  const app = await AppChain.connect(target, {
    dir,
    keyPair,
    blockIntervalMs: Number(values['block-interval']),
    ...(bootstrap ? { bootstrap } : {}),
    log,
    ...(settlementKey
      ? {
          settlement: {
            nodeKey: settlementKey,
            ...(values['l1-chain-id'] ? { chainId: values['l1-chain-id'] } : {}),
            ...(bootstrap ? { bootstrap } : {}),
          },
        }
      : {}),
    feedKeys: (values.feed ?? []).map((hex) => new Uint8Array(Buffer.from(hex, 'hex'))),
    gateway: {
      port: Number(values.port),
      ...(values.static ? { staticDir: values.static } : {}),
      ...(values.config ? { config: JSON.parse(readFileSync(values.config, 'utf8')) } : {}),
    },
  });

  const appId = app.appId;
  process.stdout.write(`app:      ${appId}\n`);
  process.stdout.write(`chain:    ${app.genesis.chainId}\n`);
  process.stdout.write(`height:   ${app.chain.height}\n`);
  process.stdout.write(`role:     ${app.isValidator ? 'validator' : 'peer'}\n`);
  process.stdout.write(`address:  ${encodeAddress(keyPair.publicKey)}\n`);
  process.stdout.write(`rpc key:  ${Buffer.from(app.rpcPublicKey).toString('hex')}\n`);
  process.stdout.write(`http:     http://127.0.0.1:${app.node.gateway.port}\n`);

  let daemon: AnchorDaemon | undefined;
  if (values.anchor) {
    if (!app.isValidator) fail('--anchor requires this peer to be in the registered validator set');
    const settlement = app.connection.settlement;
    if (!settlement) fail('--anchor requires a settlement connection');
    const l1ChainId = values['l1-chain-id'] ?? settlement.chainId;
    if (!l1ChainId) fail('--anchor requires --l1-chain-id <id>');
    if (!values.relayer) fail('--anchor requires --relayer <file> (a funded L1 account)');
    const relayer = readKeyFile(values.relayer);
    daemon = new AnchorDaemon({
      chain: app.chain,
      appId,
      validators: app.genesis.validators.map(decodeAddress),
      keyPair,
      l1: {
        chainId: l1ChainId,
        nodeKey: new Uint8Array(Buffer.from(settlement.nodeKey, 'hex')),
        ...(settlement.bootstrap ? { bootstrap: settlement.bootstrap } : {}),
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
