# Node Demos Implementation Plan

> Use superpowers:executing-plans inline; one independent review at the end.

**Goal:** Demos dropdown with playable Hex sharing the node wallet and persistent L1.
**Architecture:** Reuse the Hex React app in a Shadow DOM, narrow wallet signing facade,
existing TransactionClient, gateway-mounted app RPC, and persistent demo bootstrap.
**Tech stack:** Existing Node/TypeScript, vanilla JS, React, Vite, Vitest.
**Spec:** docs/superpowers/specs/2026-10-25-node-demos-design.md

## Constraints

- No private keys in frontend config, URLs, game props or browser persistence.
- Preserve standalone Hex, default faucet grant and custom gateway frontends.
- Serialize wallet/game sends and retain uncertain transactions for safe retries.
- Commit complete increments; do not push without a new request.

## Review focus

- Closing/changing wallets while game requests or multi-step actions are in flight.
- Restart after bootstrap acceptance but before local receipt acknowledgement.
- Mounted API routing/validation and public config accidentally exposing keys.
- Faucet amount, app fee funding and shared L1 balance correctness.
- Embedded Hex styling/navigation, game join/settlement and standalone compatibility.

## Task 1: Gateway and persistent host

- [ ] Test configurable faucet grant and app RPC/faucet namespace.
- [ ] Implement bounded named RPC mounts and reuse Faucet with operator-set amount.
- [ ] Extract reusable Hex host; add persistent identity and bootstrap journal.
- [ ] Add node-demo launcher and verify restart preserves chain/deployments/balances.
- [ ] Commit gateway/host increment.

## Task 2: Embedded Hex and shared wallet

- [ ] Test signer facade, closed wallet, send locking/pending state and mounted funding URLs.
- [ ] Add Demos dropdown, Hex view, lazy embed bundle and isolated styling.
- [ ] Reuse wallet transaction clients for game sends and receipt/retry state.
- [ ] Adapt Hex to supplied config/session, manual L1 faucet and app fee funding.
- [ ] Verify standalone and embedded builds, two-wallet create/join/move/settlement.
- [ ] Update docs, run full suite/lint/format, independent review and fixes.
- [ ] Commit frontend/integration increment.
