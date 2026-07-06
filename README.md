# Holepunch Smart Settlement Network

A decentralized platform for peer-to-peer applications: Holepunch/Pear
provides networking, storage, and app distribution; a small deterministic
settlement chain provides identity, payments, ownership, and smart contracts.
Applications stay peer-to-peer — only economic state goes through consensus.

- **Documentation:** the [mdBook site](docs/) covers architecture, building
  p2p apps, the SDK, smart contracts and the DSL, examples, and CLI/RPC
  reference. Serve locally with `mdbook serve docs`, or start at
  [docs/src/introduction.md](docs/src/introduction.md).
- Specification: `SPEC_PT_01.md`, `SPEC_PT_02.md`, `SPEC_PT_03.md`
- V1 plan and milestones: `IMPLEMENTATION_PLAN.md`

## Development

Requires Node ≥ 20 with corepack (pnpm is pinned via `packageManager`).

```sh
pnpm install
pnpm build   # typecheck + emit all packages
pnpm test    # vitest across all packages
pnpm lint
```

## Status

**v1 core complete (M0–M7).** The spec §28 vertical slice passes end to end
on a multi-validator devnet: registry install with on-chain hash
verification, wallet authentication, bidirectional Hypercore state sync, and
finalized on-chain payment (`packages/sdk/test/vertical.test.ts`).

- Protocol, crypto, networking, state, chain, BFT consensus, WASM contract
  VM (wasmi-in-wasm), marketplace contract, app registry, RPC, node CLI,
  wallet CLI, application SDK — all tested (`pnpm test`).
- Local devnet: `pnpm build && node apps/devnet/devnet.mjs 4`.
- Rust toolchain only needed to rebuild wasm artifacts:
  `scripts/build-wasm.sh` (artifacts are committed).

Also done:

- **Pythonic contract DSL** (`compiler/hssnc`: `.pysc` → Rust → wasm32, spec
  Phase 7) with `value`/`transfer`/`emit`/`height` builtins.
- **Wallet daemon + IPC signer** (`packages/pear-integration`): apps hold a
  RemoteSigner over hyperswarm RPC; keys stay in the daemon process, per-app
  grants and spend allowances enforced there, overages escalate to an
  approval hook (the seam for the Pear wallet UI).
- **Example app: p2p chess** (`apps/chess`) — the spec §15 exemplar: the
  match plays entirely over Hypercore feeds; only the wager escrow
  (`compiler/examples/chess_wager.pysc`, written in the DSL) touches the
  chain.
- **hssn-launcher** — registry install CLI: lookup → swarm fetch → verify
  against the on-chain hash.

Remaining beyond v1: hosting apps inside the actual Pear/Bare desktop shell
(the wallet-approval UI itself), multi-writer feeds (Autobase) for
community-style apps, and the rest of the example suite.
