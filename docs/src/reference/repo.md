# Repository Layout & Building

```text
zechariah/
  SPEC_PT_01..03.md        the platform specification (normative)
  IMPLEMENTATION_PLAN.md   v1 decisions (D1–D8) and milestones (M0–M7)
  docs/                    this book (mdBook) + threat-model.md
  packages/
    protocol/        canonical wire codec; tx/block/vote/gossip schemas; golden vectors
    crypto/          Ed25519, BLAKE2b-256, z32 addresses, keystores, mnemonics
    networking/      Network/Feed over Hyperswarm + Corestore
    state/           KV store (LevelDB), overlays, Merkle state commitment
    vm/              contract executor (wasmi-in-wasm) + runtime/ (Rust crate)
    chain/           genesis, execution, fees, mempool, blocks, registry
    consensus/       BFT engine, peer hub, certificates, block sync
    node/            node orchestration + mordecai-node CLI
    rpc/             hyperswarm-RPC server + typed client
    wallet/          Wallet, Signer, keystore files, mordecai-wallet CLI
    sdk/             Mordecai (app runtime), ContractArgs, mordecai-launcher
    pear-integration/ WalletSession, WalletDaemon, RemoteSigner
  contracts/
    runtime-rs/      mordecai-contract: the Rust contract ABI bindings
    counter/ marketplace/   hand-written Rust contracts
    dist/            committed .wasm artifacts (Rust + DSL examples)
  compiler/
    mordecaic            the DSL compiler CLI (Python 3, stdlib only)
    mordecaidsl/         parser, typechecker, Rust codegen
    examples/        land.pysc, chess_wager.pysc
  apps/
    devnet/          local devnet launcher
    chess/           the example application
```

## Toolchains

- **Node ≥ 20 + corepack** — the only hard requirement. pnpm is pinned via
  `packageManager`; `pnpm install && pnpm build && pnpm test`.
- **Rust (wasm32-unknown-unknown) + Python 3** — only to _rebuild_ wasm
  artifacts (`scripts/build-wasm.sh`) or compile your own DSL contracts.
  All shipped artifacts are committed, so JS-only development works out of
  the box; tests that need the toolchain self-skip without it.
- **mdBook** for this book: `mdbook serve docs`.

## Testing conventions

- Unit + integration tests are vitest, colocated in each package's `test/`
  (plus `apps/*/test/`). Tests import package _sources_ via aliases in
  `vitest.config.ts`, so no build step is needed to run them.
- Integration tests spin up real components: in-process DHT testnets
  (`hyperdht/testnet`), real multi-validator consensus, real RPC over the
  swarm. Nothing chain-related is mocked.
- **Never run `cargo`/other sync subprocesses inside a vitest worker** — a
  synchronous call blocks the event loop, so vitest's own timeouts cannot
  fire and the run hangs silently. Precompile artifacts instead (this is a
  hard-won lesson; see `scripts/build-wasm.sh`).
- Golden vectors (`packages/protocol/test/vectors/`) pin the wire format;
  changing them is a consensus break. Regenerate only deliberately with
  `UPDATE_VECTORS=1`.

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs install → build → lint →
format check → tests on every push/PR. CI has no Rust/Python, which is why
artifacts are committed and toolchain-dependent tests self-skip.
