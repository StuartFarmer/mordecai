#!/usr/bin/env node
/**
 * mordecai-gateway — run a browser-facing HTTP gateway against any chain node.
 *
 *   mordecai-gateway --node <rpc-key-hex> [--port 8787] [--static <dir>]
 *                [--config <file.json>] [--bootstrap host:port[,host:port…]]
 */
import { readFileSync } from 'node:fs';
import { Gateway } from './gateway.js';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const nodeKey = arg('--node');
if (!nodeKey || !/^[0-9a-fA-F]{64}$/.test(nodeKey)) {
  console.error(
    'usage: mordecai-gateway --node <rpc-key-hex> [--port 8787] [--static <dir>] ' +
      '[--config <file.json>] [--bootstrap host:port[,host:port…]]',
  );
  process.exit(1);
}

const bootstrap = arg('--bootstrap')
  ?.split(',')
  .map((entry) => {
    const [host, port] = entry.split(':');
    return { host: host!, port: Number(port) };
  });

const configFile = arg('--config');
const staticDir = arg('--static');

const gateway = await Gateway.start({
  nodeKey: new Uint8Array(Buffer.from(nodeKey, 'hex')),
  port: Number(arg('--port') ?? 8787),
  ...(bootstrap ? { bootstrap } : {}),
  ...(staticDir ? { staticDir } : {}),
  ...(configFile ? { config: JSON.parse(readFileSync(configFile, 'utf8')) } : {}),
});

console.log(`gateway listening on http://127.0.0.1:${gateway.port}`);
process.on('SIGINT', async () => {
  await gateway.close();
  process.exit(0);
});
