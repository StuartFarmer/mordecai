# Web Wallet Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create/load a browser wallet, obtain test CAI, and play Hex with that identity.

**Architecture:** Add a browser-only export to the existing wallet package and
bundle a small DOM wallet page with Vite. Hex imports that shared browser module
and offers explicit key loading; its existing signing and game flows stay intact.

**Tech Stack:** TypeScript, existing noble Ed25519/z32/Vite, vanilla DOM, React Hex.

**Spec:** `docs/superpowers/specs/2026-10-25-web-wallet-design.md`

## Global constraints

- Keys remain client-side in memory; exported test-wallet files are unencrypted.
- No bridge, extension, new crypto algorithm, or external signing service.
- Same key/address across chains; balances and nonces are chain-specific.
- Preserve existing custom frontends and legacy saved Hex wallets.

## Review focus

- Invalid 64-byte secret keys and JSON address mismatches must be rejected.
- The browser bundle must not include native sodium or expose keys over HTTP.
- Wallet switching must not let stale balance requests show another account's data.
- Lost unsaved keys and reload behavior must be explicit and guarded.
- The two demo faucets must use separate wallets/nonces; app fees need funding too.

### Task 1: Shared browser wallet and node page

- [x] Add failing browser/native identity, signature, backup and validation tests.
- [x] Implement `createBrowserWallet`, `loadBrowserWallet`, `exportBrowserWallet`,
      and `signBrowserTransaction` in `packages/wallet/src/browser.ts`.
- [x] Add `/wallet.html`, browser entry, safe download/import UI, bundle build,
      exact asset routes, package exports/dependencies, and route tests.
- [x] Verify wallet tests, TypeScript build, browser build and native compatibility.

### Task 2: Hex integration and runnable walkthrough

- [x] Add Hex wallet import/create/export controls using the shared module;
      preserve legacy identities, and guard all polling until a wallet is loaded.
- [x] Give the Hex gateway a separate funded generic faucet wallet.
- [x] Document create → download → fund → load into Hex → play and settle.
- [x] Run builds, full tests, lint and formatting; inspect wallet desktop/mobile.
- [x] Exercise browser wallet funding and two-player Hex through settlement.
- [x] Obtain independent review, resolve findings, record verification.

## Completion evidence

- Root build (TypeScript, wallet bundle, mdBook) and Hex Vite build passed.
- All 270 tests in 41 files passed; repository lint and formatting passed.
- Browser: created and downloaded a wallet; loaded a test key into the web
  wallet, claimed test CAI, loaded the same identity into Hex, and created a game.
  A second wallet joined, the first placed a stone, the second resigned, and the
  browser displayed the completed L1 pot payout. Mobile wallet layout checked.
- Independent review found three issues, each reproduced with a failing test
  before fixing: legacy identities bypassing the chooser, a delayed file read
  overwriting a newly created key, and imported wallets lacking app-chain fees
  despite sufficient L1 funds. Regression tests and the full suite are green.
- No changes committed or pushed. Preview and Hex demo remain running locally.
