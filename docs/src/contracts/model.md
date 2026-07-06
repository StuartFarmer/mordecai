# The Contract Model

Smart contracts are **deterministic economic programs** — not applications
(spec §11). A contract executes only when a transaction invokes it, runs to
completion in a fuel-bounded sandbox, and exits. It cannot render, wait,
schedule, or talk to the network.

## What contracts define / don't

| Contracts define               | Contracts never do              |
| ------------------------------ | ------------------------------- |
| ownership rules, escrow        | rendering, UI                   |
| payment logic, settlement      | networking, storage replication |
| marketplaces, wagers, auctions | gameplay simulation             |
| permissions, governance        | AI, media                       |

## Deploy

`deploy_contract` with the WASM bytes. The module is validated (no floats /
SIMD / threads, only ABI imports — see [The Contract VM](../architecture/vm.md))
and stored in consensus state. The contract id is
`H("hssn:contract:v1" ‖ sender ‖ nonce ‖ code)` — deterministic, returned in
the receipt's `returnData`.

A contract id is also an **account**: contracts hold native currency
balances, receive attached value, and pay out with `transfer`.

## Execute

`execute_contract { contract, action, args, value }`:

1. If `value > 0`, it moves from the sender to the contract's account
   _before_ the action runs (the contract sees it as `attached_value`).
2. The exported `action` function runs against the contract's isolated
   storage namespace, metered by fuel bought with `maxFee`.
3. Outcomes:
   - **return 0** → success; storage writes, payouts, and events commit;
     `returnData` carries whatever the contract set.
   - **abort / non-zero return / trap / out of fuel** → _everything_
     reverts, including the attached value — but the fee is charged and the
     nonce consumed. The abort message lands in the receipt's `error`.

This all-or-nothing semantic is what makes patterns like "attach the exact
price; the contract pays the seller and flips ownership" safe — there is no
partial state in which the buyer paid but didn't receive.

## Events and return data

`emit(bytes)` appends to the receipt's event list (≤64 events, ≤4 KiB
each, kept only on success). `set_return(bytes)` fills `returnData`.
Both surface through RPC `get_tx`, so apps read outcomes from receipts —
there is no on-chain event log to query separately.

## Cross-contract calls

Contracts interact only by message passing (spec §12):
`call(contract, action, args, value)` runs the callee with the _calling
contract_ as `caller`, in its own overlay, sharing the fuel budget, to a
depth of 4. The callee's status comes back; its storage stays its own.

## Two ways to write one

- **The Pythonic DSL** (recommended): [tutorial](tutorial.md) and
  [reference](dsl-reference.md). Compiles to Rust and then WASM with
  checked arithmetic and enforced structure.
- **Rust directly** against `contracts/runtime-rs`:
  [Rust Contracts & the ABI](rust-abi.md). Full control; you enforce your
  own discipline.

Both compile to the identical ABI — the chain cannot tell them apart.
