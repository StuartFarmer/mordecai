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

M0 (scaffold + protocol schemas) — in progress. See `IMPLEMENTATION_PLAN.md`
§4 for the milestone graph.
