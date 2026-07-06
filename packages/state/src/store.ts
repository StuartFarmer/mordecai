import { ClassicLevel } from 'classic-level';
import { leafHash, merkleRoot } from './merkle.js';

export interface StateReader {
  get(key: Uint8Array): Promise<Uint8Array | undefined>;
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
  const leaves: Uint8Array[] = [];
  for await (const [key, value] of store.entries()) {
    leaves.push(leafHash(key, value));
  }
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

  constructor(path: string) {
    this.db = new ClassicLevel<Buffer, Buffer>(path, {
      keyEncoding: 'buffer',
      valueEncoding: 'buffer',
    });
  }

  async get(key: Uint8Array): Promise<Uint8Array | undefined> {
    try {
      const value = await this.db.get(Buffer.from(key));
      return value === undefined ? undefined : new Uint8Array(value);
    } catch (err) {
      if ((err as { code?: string }).code === 'LEVEL_NOT_FOUND') return undefined;
      throw err;
    }
  }

  async applyChanges(changes: Iterable<Change>): Promise<void> {
    const ops = [];
    for (const [key, value] of changes) {
      ops.push(
        value === null
          ? ({ type: 'del', key: Buffer.from(key) } as const)
          : ({ type: 'put', key: Buffer.from(key), value: Buffer.from(value) } as const),
      );
    }
    await this.db.batch(ops);
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
