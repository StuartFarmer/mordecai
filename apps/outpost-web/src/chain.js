// Two-chain access for the outpost client. The SAME wallet identity
// (one Ed25519 seed) signs on both chains: game moves go to the app
// chain's gateway, market orders go to the L1 gateway. Signing happens
// in the browser; the gateways never see a key.

import { ed25519 } from '@noble/curves/ed25519';
import z32 from 'z32';
import { encodeTransaction, transactionSigningBytes } from '@mordecai/protocol';

const utf8 = new TextEncoder();

const hexToBytes = (hex) => new Uint8Array(hex.match(/../g)?.map((b) => parseInt(b, 16)) ?? []);
const bytesToHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

async function api(base, path, init) {
  const res = await fetch(`${base}${path}`, init);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `http ${res.status}`);
  return body;
}

/** Load the L1 gateway's app config (contracts, app gateway URL, accounts). */
export function fetchConfig() {
  return api('', '/api/config');
}

/** One identity for both chains, derived from a dev-account seed. */
export function connect(config, account) {
  const seed = hexToBytes(account.seed);
  const publicKey = ed25519.getPublicKey(seed);
  return { name: account.name, address: z32.encode(publicKey), publicKey, seed };
}

// ------------------------------------------------------------ transactions

// Argument schemas in declared parameter order.
const GAME_ACTIONS = {
  claim_tile: [['tile_id', 'u64']],
  build: [
    ['tile_id', 'u64'],
    ['kind', 'str'],
  ],
  harvest: [['tile_id', 'u64']],
  deliver: [
    ['order_id', 'u64'],
    ['buyer', 'address'],
    ['good', 'str'],
    ['amount', 'u64'],
  ],
};
const MARKET_ACTIONS = {
  place_order: [
    ['good', 'str'],
    ['amount', 'u64'],
  ],
  cancel_order: [['order_id', 'u64']],
};

function encodeArgs(schema, fields) {
  const parts = [];
  for (const [name, ty] of schema) {
    const v = fields[name];
    if (ty === 'u64') {
      const b = new Uint8Array(8);
      new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
      parts.push(b);
    } else {
      const bytes = ty === 'address' ? z32.decode(v) : utf8.encode(v);
      const len = new Uint8Array(4);
      new DataView(len.buffer).setUint32(0, bytes.length, true);
      parts.push(len, bytes);
    }
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function sendTx(base, chainId, player, contract, action, args, value = 0n) {
  const account = await api(base, `/api/account/${player.address}`);
  const unsigned = {
    chainId,
    nonce: BigInt(account.nonce),
    sender: player.publicKey,
    maxFee: 500000n,
    payload: {
      kind: 'execute_contract',
      contract: hexToBytes(contract),
      value,
      action,
      args,
    },
  };
  const signature = ed25519.sign(transactionSigningBytes(unsigned), player.seed);
  const { hash } = await api(base, '/api/tx', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tx: bytesToHex(encodeTransaction({ ...unsigned, signature })) }),
  });
  for (let i = 0; i < 100; i++) {
    const res = await fetch(`${base}/api/tx/${hash}`);
    if (res.ok) {
      const info = await res.json();
      if (!info.success) throw new Error(info.error || 'transaction failed');
      return { height: Number(info.height), fee: info.fee };
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('transaction not confirmed in time');
}

/** A game move ({action: {fields}}) on the app chain. */
export function play(player, config, msg) {
  const action = Object.keys(msg)[0];
  return sendTx(
    config.appApi,
    config.appChainId,
    player,
    config.outpost,
    action,
    encodeArgs(GAME_ACTIONS[action], msg[action]),
  );
}

/** A market action on L1; `value` carries the escrowed payment. */
export function trade(player, config, msg, value = 0n) {
  const action = Object.keys(msg)[0];
  return sendTx(
    '',
    config.chainId,
    player,
    config.market,
    action,
    encodeArgs(MARKET_ACTIONS[action], msg[action]),
    value,
  );
}

// ------------------------------------------------------------ world reads

function reader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  return {
    u64: () => {
      const v = Number(view.getBigUint64(o, true));
      o += 8;
      return v;
    },
    str: () => {
      const n = view.getUint32(o, true);
      o += 4;
      const s = new TextDecoder().decode(bytes.subarray(o, o + n));
      o += n;
      return s;
    },
    addr: () => {
      const a = z32.encode(bytes.subarray(o, o + 32));
      o += 32;
      return a;
    },
  };
}

function decodeEntries(entries, decoders) {
  const out = {};
  for (const key of Object.keys(decoders)) out[key.toLowerCase()] = {};
  for (const { key, value } of entries) {
    const keyBytes = hexToBytes(key);
    const keyStr = new TextDecoder().decode(keyBytes);
    const m = keyStr.match(/^s:(\w+):/);
    if (!m || !decoders[m[1]]) continue;
    const rest = keyBytes.subarray(m[0].length);
    const spec = decoders[m[1]];
    const mapKey =
      spec.key === 'u64'
        ? Number(new DataView(rest.buffer, rest.byteOffset).getBigUint64(0, true))
        : z32.encode(rest);
    out[m[1].toLowerCase()][mapKey] = spec.decode(reader(hexToBytes(value)));
  }
  return out;
}

/** Game state from the app chain: tiles, player goods, deliveries. */
export async function fetchWorld(config) {
  const entries = await api(config.appApi, `/api/contract/${config.outpost}/state`);
  const world = decodeEntries(entries, {
    Tile: {
      key: 'u64',
      decode: (r) => ({ owner: r.addr(), building: r.str(), last_tick_height: r.u64() }),
    },
    Account: { key: 'addr', decode: (r) => ({ wood: r.u64(), wheat: r.u64() }) },
    Delivery: {
      key: 'u64',
      decode: (r) => ({ seller: r.addr(), buyer: r.addr(), good: r.str(), amount: r.u64() }),
    },
  });
  return { tiles: world.tile, accounts: world.account, deliveries: world.delivery };
}

/** Market state from L1: escrowed buy orders. */
export async function fetchMarket(config) {
  const entries = await api('', `/api/contract/${config.market}/state`);
  const state = decodeEntries(entries, {
    Order: {
      key: 'u64',
      decode: (r) => ({
        buyer: r.addr(),
        good: r.str(),
        amount: r.u64(),
        price: r.u64(),
        phase: r.u64(), // 0 open, 1 settled, 2 cancelled
      }),
    },
  });
  return state.order;
}

/** Both chain heads plus the latest anchor. */
export async function fetchStatus(config) {
  const [l1Head, appHead, app] = await Promise.all([
    api('', '/api/head'),
    api(config.appApi, '/api/head'),
    api('', `/api/app/${config.appId}`),
  ]);
  return {
    l1Height: Number(l1Head.height),
    appHeight: Number(appHead.height),
    anchor: app.anchor, // {epoch, appHeight, stateRoot} | null
  };
}

/** L1 currency balance. */
export async function fetchBalance(player) {
  const account = await api('', `/api/account/${player.address}`);
  return Number(account.balance);
}
