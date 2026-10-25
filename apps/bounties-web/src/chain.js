import z32 from 'z32';

export const MAX_FEE = 500000n;
export const AWARD_WINDOW = 100;
const utf8 = new TextEncoder();
const bytes = (s) => new Uint8Array(s.match(/../g)?.map((b) => parseInt(b, 16)) ?? []);
const schemas = {
  create: [
    ['title', 'str'],
    ['request', 'str'],
    ['submit_end', 'int'],
  ],
  respond: [
    ['bounty_id', 'int'],
    ['text', 'str'],
  ],
  award: [
    ['bounty_id', 'int'],
    ['response_id', 'int'],
  ],
  cancel: [['bounty_id', 'int']],
  refund: [['bounty_id', 'int']],
};

export function encodeArgs(action, fields) {
  if (!schemas[action]) throw new Error('Unknown bounty action');
  const parts = schemas[action].map(([name, type]) => {
    const value = fields[name];
    if (type === 'int') {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
      const part = new Uint8Array(8);
      new DataView(part.buffer).setBigUint64(0, BigInt(value), true);
      return part;
    }
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
    const text = utf8.encode(value);
    const limit = name === 'title' ? 160 : 8192;
    if (text.length > limit) throw new Error(`${name} exceeds ${limit} UTF-8 bytes`);
    const part = new Uint8Array(4 + text.length);
    new DataView(part.buffer).setUint32(0, text.length, true);
    part.set(text, 4);
    return part;
  });
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export async function act(wallet, config, action, fields, reward = '0') {
  if (!wallet?.sendTransaction) throw new Error('Open Wallet before sending.');
  if (!/^[0-9a-f]{64}$/i.test(config.contract)) throw new Error('Invalid contract');
  if (!/^(0|[1-9][0-9]*)$/.test(String(reward))) throw new Error('Use a whole-number reward');
  const value = BigInt(reward);
  if (value > 18446744073709551615n || (action === 'create' ? value === 0n : value !== 0n))
    throw new Error('Invalid attached reward');
  return wallet.sendTransaction(
    '',
    config.chainId,
    {
      kind: 'execute_contract',
      contract: bytes(config.contract),
      action,
      args: encodeArgs(action, fields),
      value,
    },
    MAX_FEE,
  );
}

async function api(path) {
  const response = await fetch(path, {
    cache: 'no-store',
    signal: globalThis.AbortSignal.timeout(10000),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

export function decodeState(entries) {
  const world = { bounties: {}, answers: {} };
  for (const entry of entries) {
    const key = bytes(entry.key);
    const prefix = new TextDecoder().decode(key).match(/^s:(Bounty|Answer):/);
    if (!prefix) continue;
    const id = Number(new DataView(key.buffer).getBigUint64(prefix[0].length, true));
    const data = bytes(entry.value);
    const view = new DataView(data.buffer);
    let offset = 0;
    const int = () => {
      const n = view.getBigUint64(offset, true);
      offset += 8;
      return n;
    };
    const num = () => {
      const n = int();
      if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unsupported chain integer');
      return Number(n);
    };
    const addr = () => {
      const a = z32.encode(data.subarray(offset, offset + 32));
      offset += 32;
      return a;
    };
    const str = () => {
      const n = view.getUint32(offset, true);
      offset += 4;
      const s = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(offset, offset + n));
      offset += n;
      return s;
    };
    if (prefix[1] === 'Bounty')
      world.bounties[id] = {
        id,
        creator: addr(),
        reward: int().toString(),
        title: str(),
        request: str(),
        submit_end: num(),
        award_end: num(),
        created_height: num(),
        response_count: num(),
        phase: num(),
        winner: num(),
        settled_height: num(),
      };
    else
      world.answers[id] = {
        id,
        bounty_id: num(),
        author: addr(),
        text: str(),
        submitted_height: num(),
      };
  }
  return world;
}

// shortcut: full state scan suits the demo; add pagination before a large public board.
export async function fetchBoard(config) {
  // shortcut: Read the whole small demo board; add pagination before a large public deployment.
  const [entries, head] = await Promise.all([
    api(`/api/contract/${config.contract}/state`),
    api('/api/head'),
  ]);
  if (head.chainId !== config.chainId) throw new Error('Bounty network differs from this node');
  return { ...decodeState(entries), height: Number(head.height) };
}

export function phaseLabel(bounty, height) {
  if (bounty.phase === 1) return 'Award paid';
  if (bounty.phase === 2) return 'Cancelled — refunded';
  if (bounty.phase === 3) return 'No award — refunded';
  if (height >= bounty.award_end) return 'No award — refund available';
  if (height >= bounty.submit_end) return 'Creator selecting';
  return 'Open — reward reserved';
}
