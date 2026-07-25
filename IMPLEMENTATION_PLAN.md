# V1 Implementation Plan — Mordecai

This plan turns SPEC_PT_01–03 into a buildable v1. It follows the spec's phased
roadmap (§27) and defines **v1 as spec Phases 0–6**, culminating in the First
Technical Milestone vertical slice (§28). The Pythonic DSL (Phase 7) and the
example-app suite (Phase 8+) are explicitly **post-v1**: v1 contracts are
written directly in Rust against the same WASM ABI the DSL will later target,
so the DSL becomes a pure frontend swap with no chain changes.

---

## 1. Definition of Done for v1

A user can, on a real multi-node network:

1. Launch a Pear application.
2. Be automatically authenticated via their wallet keypair.
3. Join a Hypercore feed and synchronize shared state with another peer.
4. Execute an on-chain payment (native currency transfer or contract call).
5. Receive a finalized confirmation via event subscription.
6. Keep using the app throughout — networking never blocks on the chain.

Plus, for developers:

- Deploy a WASM contract (Rust-authored) and invoke it via the SDK.
- Register an application in the on-chain registry and install it from a peer.

---

## 2. Core Technical Decisions

### D1. Language: TypeScript/Node for the platform, Rust only inside the contract sandbox

The entire Holepunch ecosystem (hypercore, hyperswarm, hyperdht, pear) is
JavaScript-native with no maintained Rust bindings. Rewriting or FFI-bridging
it dwarfs the rest of the project. Therefore:

- **Chain node, networking, wallet, SDK, tooling: TypeScript** (Node ≥ 20,
  and Bare-compatible where it must run inside Pear).
- **Contracts: WASM, executed by wasmi compiled to WASM** (M5 spike outcome:
  the wasmtime npm binding is dead, so instead the wasmi interpreter — fuel
  metering, deterministic, pure Rust — is itself compiled to
  wasm32-unknown-unknown and runs inside V8; the JIT never executes contract
  code directly, and the committed runtime artifact means JS-only development
  needs no Rust toolchain). Host functions bridge synchronously to the state
  overlay. See packages/vm/runtime.
- Rust is the source language for v1 contracts (compiled to
  `wasm32-unknown-unknown` against contracts/runtime-rs), which also de-risks
  the DSL's Rust codegen later.

### D2. Keys and identity: Ed25519 everywhere

Hypercore already uses Ed25519. Using the same scheme for wallets means one
keypair _is_ the universal identity (§9): it can sign transactions, own
Hypercore feeds, and authenticate to apps.

- Address = z32-encoded Ed25519 public key (same encoding Pear/hyperdht use).
- Hashing: BLAKE2b-256 (already shipped in `sodium-native`, used by Hypercore).
- Key storage: encrypted keystore file (XChaCha20-Poly1305 via libsodium),
  BIP39 mnemonic for backup.

### D3. Consensus: fixed-validator BFT (simplified Tendermint), built in two steps

The spec demands deterministic execution + immediate finality, not open
participation, for v1.

- **Step 1 (dev chain):** single sequencer node. Unblocks all state-machine,
  RPC, and SDK work immediately.
- **Step 2 (v1 consensus):** static validator set from genesis; round-robin
  proposer; a block is final when ≥ 2/3 of validators sign a pre-commit for
  it; one round per height, timeout → skip to next proposer. No forks are
  possible under < 1/3 Byzantine, giving immediate finality.
- Staking / validator rotation / slashing: post-v1.

### D4. Transport: the chain itself runs on Holepunch

Dogfood the networking layer instead of adding a parallel TCP stack:

- Validators discover each other via **hyperdht** (well-known topic derived
  from genesis hash) and gossip transactions + consensus votes over
  **hyperswarm** connections with **protomux** channels.
- Finalized blocks carry quorum-vote certificates; new/lagging nodes sync via
  block_request/response gossip on the consensus mesh, verifying each
  certificate independently. (The originally planned Hypercore block-log feed
  is deferred post-v1 — the gossip path was simpler and equally verifiable.)
- Client RPC: **@hyperswarm/rpc** (apps talk to any node P2P, no server URL),
  plus an optional local HTTP JSON-RPC gateway for explorers/curl/tooling.

### D5. State: flat KV + binary Merkle root, pluggable later

- Backing store: LevelDB (`classic-level`) with per-block atomic batches.
- Layout: `contract_id / key → value` — isolated namespaces per contract (§12).
- State root: binary Merkle tree over sorted `(key, value)` hashes, recomputed
  incrementally per block. A proper sparse-Merkle/Verkle upgrade is post-v1;
  the root lives behind a `StateCommitment` interface so it can be swapped.

### D6. Wire format: in-house canonical codec

All protocol messages (transactions, blocks, votes) use a small
zero-dependency canonical codec in the `protocol` package (fixed-width
little-endian integers, u32 length prefixes, fatal-mode UTF-8, strict
full-consumption decode). We own it rather than depending on
`compact-encoding` because signing preimages need guaranteed canonicality and
bigint-safe u64 amounts (`compact-encoding` decodes uint64 to JS numbers).
Every other package imports its schemas; golden vectors pin the exact bytes.

### D7. Transactions and fees

```
Transaction {
  chain_id, nonce, sender(pubkey), payload, max_fee, signature
}
Payload = Transfer | DeployContract | ExecuteContract | RegisterApp | UpdateApp
```

- Per-account nonce for replay protection; `chain_id` for cross-chain replay.
- Fees v1: flat fee per payload type + per-byte charge + WASM fuel for
  contract calls, paid in native currency, credited to the block proposer.

### D8. Contract execution model

- Contract = WASM module exporting `action` entrypoints; host functions
  exposed: `storage_get/set/delete` (own namespace only), `caller()`,
  `transfer()`, `call(contract, action, args)` (message passing per §12),
  `emit(event)`, `block_height()`. No clock, no randomness, no floats
  (validated at deploy: reject modules containing float opcodes).
- Deterministic limits: fuel cap, memory cap, call-depth cap, storage
  key/value size caps.
- Two **system contracts** implemented natively in the node (not WASM) since
  they're protocol-critical: the native **currency** ledger and the
  **application registry** (§17). They expose the same call interface as WASM
  contracts so the SDK treats them uniformly.

---

## 3. Repository Layout (v1 subset of spec §24)

```
zechariah/
  packages/
    protocol/        # shared types, compact-encoding schemas, constants
    crypto/          # keys, signing, hashing, keystore, mnemonic
    state/           # KV store, merkle commitment, contract namespaces
    vm/              # wasmtime host, fuel, host functions, module validation
    chain/           # mempool, block production, execution loop, genesis
    consensus/       # proposer rotation, votes, finality, block-log hypercore
    node/            # wires chain+consensus+networking; CLI: init/start
    rpc/             # @hyperswarm/rpc server + client, HTTP gateway
    wallet/          # keystore mgmt, tx building/signing; CLI wallet
    sdk/             # app-facing API: wallet(), transfer(), execute(),
                     # query(), subscribe_events() + hypercore helpers
    pear-integration/# Pear runtime glue: auto wallet auth, node discovery
  contracts/
    runtime-rs/      # Rust crate: contract ABI, host bindings, macros
    marketplace/     # first real WASM contract (Phase 4 milestone)
    registry-schema/ # metadata schema for the app registry
  apps/
    devnet/          # scripts: spin up N local validators
    explorer/        # minimal block/tx/account explorer (post-M4, thin)
    demo/            # vertical-slice demo app (see M7)
  docs/
    architecture.md protocol.md threat-model.md sdk.md
```

Monorepo tooling: pnpm workspaces + TypeScript project references; vitest
(unit) + integration harness that boots real nodes in-process; CI runs a
3-validator devnet smoke test on every PR.

---

## 4. Milestones

Each milestone ends with a demoable acceptance test. Rough sizing assumes 1–2
engineers; sizes are relative (S ≈ days, M ≈ 1–2 weeks, L ≈ 3–4 weeks).

### M0 — Scaffold & protocol definitions (S) [spec Phase 0]

- Monorepo scaffold, CI, lint/test tooling.
- `protocol` package: all v1 message/tx/block schemas + canonical encoding,
  with golden-vector tests.
- `docs/threat-model.md` first pass (§26 boundaries).
- **Accept:** encode/decode round-trip and signing-vector tests pass.

### M1 — Crypto & wallet core (S)

- `crypto`: keypairs, sign/verify, BLAKE2b, address encoding, encrypted
  keystore, mnemonic.
- `wallet` CLI: `wallet create | address | sign`.
- **Accept:** create wallet, sign a canonical tx payload, verify.

### M2 — Networking foundation (M) [spec Phase 1]

- Thin wrappers over hyperswarm/hyperdht/hypercore with typed protomux
  channels; peer manager (dial, backoff, dedupe).
- Feed replication demo: two processes exchange an append-only feed.
- **Accept (spec Phase 1 milestone):** two peers on different machines/NATs
  replicate a feed both directions.

### M3 — Single-node chain (L) [spec Phase 2, step 1]

- `state`: KV + merkle commitment. `chain`: genesis file (initial balances,
  validator set), mempool with nonce/fee/signature validation, block
  production loop, deterministic execution of Transfer, receipts, events.
- `rpc`: submit_tx, get_account, get_block, get_tx, subscribe_events —
  served over @hyperswarm/rpc; HTTP gateway.
- **Accept:** transfer currency between two wallets via CLI against one node;
  restart node, state persists; state root reproducible from replaying blocks.

### M4 — Multi-validator consensus (L) [spec Phase 2, step 2]

- `consensus`: round-robin proposer, pre-commit votes, ≥2/3 finality,
  proposer timeout/skip; tx gossip; finalized-block Hypercore feed; new-node
  sync from the feed; identical state roots asserted across nodes.
- devnet scripts: `devnet up 4`.
- **Accept (spec Phase 2 milestone):** 4-validator devnet; kill 1 validator,
  chain continues; a fresh node syncs from genesis and matches state roots;
  transfers finalize in < 2s locally.

### M5 — Contracts on WASM (L) [spec Phase 4]

- `vm`: wasmtime host, fuel metering, float-opcode rejection, host functions,
  storage isolation, cross-contract `call` with depth limit.
- Deploy/Execute payloads wired through chain execution; contract events in
  receipts; deterministic gas accounting in fees.
- `contracts/runtime-rs` Rust ABI crate + the **marketplace** contract
  (list/buy/cancel with escrowed payment).
- **Accept (spec Phase 4 milestone):** deploy marketplace from CLI, execute a
  trade between two wallets, balances and ownership update identically on all
  validators; a contract exceeding fuel is rejected deterministically.

### M6 — Application registry (M) [spec Phase 5]

- Registry as a system contract: `register(app_id, pear_key, version,
contract_addr, metadata_hash, sig)`, developer-key-gated updates.
- Installer flow: query registry → fetch Pear bundle over swarm → verify
  signature against registry entry → launch.
- **Accept (spec Phase 5 milestone):** register a demo app on devnet, install
  and launch it on a second machine purely from registry + swarm.

### M7 — SDK + Pear integration + vertical slice (L) [spec Phases 3 & 6]

- `sdk`: the §22 surface — blockchain (`wallet, sign, transfer, deploy,
execute, query, subscribe_events`) and hypercore helpers (`create_feed,
append, replicate, join_swarm, subscribe`).
- `pear-integration`: wallet unlock/session at app launch (per-app permission
  grants: apps request signatures, never touch keys — §26), node discovery
  via DHT, tx status tracking helpers.
- **Demo app** (chess with a wagered match, per §15): moves + chat over
  Hypercore; wager escrow + payout on-chain via the marketplace/escrow
  contract.
- **Accept (spec §28, the v1 exit criterion):** the full 7-step vertical
  slice runs on a ≥3-validator network across ≥2 machines.

### Dependency graph

```
M0 → M1 → M3 → M4 → M5 → M6 ┐
   └─ M2 ──────────────────── M7
```

M2 (networking) can proceed in parallel with M1/M3 until M4 needs it.

---

## 5. Post-v1 (explicitly deferred)

- **Pythonic DSL** (spec Phase 7): parser → typed AST → verifier → Rust
  codegen → the _existing_ M5 WASM ABI. Nothing on-chain changes.
- Example-app suite (Reddit, AI service, wiki), economic primitive library
  (auction, DAO, subscription, royalties), explorer polish, package manager,
  validator staking/rotation, light-client proofs, state-tree upgrade,
  fee markets.

---

## 6. Top Risks & Mitigations

1. **wasmtime bindings on Node/Bare** — maintained N-API bindings are thin.
   Mitigation: spike in week 1 of M5 prep; fallback is embedding wasmtime via
   a small native addon we own, or wasmi (slower but simple, deterministic).
2. **Determinism leaks in a JS node** — `Map` iteration order, `Date.now`,
   float use in fee math. Mitigation: execution code path uses integer-only
   (bigint) arithmetic, sorted iteration, no ambient time; cross-validator
   state-root assertion tests in CI from M4 onward.
3. **Holepunch under consensus latency requirements** — hyperswarm was built
   for replication, not sub-second vote rounds. Mitigation: consensus
   messages ride persistent direct connections (protomux), not gossip;
   measure in M4; timeouts tuned generously (finality target seconds, not ms).
4. **Pear runtime constraints (Bare)** — Node-only deps won't load inside
   Pear apps. Mitigation: SDK targets Bare-compatible modules only; anything
   heavier (wasmtime, LevelDB) lives in the node, never in the app-side SDK.
5. **Key custody UX** (§9) — auto-auth must not mean auto-sign. Per-app
   session permissions with explicit user approval for payments is designed
   into M7, not bolted on.
