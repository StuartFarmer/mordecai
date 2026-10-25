import type Hypercore from 'hypercore';

/**
 * An append-only, signed, replicated log (spec §6 "Shared State").
 * Thin typed wrapper over Hypercore.
 */
export class Feed {
  constructor(private readonly core: Hypercore) {}

  async ready(): Promise<void> {
    await this.core.ready();
  }

  /** Public key identifying (and verifying) this feed. */
  get key(): Uint8Array {
    return this.core.key;
  }

  /** Swarm topic for finding peers of this feed (does not reveal the key). */
  get discoveryKey(): Uint8Array {
    return this.core.discoveryKey;
  }

  get length(): number {
    return this.core.length;
  }

  get writable(): boolean {
    return this.core.writable;
  }

  /** Whether a block is already stored locally (without requesting it). */
  has(index: number): Promise<boolean> {
    return this.core.has(index);
  }

  async append(block: Uint8Array | string): Promise<void> {
    const bytes = typeof block === 'string' ? new TextEncoder().encode(block) : block;
    await this.core.append(bytes);
  }

  /** Fetch a block, downloading from peers if not held locally. */
  async get(index: number, options?: { timeout?: number }): Promise<Uint8Array> {
    const block = await this.core.get(index, { wait: true, ...options });
    if (block === null) throw new Error(`feed block ${index} unavailable`);
    return new Uint8Array(block);
  }

  /** Wait until a connected peer advertises a longer feed. */
  async update(): Promise<boolean> {
    return this.core.update({ wait: true });
  }

  /** Download existing and future blocks until this subscription is stopped. */
  seed(): () => void {
    const range = this.core.download({ start: 0, end: -1 });
    let stopped = false;
    void range.done().catch((error: unknown) => {
      if (!stopped) console.error('feed download failed:', error);
    });
    return () => {
      stopped = true;
      range.destroy();
    };
  }

  /** Subscribe to appends; returns an unsubscribe function. */
  onAppend(listener: () => void): () => void {
    this.core.on('append', listener);
    return () => {
      this.core.off('append', listener);
    };
  }

  async close(): Promise<void> {
    await this.core.close();
  }
}
