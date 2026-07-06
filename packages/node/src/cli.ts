#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { encodeAddress } from '@hssn/crypto';
import { initNodeDir, loadNodeDir } from './config.js';
import { Node } from './node.js';

const USAGE = `hssn-node — Holepunch Smart Settlement Network node

Usage:
  hssn-node init  --dir <path> [--chain-id <id>] [--alloc <address>=<amount>]...
                  [--validator <address>]...
  hssn-node start --dir <path> [--block-interval <ms>] [--bootstrap <host:port,...>]

init creates a node key and genesis.json (this node is the default validator).
start runs the sequencer and serves RPC on the node's public key.
`;

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n\n${USAGE}`);
  process.exit(1);
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
      'chain-id': { type: 'string', default: 'hssn-dev-1' },
      alloc: { type: 'string', multiple: true, default: [] },
      validator: { type: 'string', multiple: true, default: [] },
      'block-interval': { type: 'string', default: '500' },
      bootstrap: { type: 'string' },
    },
  });
  const dir = values.dir;
  if (!dir) fail('--dir is required');

  switch (command) {
    case 'init': {
      const allocations = (values.alloc ?? []).map((pair) => {
        const eq = pair.indexOf('=');
        if (eq < 0) fail(`--alloc must be <address>=<amount>, got: ${pair}`);
        return { address: pair.slice(0, eq), balance: BigInt(pair.slice(eq + 1)) };
      });
      const validators = values.validator ?? [];
      const config = initNodeDir({
        dir,
        chainId: values['chain-id']!,
        allocations,
        ...(validators.length > 0 ? { validators } : {}),
      });
      process.stdout.write(
        JSON.stringify({ dir, chainId: config.genesis.chainId, address: config.address }, null, 2) +
          '\n',
      );
      break;
    }
    case 'start': {
      const config = loadNodeDir(dir);
      const bootstrap = values.bootstrap
        ? values.bootstrap.split(',').map((entry) => {
            const [host, port] = entry.split(':');
            return { host: host!, port: Number(port) };
          })
        : undefined;
      const node = await Node.start({
        dir,
        genesis: config.genesis,
        keyPair: config.keyPair,
        blockIntervalMs: Number(values['block-interval']),
        ...(bootstrap ? { bootstrap } : {}),
        log: (message) => process.stdout.write(`${new Date().toISOString()} ${message}\n`),
      });
      process.stdout.write(`chain:    ${config.genesis.chainId}\n`);
      process.stdout.write(`height:   ${node.chain.height}\n`);
      process.stdout.write(`address:  ${config.address}\n`);
      process.stdout.write(`rpc key:  ${encodeAddress(node.rpcPublicKey)}\n`);
      process.stdout.write('node running — Ctrl-C to stop\n');
      const shutdown = () => {
        void node.stop().then(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      // Keep the process alive; RPC + timer are unref'd.
      await new Promise(() => {});
      break;
    }
    default:
      fail(`unknown command: ${command}`);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
