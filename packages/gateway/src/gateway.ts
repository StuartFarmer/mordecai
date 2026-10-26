import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeRpcClient, RpcError } from '@mordecai/rpc';
import type { Wallet } from '@mordecai/wallet';
import { Faucet, FaucetError } from './faucet.js';
import { assertSameOrigin, clientIp } from './request-context.js';
import { Accounts } from './accounts.js';

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
  /** Trust Railway's HTTP edge headers; never enable with direct public access to the port. */
  trustRailwayProxy?: boolean;
  /** Trust Render's Cloudflare edge for visitor IPs; requires no direct public access. */
  trustRenderProxy?: boolean;
  /** Dedicated funded wallet for an opt-in test-token faucet. Never put this in config. */
  faucet?: Wallet;
  /** Operator-selected fixed grant; defaults to 10,000 base units. */
  faucetAmount?: bigint;
  /** Enables durable one-time account grants and disables every public faucet route. */
  accountsDir?: string;
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
  /** Optional authenticated Chess room service; limited to its own URL namespace. */
  demoHandler?: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;
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
const SITE_DIR = join(LANDING_DIR, 'site');
const DOCS_DIR = join(SITE_DIR, 'docs');
const LANDING_PATHS = new Set([
  '/mordecai.css',
  '/mordecai.js',
  '/faucet.js',
  '/favicon.svg',
  '/mordecai-image.jpg',
  '/demo-assets/hex.js',
  '/demo-assets/frontier.js',
  '/demo-assets/outpost.js',
  '/demo-assets/chess.js',
  '/demo-assets/microblog.js',
  '/demo-assets/bounties.js',
]);

const WALLET_FILES: Record<string, string> = {
  '/wallet-assets/wallet.js': '/wallet-assets/wallet.js',
  '/wallet-assets/mordecai.css': '/mordecai.css',
  '/wallet-assets/mordecai.js': '/mordecai.js',
  '/wallet-assets/favicon.svg': '/favicon.svg',
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
    if (options.accountsDir && !options.faucet)
      throw new Error('Account registration requires a funding key');
    const accounts =
      options.accountsDir && options.faucet
        ? new Accounts(options.accountsDir, (await rpc.getHead()).chainId, {
            l1: { rpc, wallet: options.faucet, amount: 1_000_000n },
            ...Object.fromEntries(
              Object.entries(options.networks ?? {})
                .filter(([, n]) => n.faucet)
                .map(([name, n]) => [
                  name,
                  {
                    rpc: networks.get(name)!.rpc,
                    wallet: n.faucet!,
                    amount: n.faucetAmount ?? 1_000_000_000n,
                  },
                ]),
            ),
          })
        : undefined;

    const server = createServer((req, res) => {
      handle(req, res).catch((err) => {
        if (!res.headersSent) json(res, 500, { error: String(err?.message ?? err) });
        else res.end();
      });
    });

    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (req.url?.startsWith('/api/')) res.setHeader('cache-control', 'no-store');
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

      if (path === '/api/accounts' || path.startsWith('/api/accounts/')) {
        if (!accounts)
          return json(res, 503, {
            enabled: false,
            error: 'New account registration is unavailable on this node.',
          });
        try {
          if (path === '/api/accounts' && req.method === 'GET')
            return json(res, 200, accounts.info(clientIp(req, options)));
          if (path === '/api/accounts' && req.method === 'POST') {
            assertSameOrigin(req, options.trustRailwayProxy);
            return json(
              res,
              200,
              await accounts.register(
                JSON.parse(await readBody(req, 1024)),
                clientIp(req, options),
              ),
            );
          }
          const address = path.match(/^\/api\/accounts\/([a-z0-9]{52})$/)?.[1];
          const status = address && req.method === 'GET' ? accounts.status(address) : null;
          return json(
            res,
            status ? 200 : 404,
            status ?? { error: 'Account registration not found' },
          );
        } catch (error) {
          if (error instanceof FaucetError && error.retryAfter)
            res.setHeader('retry-after', error.retryAfter);
          return json(res, error instanceof FaucetError ? error.status : 400, {
            error: error instanceof Error ? error.message : 'Invalid registration',
          });
        }
      }

      if (
        (path === '/api/demos/chess/rooms' ||
          path.startsWith('/api/demos/chess/rooms/') ||
          path === '/api/demos/microblog' ||
          path.startsWith('/api/demos/microblog/')) &&
        (await options.demoHandler?.(req, res, url))
      )
        return;

      const mounted = path.match(/^\/api\/demos\/([a-z0-9-]+)(\/api\/.*)$/);
      if (mounted) {
        const network = networks.get(mounted[1]!);
        if (!network) return json(res, 404, { error: 'demo is not enabled' });
        return handleApi(req, res, mounted[2]!, url, network.rpc, network.faucet);
      }
      if (path.startsWith('/api/')) return handleApi(req, res, path, url, rpc, faucet);
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (path === '/wallet' || path === '/account') {
          res.writeHead(308, { location: './account.html' });
          res.end();
          return;
        }
        if (path === '/account.html' || path === '/wallet.html')
          return serveStatic(res, SITE_DIR, '/account.html', false);
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
        if (path === '/' || path === '/index.html')
          return serveStatic(res, SITE_DIR, '/index.html', false);
        if (path.startsWith('/_astro/') || path.startsWith('/pagefind/')) {
          let asset: string;
          try {
            asset = decodeURIComponent(path);
          } catch {
            return json(res, 404, { error: 'not found' });
          }
          if (asset.split(/[/\\]/).includes('..') || asset.includes('\0'))
            return json(res, 404, { error: 'not found' });
          return serveStatic(res, SITE_DIR, asset, false);
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
        if (accounts && path === '/api/faucet')
          return json(res, req.method === 'GET' ? 200 : 403, {
            enabled: false,
            error:
              'Public faucet access is disabled. New accounts receive a one-time registration grant.',
          });
        if (path === '/api/faucet' && req.method === 'GET') {
          return json(res, 200, faucet?.info() ?? { enabled: false });
        }
        if (path === '/api/faucet' && req.method === 'POST') {
          if (!faucet) return json(res, 503, { error: 'This node has not enabled a faucet.' });
          const body = JSON.parse(await readBody(req, 512)) as { address?: unknown } | null;
          try {
            const result = await faucet.claim(body?.address, clientIp(req, options));
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
