import { isIP } from 'node:net';
import { genesisHash } from '@mordecai/chain';
import { MAX_APP_VALIDATORS, MAX_CHAIN_ID_BYTES } from '@mordecai/protocol';
import { appChainGenesis } from './genesis.js';

type Bootstrap = { host: string; port: number }[];

export interface SettlementConnection {
  nodeKey: string;
  chainId?: string;
  bootstrap?: Bootstrap;
}

export interface AppConnection {
  version: 1;
  appId: string;
  nodeKey: string;
  genesisHash: string;
  chainValidators: string[];
  feedKeys: string[];
  bootstrap?: Bootstrap;
  settlement?: SettlementConnection;
}

/** Bare domain names remain app IDs; DNS hostnames require an HTTP(S) scheme. */
export function peerUrl(target: string): URL | undefined {
  let url: URL;
  if (/^https?:\/\//i.test(target)) url = new URL(target);
  else if (isIP(target) === 6) url = new URL(`http://[${target}]`);
  else if (isIP(target) === 4 || target.startsWith('[') || /^\d+\.\d+\.\d+\.\d+:/.test(target)) {
    url = new URL(`http://${target}`);
    if (!isIP(url.hostname.replace(/^\[|\]$/g, ''))) throw new Error('invalid peer IP address');
  } else {
    if (/[:/]/.test(target)) throw new Error('peer URLs must use http:// or https://');
    return undefined;
  }
  if (url.username || url.password || url.hash) {
    throw new Error('peer URLs must not contain credentials or fragments');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/api/connect') ? path : `${path}/api/connect`;
  return url;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`invalid ${label}`);
  return value as Record<string, unknown>;
}

function hexKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('connection keys and hashes must be 32-byte hex strings');
  }
  return value.toLowerCase();
}

function keys(value: unknown, limit: number): string[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error('invalid connection key list');
  const result = value.map(hexKey);
  if (new Set(result).size !== result.length) throw new Error('duplicate connection keys');
  return result;
}

function bootstrap(value: unknown): Bootstrap {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64)
    throw new Error('invalid bootstrap list');
  return value.map((entry) => {
    const item = object(entry, 'bootstrap endpoint');
    if (
      typeof item.host !== 'string' ||
      !item.host ||
      item.host.length > 253 ||
      /[\s/]/.test(item.host) ||
      typeof item.port !== 'number' ||
      !Number.isInteger(item.port) ||
      item.port < 1 ||
      item.port > 65535
    ) {
      throw new Error('invalid bootstrap endpoint');
    }
    return { host: item.host, port: item.port };
  });
}

export function parseSettlement(value: unknown): SettlementConnection {
  const entry = object(value, 'settlement connection');
  if (
    entry.chainId !== undefined &&
    (typeof entry.chainId !== 'string' ||
      !entry.chainId ||
      Buffer.byteLength(entry.chainId) > MAX_CHAIN_ID_BYTES)
  )
    throw new Error('invalid settlement chain ID');
  return {
    nodeKey: hexKey(entry.nodeKey),
    ...(typeof entry.chainId === 'string' ? { chainId: entry.chainId } : {}),
    ...(entry.bootstrap !== undefined ? { bootstrap: bootstrap(entry.bootstrap) } : {}),
  };
}

/** Validate and select public fields; never inherit an operator's frontend config. */
export function parseConnection(value: unknown): AppConnection {
  const doc = object(value, 'app connection document');
  if (doc.version !== 1) throw new Error('unsupported app connection version');
  if (
    typeof doc.appId !== 'string' ||
    !doc.appId ||
    /\s/.test(doc.appId) ||
    Buffer.byteLength(`app:${doc.appId}`) > MAX_CHAIN_ID_BYTES
  )
    throw new Error('invalid app ID');
  const chainValidators = keys(doc.chainValidators, MAX_APP_VALIDATORS);
  const genesis = appChainGenesis(
    doc.appId,
    chainValidators.map((key) => new Uint8Array(Buffer.from(key, 'hex'))),
  );
  if (hexKey(doc.genesisHash) !== Buffer.from(genesisHash(genesis)).toString('hex')) {
    throw new Error('connection genesis hash does not match app configuration');
  }

  return {
    version: 1,
    appId: doc.appId,
    nodeKey: hexKey(doc.nodeKey),
    genesisHash: hexKey(doc.genesisHash),
    chainValidators,
    feedKeys: keys(doc.feedKeys, 1024),
    ...(doc.bootstrap !== undefined ? { bootstrap: bootstrap(doc.bootstrap) } : {}),
    ...(doc.settlement !== undefined ? { settlement: parseSettlement(doc.settlement) } : {}),
  };
}

export async function readConnection(url: URL): Promise<AppConnection> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`peer connection lookup failed: HTTP ${response.status}`);
  }
  if (!response.body) throw new Error('empty peer connection response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1 << 20) throw new Error('peer connection document exceeds 1 MiB');
      chunks.push(value);
    }
    return parseConnection(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } finally {
    await reader.cancel();
  }
}
