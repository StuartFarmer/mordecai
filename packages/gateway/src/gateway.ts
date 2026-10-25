import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeRpcClient, RpcError } from '@mordecai/rpc';
import type { Wallet } from '@mordecai/wallet';
import { Faucet, FaucetError } from './faucet.js';

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
 * Outside /api, serves `staticDir` (SPA fallback) or the built-in page and book.
 */
export interface GatewayOptions {
  /** Dedicated funded wallet for an opt-in test-token faucet. Never put this in config. */
  faucet?: Wallet;
  /** Operator-selected fixed grant; defaults to 10,000 base units. */
  faucetAmount?: bigint;
  /** RPC public key of the chain node to bridge to. */
  nodeKey: Uint8Array;
  bootstrap?: { host: string; port: number }[];
  port?: number;
  /** Frontend bundle to serve at /; omit for the built-in Mordecai landing page. */
  staticDir?: string;
  /** Arbitrary JSON served at /api/config (chain id, contract address, dev accounts…). */
  config?: unknown;
  /** Public app-network discovery metadata, kept separate from frontend config. */
  connection?: Record<string, unknown>;
  /** App-chain APIs served on this origin at /api/demos/<name>/api/*. */
  networks?: Record<
    string,
    Pick<GatewayOptions, 'nodeKey' | 'bootstrap' | 'faucet' | 'faucetAmount'>
  >;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

const HEX_RE = /^[0-9a-fA-F]*$/;
const LANDING_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const DOCS_DIR = join(LANDING_DIR, 'docs');
const LANDING_PATHS = new Set([
  '/',
  '/index.html',
  '/mordecai.css',
  '/mordecai.js',
  '/faucet.js',
  '/favicon.svg',
  '/mordecai-image.jpg',
]);

const WALLET_FILES: Record<string, string> = {
  '/wallet.html': '/wallet.html',
  '/wallet-assets/wallet.js': '/wallet-assets/wallet.js',
  '/wallet-assets/mordecai.css': '/mordecai.css',
  '/wallet-assets/faucet.js': '/faucet.js',
};

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
    private readonly networkClients: NodeRpcClient[],
  ) {}

  static async start(options: GatewayOptions): Promise<Gateway> {
    for (const [name, network] of Object.entries(options.networks ?? {})) {
      if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Invalid app network name');
      if (
        network.faucetAmount !== undefined &&
        (network.faucetAmount <= 0n || network.faucetAmount >= 1n << 64n)
      )
        throw new Error('Invalid faucet amount');
    }
    if (
      options.faucetAmount !== undefined &&
      (options.faucetAmount <= 0n || options.faucetAmount >= 1n << 64n)
    )
      throw new Error('Invalid faucet amount');
    const rpc = NodeRpcClient.connect(
      options.nodeKey,
      options.bootstrap ? { bootstrap: options.bootstrap } : {},
    );
    const faucet = options.faucet
      ? new Faucet(rpc, options.faucet, options.faucetAmount)
      : undefined;

    const networks = new Map(
      Object.entries(options.networks ?? {}).map(([name, network]) => {
        const client = NodeRpcClient.connect(
          network.nodeKey,
          network.bootstrap ? { bootstrap: network.bootstrap } : {},
        );
        return [
          name,
          {
            rpc: client,
            faucet: network.faucet
              ? new Faucet(client, network.faucet, network.faucetAmount)
              : undefined,
          },
        ] as const;
      }),
    );
    const networkClients = [...networks.values()].map((network) => network.rpc);

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

      const mounted = path.match(/^\/api\/demos\/([a-z0-9-]+)(\/api\/.*)$/);
      if (mounted) {
        const network = networks.get(mounted[1]!);
        if (!network) return json(res, 404, { error: 'demo is not enabled' });
        return handleApi(req, res, mounted[2]!, url, network.rpc, network.faucet);
      }
      if (path.startsWith('/api/')) return handleApi(req, res, path, url, rpc, faucet);
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (path === '/wallet') {
          res.writeHead(308, { location: './wallet.html' });
          res.end();
          return;
        }
        if (Object.hasOwn(WALLET_FILES, path)) {
          return serveStatic(res, LANDING_DIR, WALLET_FILES[path]!, false);
        }
      }
      if (options.staticDir) return serveStatic(res, options.staticDir, path);
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (path === '/docs' || ['/guide', '/guide/', '/guide.html'].includes(path)) {
          const target =
            path === '/docs'
              ? './docs/'
              : `${path === '/guide/' ? '../' : './'}docs/field-guide.html`;
          res.writeHead(308, { location: target + url.search });
          res.end();
          return;
        }
        if (path.startsWith('/docs/')) {
          let docPath: string;
          try {
            docPath = decodeURIComponent(path.slice('/docs'.length));
          } catch {
            return json(res, 404, { error: 'not found' });
          }
          if (docPath.split(/[/\\]/).includes('..') || docPath.includes('\0')) {
            return json(res, 404, { error: 'not found' });
          }
          return serveStatic(res, DOCS_DIR, docPath, false);
        }
        if (LANDING_PATHS.has(path)) {
          return serveStatic(res, LANDING_DIR, path, false);
        }
      }
      json(res, 404, { error: 'not found' });
    };

    const handleApi = async (
      req: IncomingMessage,
      res: ServerResponse,
      path: string,
      url: URL,
      rpc: NodeRpcClient,
      faucet: Faucet | undefined,
    ): Promise<void> => {
      try {
        if (path === '/api/faucet' && req.method === 'GET') {
          return json(res, 200, faucet?.info() ?? { enabled: false });
        }
        if (path === '/api/faucet' && req.method === 'POST') {
          if (!faucet) return json(res, 503, { error: 'This node has not enabled a faucet.' });
          const body = JSON.parse(await readBody(req, 512)) as { address?: unknown } | null;
          try {
            const result = await faucet.claim(body?.address, req.socket.remoteAddress ?? 'unknown');
            return json(res, 202, result);
          } catch (error) {
            if (!(error instanceof FaucetError)) throw error;
            if (error.retryAfter) res.setHeader('retry-after', error.retryAfter);
            return json(res, error.status, { error: error.message });
          }
        }
        if (req.method === 'GET' && path === '/api/connect') {
          return options.connection
            ? json(res, 200, options.connection)
            : json(res, 404, { error: 'this gateway does not advertise an app network' });
        }
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
          try {
            const hash = await rpc.submitTx(new Uint8Array(Buffer.from(body.tx, 'hex')));
            return json(res, 200, { hash });
          } catch (error) {
            if (error instanceof RpcError && error.rejected)
              return json(res, 400, { error: error.message, rejected: true });
            return json(res, 503, {
              error:
                'Submission could not be confirmed. Check the transaction hash before retrying.',
            });
          }
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

    const serveStatic = async (
      res: ServerResponse,
      dir: string,
      path: string,
      spaFallback = true,
    ): Promise<void> => {
      const rel = normalize(path).replace(/^([/\\]|\.\.)+/, '');
      let file = join(dir, rel === '' || rel === '.' ? 'index.html' : rel);
      try {
        if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      } catch {
        if (!spaFallback) return json(res, 404, { error: 'not found' });
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
    }).catch(async (error: unknown) => {
      await Promise.all([rpc.close(), ...networkClients.map((client) => client.close())]);
      throw error;
    });

    return new Gateway(server, rpc, port, networkClients);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await Promise.all([this.rpc.close(), ...this.networkClients.map((client) => client.close())]);
  }
}
