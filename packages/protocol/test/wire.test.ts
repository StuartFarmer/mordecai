import { describe, expect, it } from 'vitest';
import { Reader, WireError, Writer } from '../src/index.js';

describe('Writer/Reader primitives', () => {
  it('round-trips every primitive', () => {
    const w = new Writer();
    w.u8(0xab);
    w.u32(0xdeadbeef);
    w.u64(0xffffffffffffffffn);
    w.u64(0n);
    w.bool(true);
    w.bool(false);
    w.fixed(Uint8Array.from([1, 2, 3]), 3);
    w.bytes(Uint8Array.from([9, 8]), 10);
    w.string('héllo', 32);
    w.array([5, 6, 7], 8, (wr, v) => wr.u8(v));

    const r = new Reader(w.finish());
    expect(r.u8()).toBe(0xab);
    expect(r.u32()).toBe(0xdeadbeef);
    expect(r.u64()).toBe(0xffffffffffffffffn);
    expect(r.u64()).toBe(0n);
    expect(r.bool()).toBe(true);
    expect(r.bool()).toBe(false);
    expect(r.fixed(3)).toEqual(Uint8Array.from([1, 2, 3]));
    expect(r.bytes(10)).toEqual(Uint8Array.from([9, 8]));
    expect(r.string(32)).toBe('héllo');
    expect(r.array(8, (rd) => rd.u8())).toEqual([5, 6, 7]);
    r.finish();
  });

  it('grows the buffer past its initial capacity', () => {
    const w = new Writer(4);
    const big = new Uint8Array(1000).fill(7);
    w.bytes(big, 2000);
    const r = new Reader(w.finish());
    expect(r.bytes(2000)).toEqual(big);
    r.finish();
  });

  it('rejects out-of-range integers on write', () => {
    const w = new Writer();
    expect(() => w.u8(256)).toThrow(WireError);
    expect(() => w.u8(-1)).toThrow(WireError);
    expect(() => w.u8(1.5)).toThrow(WireError);
    expect(() => w.u32(0x1_0000_0000)).toThrow(WireError);
    expect(() => w.u64(-1n)).toThrow(WireError);
    expect(() => w.u64(0x1_0000_0000_0000_0000n)).toThrow(WireError);
  });

  it('rejects wrong-size fixed fields on write', () => {
    const w = new Writer();
    expect(() => w.fixed(new Uint8Array(31), 32)).toThrow(WireError);
  });

  it('enforces length limits on both sides', () => {
    const w = new Writer();
    expect(() => w.bytes(new Uint8Array(11), 10)).toThrow(WireError);
    expect(() => w.string('x'.repeat(33), 32)).toThrow(WireError);
    expect(() => w.array([1, 2, 3], 2, (wr, v) => wr.u8(v))).toThrow(WireError);

    const ok = new Writer();
    ok.bytes(new Uint8Array(11), 11);
    const r = new Reader(ok.finish());
    expect(() => r.bytes(10)).toThrow(WireError);
  });

  it('rejects truncated input', () => {
    const r = new Reader(Uint8Array.from([1, 2, 3]));
    expect(() => r.u32()).toThrow(WireError);
  });

  it('rejects trailing bytes via finish()', () => {
    const r = new Reader(Uint8Array.from([1, 0]));
    r.u8();
    expect(() => r.finish()).toThrow(/trailing/);
  });

  it('rejects non-canonical bool bytes', () => {
    const r = new Reader(Uint8Array.from([2]));
    expect(() => r.bool()).toThrow(WireError);
  });

  it('rejects invalid UTF-8 in strings', () => {
    const w = new Writer();
    w.bytes(Uint8Array.from([0xff, 0xfe]), 10);
    const r = new Reader(w.finish());
    expect(() => r.string(10)).toThrow(/UTF-8/);
  });

  it('reads correctly from an offset view into a larger buffer', () => {
    const backing = new Uint8Array(16).fill(0xaa);
    const view = backing.subarray(4, 12);
    const w = new Writer();
    w.u32(1);
    w.u32(2);
    view.set(w.finish());
    const r = new Reader(view);
    expect(r.u32()).toBe(1);
    expect(r.u32()).toBe(2);
    r.finish();
  });
});
