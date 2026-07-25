import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Contract executor. The runtime is the wasmi interpreter compiled to
 * wasm32 (packages/vm/runtime), so contract execution is interpreted,
 * fuel-metered, and bit-identical on every validator — the host V8 JIT
 * never executes contract code directly.
 *
 * All host callbacks are synchronous; storage revert on failure is the
 * caller's job (execute against a discardable overlay).
 */

export const VALIDATE_OK = 0;
export const VALIDATE_PARSE_ERROR = 1;
export const VALIDATE_FORBIDDEN_FEATURE = 2;
export const VALIDATE_BAD_IMPORT = 3;
export const VALIDATE_NO_MEMORY = 4;

export const EXEC_OK = 0;
export const EXEC_TRAP = 1;
export const EXEC_OUT_OF_FUEL = 2;
export const EXEC_ACTION_FAILED = 3;
export const EXEC_NO_ACTION = 4;
export const EXEC_INVALID_MODULE = 5;
export const EXEC_ABORTED = 6;

export function validationError(status: number): string {
  switch (status) {
    case VALIDATE_PARSE_ERROR:
      return 'not a valid wasm module';
    case VALIDATE_FORBIDDEN_FEATURE:
      return 'module uses a forbidden feature (floats/simd/threads)';
    case VALIDATE_BAD_IMPORT:
      return 'module imports outside the contract ABI';
    case VALIDATE_NO_MEMORY:
      return 'module does not export its memory';
    default:
      return `validation failed (${status})`;
  }
}

export interface VmHost {
  storageGet(key: Uint8Array): Uint8Array | undefined;
  storageSet(key: Uint8Array, value: Uint8Array): void;
  storageDelete(key: Uint8Array): void;
  /** Pay out of the executing contract's balance. False = insufficient. */
  transfer(to: Uint8Array, amount: bigint): boolean;
  emit(event: Uint8Array): void;
  /**
   * Cross-contract call. Returns the sub-call's fuel use on success or a
   * negative status. The chain layer implements recursion + depth caps.
   */
  call(
    contract: Uint8Array,
    action: Uint8Array,
    args: Uint8Array,
    value: bigint,
    fuelRemaining: bigint,
  ): bigint;
}

export interface ExecuteParams {
  code: Uint8Array;
  action: string;
  args: Uint8Array;
  /** 32 bytes: tx sender, or calling contract id in sub-calls. */
  caller: Uint8Array;
  value: bigint;
  /** Height of the block being executed. */
  height: bigint;
  /** Timestamp (ms) of the block being executed. */
  timeMs: bigint;
  fuel: bigint;
  host: VmHost;
}

export interface ExecuteResult {
  status: number;
  returnData: Uint8Array;
  error: string;
  fuelUsed: bigint;
}

/** Marker for deterministic host-side execution aborts (e.g. fuel). */
export class VmHostError extends Error {
  constructor(
    message: string,
    readonly outOfFuel = false,
  ) {
    super(message);
    this.name = 'VmHostError';
  }
}

interface RuntimeExports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  reset(): void;
  validate(ptr: number, len: number): number;
  execute(
    codePtr: number,
    codeLen: number,
    actionPtr: number,
    actionLen: number,
    argsPtr: number,
    argsLen: number,
    callerPtr: number,
    value: bigint,
    height: bigint,
    timeMs: bigint,
    fuel: bigint,
  ): number;
  ret_ptr(): number;
  ret_len(): number;
  err_ptr(): number;
  err_len(): number;
  fuel_used(): bigint;
}

const wasmPath = fileURLToPath(new URL('../wasm/hssn_vm_runtime.wasm', import.meta.url));

let cachedModule: WebAssembly.Module | undefined;

function runtimeModule(): WebAssembly.Module {
  cachedModule ??= new WebAssembly.Module(readFileSync(wasmPath));
  return cachedModule;
}

const stubHost: VmHost = {
  storageGet: () => undefined,
  storageSet: () => {},
  storageDelete: () => {},
  transfer: () => false,
  emit: () => {},
  call: () => -1n,
};

function instantiate(host: VmHost): { exports: RuntimeExports } {
  const active = host;
  let stash: Uint8Array = new Uint8Array(0);
  // Filled right after instantiation; host imports only run during execute().
  const holder = {} as { exports: RuntimeExports };

  const outer = () => new Uint8Array(holder.exports.memory.buffer);
  const read = (ptr: number, len: number) => outer().slice(ptr, ptr + len);

  const instance = new WebAssembly.Instance(runtimeModule(), {
    host: {
      host_storage_get: (kp: number, kl: number): bigint => {
        const value = active.storageGet(read(kp, kl));
        if (value === undefined) return -1n;
        stash = value;
        return BigInt(value.length);
      },
      host_storage_read: (dst: number): void => {
        outer().set(stash, dst);
      },
      host_storage_set: (kp: number, kl: number, vp: number, vl: number): void => {
        active.storageSet(read(kp, kl), read(vp, vl));
      },
      host_storage_del: (kp: number, kl: number): void => {
        active.storageDelete(read(kp, kl));
      },
      host_transfer: (to: number, amount: bigint): number =>
        active.transfer(read(to, 32), amount) ? 0 : 1,
      host_emit: (ptr: number, len: number): void => {
        active.emit(read(ptr, len));
      },
      host_call: (
        contract: number,
        actionPtr: number,
        actionLen: number,
        argsPtr: number,
        argsLen: number,
        value: bigint,
        fuel: bigint,
      ): bigint =>
        active.call(
          read(contract, 32),
          read(actionPtr, actionLen),
          read(argsPtr, argsLen),
          value,
          fuel,
        ),
    },
  });
  holder.exports = instance.exports as unknown as RuntimeExports;
  return holder;
}

export class VmRuntime {
  /** Validate a contract module; VALIDATE_OK (0) means deployable. */
  static validate(code: Uint8Array): number {
    const { exports } = instantiate(stubHost);
    const ptr = exports.alloc(code.length);
    new Uint8Array(exports.memory.buffer).set(code, ptr);
    return exports.validate(ptr, code.length);
  }

  /** Execute one action. Fresh runtime instance per call — full isolation. */
  static execute(params: ExecuteParams): ExecuteResult {
    if (params.caller.length !== 32) throw new RangeError('caller must be 32 bytes');
    const { exports } = instantiate(params.host);
    const put = (bytes: Uint8Array): number => {
      const ptr = exports.alloc(bytes.length);
      new Uint8Array(exports.memory.buffer).set(bytes, ptr);
      return ptr;
    };
    const action = new TextEncoder().encode(params.action);
    const codePtr = put(params.code);
    const actionPtr = put(action);
    const argsPtr = put(params.args);
    const callerPtr = put(params.caller);
    try {
      const status = exports.execute(
        codePtr,
        params.code.length,
        actionPtr,
        action.length,
        argsPtr,
        params.args.length,
        callerPtr,
        params.value,
        params.height,
        params.timeMs,
        params.fuel,
      );
      const ret = new Uint8Array(exports.memory.buffer).slice(
        exports.ret_ptr(),
        exports.ret_ptr() + exports.ret_len(),
      );
      const err = new TextDecoder().decode(
        new Uint8Array(exports.memory.buffer).slice(
          exports.err_ptr(),
          exports.err_ptr() + exports.err_len(),
        ),
      );
      return { status, returnData: ret, error: err, fuelUsed: exports.fuel_used() };
    } catch (err) {
      // A throwing host import unwinds the whole runtime deterministically.
      if (err instanceof VmHostError && err.outOfFuel) {
        return {
          status: EXEC_OUT_OF_FUEL,
          returnData: new Uint8Array(0),
          error: err.message,
          fuelUsed: params.fuel,
        };
      }
      return {
        status: EXEC_TRAP,
        returnData: new Uint8Array(0),
        error: err instanceof Error ? err.message : String(err),
        fuelUsed: params.fuel,
      };
    }
  }
}
