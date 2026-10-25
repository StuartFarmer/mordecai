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

- [x] Test configurable faucet grant and app RPC/faucet namespace.
- [x] Implement bounded named RPC mounts and reuse Faucet with operator-set amount.
- [x] Extract reusable Hex host; add persistent identity and bootstrap journal.
- [x] Add node-demo launcher and verify restart preserves chain/deployments/balances.
- [x] Commit gateway/host increment.

## Task 2: Embedded Hex and shared wallet

- [x] Test signer facade, closed wallet, send locking/pending state and mounted funding URLs.
- [x] Add Demos dropdown, Hex view, lazy embed bundle and isolated styling.
- [x] Reuse wallet transaction clients for game sends and receipt/retry state.
- [x] Adapt Hex to supplied config/session, manual L1 faucet and app fee funding.
- [x] Verify standalone and embedded builds, two-wallet create/join/move/settlement.
- [x] Update docs, run full suite/lint/format, independent review and fixes.
- [x] Commit frontend/integration increment.

## Verification

- Full regression suite: 301 tests across 49 files passed.
- Root build (TypeScript, wallet, embedded Hex, mdBook), standalone Hex build, ESLint and Prettier passed.
- Browser: load/create wallet and faucet, create/join through a room link, place a stone, resign, and confirm L1 payout with two distinct wallets.
- Browser: close wallet disconnects the mounted Hex app; mobile Demos dropdown stays inside the viewport.
- Restart: public configuration, deployed contract state, rooms and both player balances stayed identical; live chain heads continued advancing.
- Independent review fixed L1 funding preflight and partial join recovery, stale wallet funding state, and room-link changes after mounting. Regression tests cover all three.

## Remaining scope

Frontier, Outpost and Chess link to their guides until their wallet/room conversion.
No public deployment or push. This is a local test-token demo; cross-chain game
and escrow actions commit separately, with UI retries for incomplete room funding.
