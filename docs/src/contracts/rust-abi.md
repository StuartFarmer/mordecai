# Rust Contracts & the ABI

The DSL is a frontend; the actual contract interface is a small WASM ABI
that any language can target. Rust contracts use the
`hssn-contract` crate (`contracts/runtime-rs`) — the shipped `counter` and
`marketplace` contracts are written this way.

## Shape of a contract

```rust
use hssn_contract as c;

#[unsafe(no_mangle)]
pub extern "C" fn buy() -> i32 {          // one export per action
    let mut args = c::ArgReader::new();
    let item_id = args.u64();

    let Some(raw) = c::storage_get(&key(item_id)) else {
        c::fail("no such item");          // abort: everything reverts
    };
    // ... decode, check, mutate ...
    c::storage_set(&key(item_id), &encoded);
    c::emit(b"sold");
    0                                     // 0 = success; non-zero = failure
}
```

Compile with `crate-type = ["cdylib"]` to `wasm32-unknown-unknown`
(`scripts/build-wasm.sh` shows the exact invocation). The module must
export its memory (Rust cdylibs do by default) and import nothing beyond
the ABI below — validation enforces this at deploy.

## The `hssn-contract` API

| Function                                         | Meaning                                           |
| ------------------------------------------------ | ------------------------------------------------- |
| `storage_get(key) -> Option<Vec<u8>>`            | read own namespace                                |
| `storage_set(key, value)` / `storage_del(key)`   | write / delete (key ≤ 256 B, value ≤ 64 KiB)      |
| `caller() -> [u8; 32]`                           | tx sender, or calling contract id in sub-calls    |
| `attached_value() -> u64`                        | currency attached to this call (already credited) |
| `block_height() -> u64`                          | height of the enclosing block                     |
| `args() -> Vec<u8>` / `ArgReader`                | raw argument bytes / cursor (u64, bytes, address) |
| `set_return(bytes)`                              | fill the receipt's `returnData`                   |
| `emit(bytes)`                                    | append a receipt event (≤ 4 KiB, ≤ 64/tx)         |
| `fail(msg) -> !`                                 | abort with a message; all effects revert          |
| `transfer(&to, amount) -> bool`                  | pay from the contract's balance                   |
| `call_contract(&id, action, args, value) -> i32` | message another contract (depth ≤ 4)              |

That is the _entire_ environment. No clock, no randomness, no I/O — if it
isn't in this table, a contract can't do it, which is exactly what makes
execution reproducible across validators.

## Discipline the DSL gives you for free

Hand-written Rust must self-enforce what the DSL compiler guarantees:

- **Checked arithmetic.** Release-profile Rust wraps on overflow — use
  `checked_add/checked_sub` (or `overflow-checks = true`) for anything
  touching balances.
- **Deterministic encodings.** Fixed field order, little-endian integers,
  length-prefixed strings. Never serialize a HashMap.
- **No panics with meaning.** `panic = "abort"` traps generically; prefer
  `c::fail("reason")` so users see why.
- **No floats anywhere** — validation rejects the whole module if LLVM
  emits a single float opcode (test with `VmRuntime.validate` before
  deploying).

## Testing without a chain

`@hssn/vm` executes a module directly against an in-memory host — see
`packages/vm/test/vm.test.ts` for the pattern (map-backed storage, captured
events, fuel assertions). Full-chain tests deploy through a real `Chain`
as in `packages/chain/test/contracts.test.ts`.
