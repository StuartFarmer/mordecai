import { ClassicLevel } from 'classic-level';
import { leafHash, merkleRoot } from './merkle.js';

export interface StateReader {
  get(key: Uint8Array): Promise<Uint8Array | undefined>;
  /** Synchronous read — required on the contract-execution path. */
  getSync(key: Uint8Array): Uint8Array | undefined;
}

/** A change set: value bytes to put, or null to delete. */
export type Change = [key: Uint8Array, value: Uint8Array | null];

export interface StateStore extends StateReader {
  /** Atomically apply a block's changes. */
  applyChanges(changes: Iterable<Change>): Promise<void>;
  /** All entries in ascending key order. */
  entries(): AsyncIterable<[Uint8Array, Uint8Array]>;
  close(): Promise<void>;
}

/**
 * Full-scan Merkle root over the store (spec D5). O(n) per block — fine at
 * devnet scale; swap for an incremental commitment behind the same interface
 * when it becomes the bottleneck.
 */
export async function computeStateRoot(store: StateStore): Promise<Uint8Array> {
  return computeStateRootWith(store, []);
}

/**
 * Root the store would commit to after applying `changes`, without writing.
 * Merge-joins the store's sorted entries with the sorted change set.
 */
export async function computeStateRootWith(
  store: StateStore,
  changes: readonly Change[],
): Promise<Uint8Array> {
  const leaves: Uint8Array[] = [];
  let i = 0;
  const push = (key: Uint8Array, value: Uint8Array | null) => {
    if (value !== null) leaves.push(leafHash(key, value));
  };
  for await (const [key, value] of store.entries()) {
    let shadowed = false;
    while (i < changes.length) {
      const cmp = compareBytes(changes[i]![0], key);
      if (cmp > 0) break;
      push(changes[i]![0], changes[i]![1]);
      if (cmp === 0) shadowed = true;
      i++;
      if (cmp === 0) break;
    }
    if (!shadowed) push(key, value);
  }
  for (; i < changes.length; i++) push(changes[i]![0], changes[i]![1]);
  return merkleRoot(leaves);
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

export class MemoryStore implements StateStore {
  private readonly data = new Map<string, Uint8Array>();

  async get(key: Uint8Array): Promise<Uint8Array | undefined> {
    return this.data.get(Buffer.from(key).toString('hex'));
  }

  getSync(key: Uint8Array): Uint8Array | undefined {
    return this.data.get(Buffer.from(key).toString('hex'));
  }

  async applyChanges(changes: Iterable<Change>): Promise<void> {
    for (const [key, value] of changes) {
      const hex = Buffer.from(key).toString('hex');
      if (value === null) this.data.delete(hex);
      else this.data.set(hex, value);
    }
  }

  async *entries(): AsyncIterable<[Uint8Array, Uint8Array]> {
    const keys = [...this.data.keys()].sort(); // hex sort == byte sort
    for (const hex of keys) {
      yield [new Uint8Array(Buffer.from(hex, 'hex')), this.data.get(hex)!];
    }
  }

  async close(): Promise<void> {}
}

export class LevelStore implements StateStore {
  private readonly db: ClassicLevel<Buffer, Buffer>;
  private readonly cache = new Map<string, Uint8Array | null>();
  private readonly maxCacheEntries = 100_000;

  constructor(path: string) {
    this.db = new ClassicLevel<Buffer, Buffer>(path, {
      keyEncoding: 'buffer',
      valueEncoding: 'buffer',
    });
  }

  private cacheKey(key: Uint8Array): string {
    return Buffer.from(key).toString('hex');
  }

  private readCached(
    keyHex: string,
  ): { hit: true; value: Uint8Array | undefined } | { hit: false } {
    if (!this.cache.has(keyHex)) return { hit: false };
    const value = this.cache.get(keyHex)!;
    this.cache.delete(keyHex);
    this.cache.set(keyHex, value);
    return { hit: true, value: value === null ? undefined : value.slice() };
  }

  private remember(keyHex: string, value: Uint8Array | null): void {
    this.cache.delete(keyHex);
    this.cache.set(keyHex, value === null ? null : value.slice());
    while (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  async get(key: Uint8Array): Promise<Uint8Array | undefined> {
    const keyHex = this.cacheKey(key);
    const cached = this.readCached(keyHex);
    if (cached.hit) return cached.value;

    try {
      const value = await this.db.get(Buffer.from(key));
      const bytes = value === undefined ? undefined : new Uint8Array(value);
      this.remember(keyHex, bytes ?? null);
      return bytes;
    } catch (err) {
      if ((err as { code?: string }).code === 'LEVEL_NOT_FOUND') {
        this.remember(keyHex, null);
        return undefined;
      }
      throw err;
    }
  }

  getSync(key: Uint8Array): Uint8Array | undefined {
    const keyHex = this.cacheKey(key);
    const cached = this.readCached(keyHex);
    if (cached.hit) return cached.value;

    try {
      const value = this.db.getSync(Buffer.from(key));
      const bytes = value === undefined ? undefined : new Uint8Array(value);
      this.remember(keyHex, bytes ?? null);
      return bytes;
    } catch (err) {
      if ((err as { code?: string }).code === 'LEVEL_NOT_FOUND') {
        this.remember(keyHex, null);
        return undefined;
      }
      throw err;
    }
  }

  async applyChanges(changes: Iterable<Change>): Promise<void> {
    const ops = [];
    const cacheUpdates: [string, Uint8Array | null][] = [];
    for (const [key, value] of changes) {
      cacheUpdates.push([this.cacheKey(key), value === null ? null : value]);
      ops.push(
        value === null
          ? ({ type: 'del', key: Buffer.from(key) } as const)
          : ({ type: 'put', key: Buffer.from(key), value: Buffer.from(value) } as const),
      );
    }
    await this.db.batch(ops);
    for (const [keyHex, value] of cacheUpdates) this.remember(keyHex, value);
  }

  async *entries(): AsyncIterable<[Uint8Array, Uint8Array]> {
    for await (const [key, value] of this.db.iterator()) {
      yield [new Uint8Array(key), new Uint8Array(value)];
    }
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

export { compareBytes };
