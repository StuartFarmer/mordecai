# The Contract VM

Contract execution must be **bit-identical on every validator** — any
divergence forks the chain. HSSN gets this with an unusual but simple
construction: **the wasmi interpreter, itself compiled to WebAssembly,
running inside the node's JS engine.**

```text
V8 (node process)
 └─ hssn_vm_runtime.wasm        ← wasmi interpreter + validation (Rust)
     └─ contract.wasm           ← the contract, INTERPRETED by wasmi
          imports "env.*"  → bridged to →  "host.*" → JS state overlay
```

## Why this design

- **Determinism**: contracts are interpreted with wasmi's deterministic
  fuel metering. The host JIT (V8) never executes contract code directly,
  so JIT tiering, platform float quirks, and timing never leak in.
- **Fuel**: wasmi counts instructions exactly; the JS host separately
  meters host-call costs (storage reads/writes, transfers, events). Both
  meters are deterministic; `out of fuel` is the same on every validator.
- **Portability**: the runtime artifact (`packages/vm/wasm/`) is committed,
  so JS-only development and CI need no Rust toolchain.
- The wasmtime-native-binding route was evaluated first and rejected — the
  npm binding is unmaintained (see `IMPLEMENTATION_PLAN.md` D1).

## Validation at deploy

A module is deployable only if it passes the runtime's validator:

- parses under a **restricted feature set — no floats, no SIMD, no
  threads** (the classic nondeterminism vectors are rejected wholesale);
- imports nothing outside the contract ABI (`env.*`);
- exports its linear memory.

Both the mempool and block execution enforce this, so invalid code never
reaches state.

## Execution limits

| Limit                     | Value                                                |
| ------------------------- | ---------------------------------------------------- |
| memory                    | 4 MiB                                                |
| storage key / value       | 256 B / 64 KiB                                       |
| event size / count        | 4 KiB / 64 per tx                                    |
| return data               | 64 KiB                                               |
| cross-contract call depth | 4                                                    |
| fuel                      | `min(MAX_FUEL, (maxFee − staticFee) × FUEL_PER_FEE)` |

## Isolation and revert

Each contract owns a storage namespace (`cs:<contract-id>:`) that no other
contract can touch; the only interaction is message passing via the `call`
host function, and each sub-call executes in its own overlay so a failed
callee reverts cleanly while the caller decides what to do with the status.
A failed top-level action reverts _everything_ — storage writes, attached
value, payouts — while still consuming the fee and nonce.

The environment available to contracts (`caller`, `attached value`, `block
height`, storage, `transfer`, `emit`, `call`) is documented in
[Rust Contracts & the ABI](../contracts/rust-abi.md); no clock, randomness,
network, or filesystem exists by construction.
