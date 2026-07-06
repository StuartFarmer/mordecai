# Holepunch Smart Settlement Network

A decentralized platform for peer-to-peer applications: Holepunch/Pear
provides networking, storage, and app distribution; a small deterministic
settlement chain provides identity, payments, ownership, and smart contracts.
Applications stay peer-to-peer — only economic state goes through consensus.

- Specification: `SPEC_PT_01.md`, `SPEC_PT_02.md`, `SPEC_PT_03.md`
- V1 plan and milestones: `IMPLEMENTATION_PLAN.md`
- Architecture and threat model: `docs/`

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

Also done: the Pythonic contract DSL (`compiler/hssnc`: `.pysc` → Rust →
wasm32, spec Phase 7) and permission-scoped wallet sessions for apps
(`packages/pear-integration`: allowance-gated signing, auth grants).
Remaining for the full v1 vision: hosting apps inside the actual Pear/Bare
shell with a wallet-approval UI, and the example-app suite.
