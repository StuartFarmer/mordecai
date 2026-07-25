// Chain access for the frontier web client. Talks JSON to an HSSN gateway
// (/api/*) and signs transactions right here in the browser: Ed25519 via
// @noble/curves over @hssn/protocol's canonical signing bytes — the same
// bytes sodium signs in the wallet daemon. The gateway never sees a key.

import { ed25519 } from '@noble/curves/ed25519';
import z32 from 'z32';
import { encodeTransaction, transactionSigningBytes } from '@hssn/protocol';

const utf8 = new TextEncoder();

const hexToBytes = (hex) => new Uint8Array(hex.match(/../g)?.map((b) => parseInt(b, 16)) ?? []);
const bytesToHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

async function api(path, init) {
  const res = await fetch(path, init);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `http ${res.status}`);
  return body;
}

/** Load the gateway's app config (chain id, contract, dev accounts). */
export function fetchConfig() {
  return api('/api/config');
}

/** Derive a signing identity from a dev-account seed ({name, seed}). */
export function connect(config, account) {
  const seed = hexToBytes(account.seed);
  const publicKey = ed25519.getPublicKey(seed);
  return { name: account.name, address: z32.encode(publicKey), publicKey, seed };
}

// ------------------------------------------------------------ transactions

// Contract action signatures, in declared parameter order (frontier.pysc).
const ACTIONS = {
  claim_tile: [['tile_id', 'u64']],
  transfer_tile: [
    ['tile_id', 'u64'],
    ['to', 'address'],
  ],
  build: [
    ['tile_id', 'u64'],
    ['kind', 'str'],
  ],
  harvest: [['tile_id', 'u64']],
  place_order: [
    ['give', 'str'],
    ['give_amount', 'u64'],
    ['want', 'str'],
    ['want_amount', 'u64'],
  ],
  fill_order: [['order_id', 'u64']],
  cancel_order: [['order_id', 'u64']],
};

/** ArgReader-compatible encoding: u64 = 8 LE, str/address = u32 LE len + bytes. */
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

/** Execute a frontier action ({action_name: {fields}}); returns {height, gasUsed}. */
export async function act(player, config, msg) {
  const action = Object.keys(msg)[0];
  const schema = ACTIONS[action];
  if (!schema) throw new Error(`unknown action ${action}`);

  const account = await api(`/api/account/${player.address}`);
  const unsigned = {
    chainId: config.chainId,
    nonce: BigInt(account.nonce),
    sender: player.publicKey,
    maxFee: 500000n,
    payload: {
      kind: 'execute_contract',
      contract: hexToBytes(config.contract),
      value: 0n,
      action,
      args: encodeArgs(schema, msg[action]),
    },
  };
  const signature = ed25519.sign(transactionSigningBytes(unsigned), player.seed);
  const { hash } = await api('/api/tx', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tx: bytesToHex(encodeTransaction({ ...unsigned, signature })) }),
  });

  for (let i = 0; i < 100; i++) {
    const res = await fetch(`/api/tx/${hash}`);
    if (res.ok) {
      const info = await res.json();
      if (!info.success) throw new Error(info.error || 'transaction failed');
      return { height: Number(info.height), gasUsed: info.fee };
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('transaction not confirmed in time');
}

// ------------------------------------------------------------ world reads

// Decoders for the DSL codegen's storage layout: keys are "s:<Map>:" +
// (u64 LE | 32-byte pubkey), values are the struct fields in declared
// order (u64 = 8 LE, str = u32 LE len + utf8, address = 32 raw, bool = 1).
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
    bool: () => bytes[o++] === 1,
  };
}

const MAPS = {
  Tile: {
    key: 'u64',
    decode: (r) => ({ owner: r.addr(), building: r.str(), last_tick_height: r.u64() }),
  },
  Account: {
    key: 'addr',
    decode: (r) => ({ wood: r.u64(), wheat: r.u64() }),
  },
  Order: {
    key: 'u64',
    decode: (r) => ({
      maker: r.addr(),
      give: r.str(),
      give_amount: r.u64(),
      want: r.str(),
      want_amount: r.u64(),
      open: r.bool(),
    }),
  },
  Meta: {
    key: 'u64',
    decode: (r) => ({ next_order_id: r.u64() }),
  },
};

/** Read the whole contract state in one gateway call and decode it. */
export async function fetchWorld(config) {
  const entries = await api(`/api/contract/${config.contract}/state`);
  const world = { tiles: {}, accounts: {}, orders: {}, meta: {}, config: null };
  for (const { key, value } of entries) {
    const keyBytes = hexToBytes(key);
    const keyStr = new TextDecoder().decode(keyBytes);
    if (keyStr === 'cfg') {
      world.config = { max_tiles: reader(hexToBytes(value)).u64() };
      continue;
    }
    const m = keyStr.match(/^s:(\w+):/);
    if (!m || !MAPS[m[1]]) continue;
    const map = MAPS[m[1]];
    const rest = keyBytes.subarray(m[0].length);
    const mapKey =
      map.key === 'u64'
        ? Number(new DataView(rest.buffer, rest.byteOffset).getBigUint64(0, true))
        : z32.encode(rest);
    const decoded = map.decode(reader(hexToBytes(value)));
    if (m[1] === 'Tile') world.tiles[mapKey] = decoded;
    else if (m[1] === 'Account') world.accounts[mapKey] = decoded;
    else if (m[1] === 'Order') world.orders[mapKey] = decoded;
    else world.meta = decoded;
  }
  return world;
}

/** Latest block height. */
export async function fetchHeight() {
  const head = await api('/api/head');
  return Number(head.height);
}

/** Native token balance. */
export async function fetchBalance(player) {
  const account = await api(`/api/account/${player.address}`);
  return Number(account.balance);
}
