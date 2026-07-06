/**
 * Contract-call argument encoder. Matches the contract-side ArgReader
 * (contracts/runtime-rs) and the DSL's parameter decoding: u64 = 8 bytes
 * LE, bool = u64 0/1, bytes/str = u32 LE length prefix, address = 32
 * bytes with a length prefix.
 */
export class ContractArgs {
  private chunks: Uint8Array[] = [];

  u64(value: bigint): this {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(value);
    this.chunks.push(new Uint8Array(b));
    return this;
  }

  bool(value: boolean): this {
    return this.u64(value ? 1n : 0n);
  }

  bytes(value: Uint8Array): this {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(value.length);
    this.chunks.push(new Uint8Array(len), value);
    return this;
  }

  str(value: string): this {
    return this.bytes(new TextEncoder().encode(value));
  }

  address(publicKey: Uint8Array): this {
    if (publicKey.length !== 32) throw new RangeError('address must be 32 bytes');
    return this.bytes(publicKey);
  }

  encode(): Uint8Array {
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}
