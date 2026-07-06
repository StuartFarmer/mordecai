#!/usr/bin/env node
/**
 * hssn-launcher — deterministic app install (spec §17).
 *
 *   hssn-launcher install <appId> --node <rpc-key-hex> --out <dir>
 *                 [--bootstrap host:port,...]
 *
 * Registry lookup → fetch the bundle over the swarm from whoever has it →
 * verify against the on-chain hash → write it locally. The serving peer is
 * untrusted; the chain entry is the authority. Launching the bundle is the
 * Pear shell's job (`pear run <dir>` once the bundle is a Pear project).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { blake2b256 } from '@hssn/crypto';
import { Network } from '@hssn/networking';
import { NodeRpcClient } from '@hssn/rpc';

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [command, appId, ...rest] = process.argv.slice(2);
  if (command !== 'install' || !appId) {
    process.stdout.write(
      'usage: hssn-launcher install <appId> --node <rpc-key-hex> --out <dir> ' +
        '[--bootstrap host:port,...]\n',
    );
    process.exit(command ? 1 : 0);
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      node: { type: 'string' },
      out: { type: 'string' },
      bootstrap: { type: 'string' },
    },
  });
  if (!values.node) fail('--node is required');
  if (!values.out) fail('--out is required');
  const bootstrap = values.bootstrap
    ? values.bootstrap.split(',').map((entry) => {
        const [host, port] = entry.split(':');
        return { host: host!, port: Number(port) };
      })
    : undefined;

  const rpc = NodeRpcClient.connect(
    new Uint8Array(Buffer.from(values.node, 'hex')),
    bootstrap ? { bootstrap } : {},
  );
  const cache = mkdtempSync(join(tmpdir(), 'hssn-launcher-'));
  const network = Network.create({ storageDir: cache, ...(bootstrap ? { bootstrap } : {}) });
  try {
    const entry = await rpc.getApp(appId);
    if (!entry) fail(`app not registered: ${appId}`);
    process.stderr.write(`registry: ${appId} v${entry.version} by ${entry.owner}\n`);

    const feed = await network.openFeed(new Uint8Array(Buffer.from(entry.pearKey, 'hex')));
    await network.joinFeed(feed);
    const bundle = await feed.get(0, { timeout: 30_000 });
    const digest = Buffer.from(blake2b256(bundle)).toString('hex');
    if (digest !== entry.metadataHash) {
      fail(`bundle hash mismatch for ${appId}: refusing to install`);
    }

    mkdirSync(values.out, { recursive: true });
    const target = join(values.out, 'bundle.bin');
    writeFileSync(target, bundle);
    writeFileSync(
      join(values.out, 'app.json'),
      JSON.stringify({ ...entry, verified: true }, null, 2) + '\n',
    );
    process.stdout.write(`installed ${appId} v${entry.version} -> ${target} (hash verified)\n`);
  } finally {
    await rpc.close();
    await network.close();
    rmSync(cache, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  fail(err instanceof Error ? err.message : String(err));
});
