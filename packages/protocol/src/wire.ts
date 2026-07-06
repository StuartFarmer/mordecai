/**
 * Canonical wire codec.
 *
 * Every protocol structure has exactly one valid byte representation:
 * fixed-width little-endian integers, u32 length prefixes, UTF-8 strings
 * (decoded in fatal mode), and strict full-consumption checks on decode.
 * Canonical bytes are what get hashed and signed, so decode must reject
 * anything encode could not have produced.
 */

export class WireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WireError';
  }
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

const U32_MAX = 0xffffffff;
const U64_MAX = 0xffffffffffffffffn;

export class Writer {
  private buf: Uint8Array;
  private view: DataView;
  private len = 0;

  constructor(initialCapacity = 256) {
    this.buf = new Uint8Array(initialCapacity);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let capacity = this.buf.length * 2;
    while (capacity < this.len + extra) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new WireError(`u8 out of range: ${value}`);
    }
    this.ensure(1);
    this.buf[this.len] = value;
    this.len += 1;
  }

  u32(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > U32_MAX) {
      throw new WireError(`u32 out of range: ${value}`);
    }
    this.ensure(4);
    this.view.setUint32(this.len, value, true);
    this.len += 4;
  }

  u64(value: bigint): void {
    if (typeof value !== 'bigint' || value < 0n || value > U64_MAX) {
      throw new WireError(`u64 out of range: ${value}`);
    }
    this.ensure(8);
    this.view.setBigUint64(this.len, value, true);
    this.len += 8;
  }

  bool(value: boolean): void {
    this.u8(value ? 1 : 0);
  }

  /** Raw bytes with no length prefix (for fixed-size fields and domain tags). */
  raw(bytes: Uint8Array): void {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  /** Fixed-size field: asserts the expected size, writes no prefix. */
  fixed(bytes: Uint8Array, size: number): void {
    if (bytes.length !== size) {
      throw new WireError(`fixed(${size}) got ${bytes.length} bytes`);
    }
    this.raw(bytes);
  }

  /** Variable-size bytes: u32 length prefix, bounded by maxLen. */
  bytes(bytes: Uint8Array, maxLen: number): void {
    if (bytes.length > maxLen) {
      throw new WireError(`bytes length ${bytes.length} exceeds limit ${maxLen}`);
    }
    this.u32(bytes.length);
    this.raw(bytes);
  }

  /** UTF-8 string: u32 byte-length prefix, bounded by maxByteLen. */
  string(value: string, maxByteLen: number): void {
    this.bytes(utf8Encoder.encode(value), maxByteLen);
  }

  array<T>(items: readonly T[], maxCount: number, writeItem: (w: Writer, item: T) => void): void {
    if (items.length > maxCount) {
      throw new WireError(`array length ${items.length} exceeds limit ${maxCount}`);
    }
    this.u32(items.length);
    for (const item of items) writeItem(this, item);
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export class Reader {
  private off = 0;
  private readonly view: DataView;

  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  private need(n: number): void {
    if (this.off + n > this.buf.length) {
      throw new WireError(`unexpected end of input (need ${n} bytes at offset ${this.off})`);
    }
  }

  u8(): number {
    this.need(1);
    const value = this.buf[this.off]!;
    this.off += 1;
    return value;
  }

  u32(): number {
    this.need(4);
    const value = this.view.getUint32(this.off, true);
    this.off += 4;
    return value;
  }

  u64(): bigint {
    this.need(8);
    const value = this.view.getBigUint64(this.off, true);
    this.off += 8;
    return value;
  }

  bool(): boolean {
    const value = this.u8();
    if (value > 1) throw new WireError(`invalid bool byte: ${value}`);
    return value === 1;
  }

  fixed(size: number): Uint8Array {
    this.need(size);
    const value = this.buf.slice(this.off, this.off + size);
    this.off += size;
    return value;
  }

  bytes(maxLen: number): Uint8Array {
    const len = this.u32();
    if (len > maxLen) {
      throw new WireError(`bytes length ${len} exceeds limit ${maxLen}`);
    }
    return this.fixed(len);
  }

  string(maxByteLen: number): string {
    const bytes = this.bytes(maxByteLen);
    try {
      return utf8Decoder.decode(bytes);
    } catch {
      throw new WireError('invalid UTF-8 in string');
    }
  }

  array<T>(maxCount: number, readItem: (r: Reader) => T): T[] {
    const count = this.u32();
    if (count > maxCount) {
      throw new WireError(`array length ${count} exceeds limit ${maxCount}`);
    }
    const items: T[] = [];
    for (let i = 0; i < count; i++) items.push(readItem(this));
    return items;
  }

  remaining(): number {
    return this.buf.length - this.off;
  }

  /** Canonicality check: every byte of input must have been consumed. */
  finish(): void {
    if (this.off !== this.buf.length) {
      throw new WireError(`${this.buf.length - this.off} trailing bytes after decode`);
    }
  }
}

export function utf8(value: string): Uint8Array {
  return utf8Encoder.encode(value);
}
