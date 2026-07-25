#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { genesisHash, parseGenesisJson } from '@mordecai/chain';
import { encodeAddress } from '@mordecai/crypto';
import { initNodeDir, joinNodeDir, loadNodeDir } from './config.js';
import { Node } from './node.js';

const USAGE = `mordecai-node — Mordecai node

Usage:
  mordecai-node init  --dir <path> [--chain-id <id>] [--alloc <address>=<amount>]...
                  [--validator <address>]...
  mordecai-node join  --dir <path> --genesis <file>
  mordecai-node start --dir <path> [--block-interval <ms>] [--bootstrap <host:port,...>]

init creates a node key and genesis.json (this node is the default validator).
join creates a node key against an existing network's genesis.json; it prints
     the genesis hash, which is the swarm topic — compare it with the network's
     before starting, since a mismatch lands you on an empty mesh of one.
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
      'chain-id': { type: 'string', default: 'mordecai-dev-1' },
      alloc: { type: 'string', multiple: true, default: [] },
      validator: { type: 'string', multiple: true, default: [] },
      'block-interval': { type: 'string', default: '500' },
      bootstrap: { type: 'string' },
      genesis: { type: 'string' },
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
        JSON.stringify(
          {
            dir,
            chainId: config.genesis.chainId,
            address: config.address,
            genesisHash: Buffer.from(genesisHash(config.genesis)).toString('hex'),
          },
          null,
          2,
        ) + '\n',
      );
      break;
    }
    case 'join': {
      if (!values.genesis) fail('--genesis <file> is required');
      let genesis;
      try {
        genesis = parseGenesisJson(readFileSync(values.genesis, 'utf8'));
      } catch (err) {
        fail(`could not read genesis from ${values.genesis}: ${(err as Error).message}`);
      }
      const config = joinNodeDir({ dir, genesis });
      // Not in the validator set = follower: syncs and serves RPC, no blocks.
      const isValidator = genesis.validators.includes(config.address);
      process.stdout.write(
        JSON.stringify(
          {
            dir,
            chainId: genesis.chainId,
            address: config.address,
            genesisHash: Buffer.from(genesisHash(genesis)).toString('hex'),
            role: isValidator ? 'validator' : 'follower',
          },
          null,
          2,
        ) + '\n',
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
