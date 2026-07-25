import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EXEC_ABORTED,
  EXEC_NO_ACTION,
  EXEC_OK,
  EXEC_OUT_OF_FUEL,
  VALIDATE_FORBIDDEN_FEATURE,
  VALIDATE_OK,
  VALIDATE_PARSE_ERROR,
  VmRuntime,
  type VmHost,
} from '../src/index.js';

const counter = readFileSync(
  fileURLToPath(new URL('../../../contracts/dist/counter.wasm', import.meta.url)),
);
const floaty = readFileSync(fileURLToPath(new URL('./fixtures/floaty.wasm', import.meta.url)));

function mapHost(storage = new Map<string, Uint8Array>()): VmHost & {
  storage: Map<string, Uint8Array>;
  events: Uint8Array[];
} {
  const events: Uint8Array[] = [];
  const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
  return {
    storage,
    events,
    storageGet: (key) => storage.get(hex(key)),
    storageSet: (key, value) => void storage.set(hex(key), value),
    storageDelete: (key) => void storage.delete(hex(key)),
    transfer: () => true,
    emit: (event) => void events.push(event),
    call: () => -1n,
  };
}

const CALLER = new Uint8Array(32).fill(7);

function run(action: string, host = mapHost(), args = new Uint8Array(0), fuel = 1_000_000n) {
  return VmRuntime.execute({
    code: counter,
    action,
    args,
    caller: CALLER,
    value: 0n,
    height: 7n,
    timeMs: 1_700_000_000_000n,
    fuel,
    host,
  });
}

describe('VmRuntime.validate', () => {
  it('accepts the counter contract', () => {
    expect(VmRuntime.validate(counter)).toBe(VALIDATE_OK);
  });

  it('rejects float-using modules', () => {
    expect(VmRuntime.validate(floaty)).toBe(VALIDATE_FORBIDDEN_FEATURE);
  });

  it('rejects garbage', () => {
    expect(VmRuntime.validate(new Uint8Array([1, 2, 3]))).toBe(VALIDATE_PARSE_ERROR);
  });
});

describe('VmRuntime.execute', () => {
  it('runs an action with storage, returns, and events', () => {
    const host = mapHost();
    const first = run('increment', host);
    expect(first.status).toBe(EXEC_OK);
    expect(Buffer.from(first.returnData).readBigUInt64LE()).toBe(1n);
    const second = run('increment', host);
    expect(Buffer.from(second.returnData).readBigUInt64LE()).toBe(2n);
    expect(new TextDecoder().decode(host.events[0])).toBe('count=1');
  });

  it('reads args and exposes the caller', () => {
    const host = mapHost();
    const args = Buffer.alloc(8);
    args.writeBigUInt64LE(41n);
    const added = run('add', host, new Uint8Array(args));
    expect(Buffer.from(added.returnData).readBigUInt64LE()).toBe(41n);
    const who = run('whoami', host);
    expect(who.returnData).toEqual(CALLER);
  });

  it('is fuel-deterministic and halts runaway loops', () => {
    const a = run('spin', mapHost(), new Uint8Array(0), 100_000n);
    const b = run('spin', mapHost(), new Uint8Array(0), 100_000n);
    expect(a.status).toBe(EXEC_OUT_OF_FUEL);
    expect(a.fuelUsed).toBe(b.fuelUsed);
    // Same action, same fuel elsewhere too.
    const c = run('increment', mapHost());
    const d = run('increment', mapHost());
    expect(c.fuelUsed).toBe(d.fuelUsed);
  });

  it('reports aborts with the contract message', () => {
    const result = run('boom');
    expect(result.status).toBe(EXEC_ABORTED);
    expect(result.error).toBe('boom: deliberate abort');
  });

  it('rejects unknown actions', () => {
    expect(run('nope').status).toBe(EXEC_NO_ACTION);
  });
});
