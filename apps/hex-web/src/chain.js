// Two-chain access for the hex client. The wallet is a fresh Ed25519 seed
// generated in the browser and kept in localStorage — the SAME identity
// signs game moves on the app chain and escrow stakes on L1. The gateways
// and the faucet never see a key; only signed transactions travel.

import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import z32 from 'z32';
import { encodeTransaction, transactionSigningBytes } from '@mordecai/protocol';

export const SIZE = 11;

const utf8 = new TextEncoder();

const hexToBytes = (hex) => new Uint8Array(hex.match(/../g)?.map((b) => parseInt(b, 16)) ?? []);
const bytesToHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

async function api(base, path, init) {
  const res = await fetch(`${base}${path}`, init);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `http ${res.status}`);
  return body;
}

/**
 * Load the L1 gateway's app config. Sibling services (app-chain gateway,
 * faucet) are addressed by port on the host the page came from, so a
 * player on another machine reaches the right box automatically.
 */
export async function fetchConfig() {
  const cfg = await api('', '/api/config');
  const host = window.location.hostname;
  return {
    ...cfg,
    appApi: `http://${host}:${cfg.appApiPort}`,
    faucet: `http://${host}:${cfg.faucetPort}`,
  };
}

/** The browser wallet: one seed in localStorage, one identity everywhere. */
export function wallet() {
  let seedHex = localStorage.getItem('hex-wallet-seed');
  if (!seedHex) {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    seedHex = bytesToHex(seed);
    localStorage.setItem('hex-wallet-seed', seedHex);
  }
  const seed = hexToBytes(seedHex);
  const publicKey = ed25519.getPublicKey(seed);
  return { address: z32.encode(publicKey), publicKey, seed };
}

/** Ask the host's faucet to fund this identity on both chains. */
export function requestFunds(config, player) {
  return api(config.faucet, '/faucet', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: player.address }),
  });
}

/**
 * A game code (whatever the players agree on out of band) maps to the u64
 * id keying both the app-chain Game and the L1 Pot: the first 8 bytes of
 * its SHA-256, little-endian.
 */
export function gameIdFromCode(code) {
  const digest = sha256(utf8.encode(code.trim()));
  return new DataView(digest.buffer, digest.byteOffset, 8).getBigUint64(0, true);
}

// ------------------------------------------------------------ transactions

// Argument schemas in declared parameter order.
const HEX_ACTIONS = {
  create: [['game_id', 'u64']],
  join: [['game_id', 'u64']],
  cancel: [['game_id', 'u64']],
  place: [
    ['game_id', 'u64'],
    ['r', 'u64'],
    ['c', 'u64'],
  ],
  prove_start: [
    ['game_id', 'u64'],
    ['r', 'u64'],
    ['c', 'u64'],
  ],
  prove_step: [
    ['game_id', 'u64'],
    ['r', 'u64'],
    ['c', 'u64'],
  ],
  claim_timeout: [['game_id', 'u64']],
  resign: [['game_id', 'u64']],
};
const ESCROW_ACTIONS = {
  create: [['game_id', 'u64']],
  join: [['game_id', 'u64']],
  cancel: [['game_id', 'u64']],
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
    config.hex,
    action,
    encodeArgs(HEX_ACTIONS[action], msg[action]),
  );
}

/** An escrow action on L1; `value` carries the stake. */
export function stake(player, config, msg, value = 0n) {
  const action = Object.keys(msg)[0];
  return sendTx(
    '',
    config.chainId,
    player,
    config.escrow,
    action,
    encodeArgs(ESCROW_ACTIONS[action], msg[action]),
    value,
  );
}

// ------------------------------------------------------------ state reads

function reader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  return {
    u64: () => {
      const v = view.getBigUint64(o, true);
      o += 8;
      return v;
    },
    bool: () => bytes[o++] === 1,
    addr: () => {
      const a = z32.encode(bytes.subarray(o, o + 32));
      o += 32;
      return a;
    },
  };
}

function mapEntries(entries, map) {
  const prefix = `s:${map}:`;
  const out = [];
  for (const { key, value } of entries) {
    const keyBytes = hexToBytes(key);
    if (new TextDecoder().decode(keyBytes.subarray(0, prefix.length)) !== prefix) continue;
    const rest = keyBytes.subarray(prefix.length);
    out.push({
      id: new DataView(rest.buffer, rest.byteOffset).getBigUint64(0, true),
      read: reader(hexToBytes(value)),
    });
  }
  return out;
}

function decodeGame(r) {
  return {
    creator: r.addr(),
    opponent: r.addr(),
    winner: r.addr(),
    phase: Number(r.u64()), // 0 open, 1 active, 2 won, 3 cancelled
    turn: Number(r.u64()),
    moves: Number(r.u64()),
    base: r.u64(),
    deadline: Number(r.u64()),
    proofPlayer: r.addr(),
    proofLive: r.bool(),
    proofR: Number(r.u64()),
    proofC: Number(r.u64()),
  };
}

/** One game + its board from the app chain, or null if the id is unknown. */
export async function fetchGame(config, gameId) {
  const entries = await api(config.appApi, `/api/contract/${config.hex}/state`);
  let game = null;
  for (const { id, read } of mapEntries(entries, 'Game')) {
    if (id === gameId) game = decodeGame(read);
  }
  if (!game) return null;

  const board = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  for (const { id, read } of mapEntries(entries, 'Cell')) {
    const offset = id - game.base;
    if (offset < 0n || offset >= BigInt(SIZE * SIZE)) continue;
    const cell = { owner: read.addr(), side: Number(read.u64()) };
    board[Number(offset / BigInt(SIZE))][Number(offset % BigInt(SIZE))] = cell;
  }
  return { ...game, board };
}

/** The L1 escrow pot for a game id, or null before the creator stakes. */
export async function fetchPot(config, gameId) {
  const entries = await api('', `/api/contract/${config.escrow}/state`);
  for (const { id, read } of mapEntries(entries, 'Pot')) {
    if (id !== gameId) continue;
    return {
      creator: read.addr(),
      opponent: read.addr(),
      stake: Number(read.u64()),
      phase: Number(read.u64()), // 0 open, 1 active, 2 closed
    };
  }
  return null;
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

// ------------------------------------------------------------ hex geometry

/** The six hex neighbours of (r, c) that are on the board. */
export function neighbours(r, c) {
  return [
    [r, c - 1],
    [r, c + 1],
    [r - 1, c],
    [r + 1, c],
    [r - 1, c + 1],
    [r + 1, c - 1],
  ].filter(([nr, nc]) => nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE);
}

/**
 * BFS over one side's stones. side 0 (creator, red) connects row 0 to row
 * SIZE-1; side 1 (opponent, blue) connects column 0 to column SIZE-1.
 * Returns the winning path (start edge → target edge) or null.
 */
export function winningPath(board, side) {
  const mine = (r, c) => board[r][c]?.side === side;
  const prev = new Map(); // "r,c" → parent key or null for start-edge cells
  const queue = [];
  for (let i = 0; i < SIZE; i++) {
    const [r, c] = side === 0 ? [0, i] : [i, 0];
    if (mine(r, c)) {
      prev.set(`${r},${c}`, null);
      queue.push([r, c]);
    }
  }
  while (queue.length > 0) {
    const [r, c] = queue.shift();
    if (side === 0 ? r === SIZE - 1 : c === SIZE - 1) {
      const path = [];
      for (let key = `${r},${c}`; key !== null; key = prev.get(key)) {
        path.unshift(key.split(',').map(Number));
      }
      return path;
    }
    for (const [nr, nc] of neighbours(r, c)) {
      const key = `${nr},${nc}`;
      if (mine(nr, nc) && !prev.has(key)) {
        prev.set(key, `${r},${c}`);
        queue.push([nr, nc]);
      }
    }
  }
  return null;
}
