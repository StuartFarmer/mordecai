import type { Change, StateReader } from './store.js';

/**
 * Buffered writes over a base reader. Blocks execute against an overlay;
 * each transaction gets a child overlay so failed transactions revert
 * cleanly while successful ones merge into the block overlay.
 */
export class Overlay implements StateReader {
  private readonly writes = new Map<string, { key: Uint8Array; value: Uint8Array | null }>();

  constructor(private readonly base: StateReader) {}

  async get(key: Uint8Array): Promise<Uint8Array | undefined> {
    const hit = this.writes.get(Buffer.from(key).toString('hex'));
    if (hit) return hit.value ?? undefined;
    return this.base.get(key);
  }

  set(key: Uint8Array, value: Uint8Array): void {
    this.writes.set(Buffer.from(key).toString('hex'), { key: key.slice(), value: value.slice() });
  }

  delete(key: Uint8Array): void {
    this.writes.set(Buffer.from(key).toString('hex'), { key: key.slice(), value: null });
  }

  /** Buffered changes in ascending key order (deterministic). */
  changes(): Change[] {
    return [...this.writes.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, w]) => [w.key, w.value] as Change);
  }

  /** Merge this overlay's writes into the parent (transaction success path). */
  commitInto(parent: Overlay): void {
    for (const [key, value] of this.changes()) {
      if (value === null) parent.delete(key);
      else parent.set(key, value);
    }
  }

  get size(): number {
    return this.writes.size;
  }
}
