import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { NodeRpcClient } from '@mordecai/rpc';

/**
 * Browser-facing edge of the network (web tier of the frontend-flow design):
 * browsers can't join HyperDHT, so any node operator can run one of these to
 * translate JSON-over-HTTP into hyperswarm RPC. Everything that matters is
 * still verified end-to-end — transactions arrive signed, the gateway can
 * refuse service but cannot forge or tamper.
 *
 *   GET  /api/config                       → the operator-provided app config
 *   GET  /api/head                         → chain head
 *   GET  /api/account/<z32 address>        → balance + nonce
 *   GET  /api/tx/<hash hex>                → tx status or 404
 *   POST /api/tx        {"tx": "<hex>"}    → {"hash": "<hex>"} (signed, encoded tx)
 *   GET  /api/app/<appId>                  → registry entry + latest anchor
 *   GET  /api/contract/<id hex>/state[?prefix=<hex>]
 *                                          → [{key, value}] storage entries
 *
 * Anything outside /api serves `staticDir` (SPA fallback to index.html).
 */
export interface GatewayOptions {
  /** RPC public key of the chain node to bridge to. */
  nodeKey: Uint8Array;
  bootstrap?: { host: string; port: number }[];
  port?: number;
  /** Frontend bundle to serve at /; omit for an API-only gateway. */
  staticDir?: string;
  /** Arbitrary JSON served at /api/config (chain id, contract address, dev accounts…). */
  config?: unknown;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

const HEX_RE = /^[0-9a-fA-F]*$/;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit = 1 << 20): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class Gateway {
  private constructor(
    private readonly server: Server,
    private readonly rpc: NodeRpcClient,
    readonly port: number,
  ) {}

  static async start(options: GatewayOptions): Promise<Gateway> {
    const rpc = NodeRpcClient.connect(
      options.nodeKey,
      options.bootstrap ? { bootstrap: options.bootstrap } : {},
    );

    const server = createServer((req, res) => {
      handle(req, res).catch((err) => {
        if (!res.headersSent) json(res, 500, { error: String(err?.message ?? err) });
        else res.end();
      });
    });

    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      // permissive CORS: the gateway is a public read/submit endpoint
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url ?? '/', 'http://gateway');
      const path = url.pathname;

      if (path.startsWith('/api/')) return handleApi(req, res, path, url);
      if (options.staticDir) return serveStatic(res, options.staticDir, path);
      json(res, 404, { error: 'not found' });
    };

    const handleApi = async (
      req: IncomingMessage,
      res: ServerResponse,
      path: string,
      url: URL,
    ): Promise<void> => {
      try {
        if (req.method === 'GET' && path === '/api/config') {
          return json(res, 200, options.config ?? {});
        }
        if (req.method === 'GET' && path === '/api/head') {
          return json(res, 200, await rpc.getHead());
        }
        const account = path.match(/^\/api\/account\/([a-z0-9]+)$/);
        if (req.method === 'GET' && account) {
          return json(res, 200, await rpc.getAccount(account[1]!));
        }
        const tx = path.match(/^\/api\/tx\/([0-9a-fA-F]{64})$/);
        if (req.method === 'GET' && tx) {
          const info = await rpc.getTx(tx[1]!.toLowerCase());
          if (!info) return json(res, 404, { error: 'tx not found' });
          return json(res, 200, info);
        }
        if (req.method === 'POST' && path === '/api/tx') {
          const body = JSON.parse(await readBody(req)) as { tx?: string };
          if (typeof body.tx !== 'string' || !HEX_RE.test(body.tx)) {
            return json(res, 400, { error: 'expected {"tx": "<hex>"}' });
          }
          const hash = await rpc.submitTx(new Uint8Array(Buffer.from(body.tx, 'hex')));
          return json(res, 200, { hash });
        }
        const app = path.match(/^\/api\/app\/([^/]+)$/);
        if (req.method === 'GET' && app) {
          const appId = decodeURIComponent(app[1]!);
          const [entry, anchor] = await Promise.all([rpc.getApp(appId), rpc.getAppAnchor(appId)]);
          if (!entry) return json(res, 404, { error: `app not registered: ${appId}` });
          return json(res, 200, { ...entry, anchor });
        }
        const state = path.match(/^\/api\/contract\/([0-9a-fA-F]{64})\/state$/);
        if (req.method === 'GET' && state) {
          const prefix = url.searchParams.get('prefix') ?? undefined;
          if (prefix !== undefined && !HEX_RE.test(prefix)) {
            return json(res, 400, { error: 'prefix must be hex' });
          }
          const entries = await rpc.getContractState(
            new Uint8Array(Buffer.from(state[1]!, 'hex')),
            prefix ? new Uint8Array(Buffer.from(prefix, 'hex')) : undefined,
          );
          return json(res, 200, entries);
        }
        json(res, 404, { error: 'unknown api route' });
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    };

    const serveStatic = async (res: ServerResponse, dir: string, path: string): Promise<void> => {
      const rel = normalize(path).replace(/^([/\\]|\.\.)+/, '');
      let file = join(dir, rel === '' || rel === '.' ? 'index.html' : rel);
      try {
        if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      } catch {
        file = join(dir, 'index.html'); // SPA fallback
      }
      try {
        const body = await readFile(file);
        res.writeHead(200, {
          'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        });
        res.end(body);
      } catch {
        json(res, 404, { error: 'not found' });
      }
    };

    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, () => {
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : (options.port ?? 0));
      });
    });

    return new Gateway(server, rpc, port);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await this.rpc.close();
  }
}
