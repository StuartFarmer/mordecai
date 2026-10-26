# Settlement and App-Chain Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement and review this plan. The user explicitly selected subagents. Steps use checkbox (`- [x]`) syntax for tracking. Independent files may be implemented concurrently; shared files have one owner.

**Goal:** Add settlement and registered-app block browsing to the node website,
with settlement details remaining readable when app chains are unavailable.

**Architecture:** Extend existing chain/RPC reads and bridge them through the
gateway. One browser explorer selects settlement or an app chain. Reuse existing
state storage, mounted network connections, browser helpers and the site bundle.

**Tech Stack:** TypeScript, existing Hyperswarm RPC, plain browser JavaScript,
Vite and Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-26-block-explorer-design.md`

**Status:** Implemented and verified on `feature/block-explorer`. Existing
account/demo work was preserved.

## Global Constraints

- Use **Settlement (L0)** in the explorer without renaming existing code, CLI commands or protocol fields.
- No new dependencies or consensus changes.
- Deliver the entire feature before adding its links to the main node navigation.
- Registry pages: default 50, max 100; recent block pages: ten; block-body concurrency: two.
- App reads: five-second shared deadline, one-second attempt timeout, eight in-flight requests per gateway.
- Visible latest-head polling: five seconds; browser timeout: ten seconds.
- Use integer **CAI base units** on settlement and **app-chain base units** on app chains.
- App data availability must not remove registration or settlement-anchor details.
- Do not modify unrelated account/demo work or introduce a permanent archive/indexer.

## Review Focus

- Unicode, escaped delimiters and markup in app IDs must round-trip safely (Tasks 1, 2, 4).
- A peer on the wrong chain or a registry validator update must not reuse stale identity (Task 3).
- Missing receipt/body/history must not be presented as success, failure or pending (Tasks 2–4).
- Large u64 values and failed anchor transactions must display accurately (Task 4).
- Late responses and background polling must not overwrite another chain or disturb Account (Tasks 4, 5).

## File map

| Files                                                                                 | Responsibility                                                       |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `packages/chain/src/chain.ts`                                                         | Enumerate current registry entries                                   |
| `packages/rpc/src/{messages,server,client}.ts`                                        | Registry-page DTO/method and read deadlines                          |
| `packages/gateway/src/gateway.ts`                                                     | HTTP routes, validation, app-read admission and mounted-client reuse |
| New `packages/gateway/src/explorer.ts`                                                | App-peer read attempts and resource cleanup                          |
| New `packages/gateway/web/explorer.js`                                                | Explorer client, screen rendering and lifecycle                      |
| `packages/gateway/web/{wallet,navigation}.js`                                         | Mount screens through existing navigation                            |
| `packages/gateway/public/{index.html,mordecai.css}`                                   | Finished feature's navigation, sections and minimal styles           |
| Existing registry/node/gateway/navigation tests plus new explorer tests               | Contract and browser regressions                                     |
| `docs/src/reference/rpc.md`, `docs/src/apps/gateway.md`, `packages/gateway/README.md` | API and availability documentation                                   |

No barrel/export configuration, package manifest, protocol fixture or build-script
change is expected. Confirm this during implementation rather than adding scaffolding.

### Task 1: Paginated registry reads

**Files:** Modify `packages/chain/src/chain.ts`,
`packages/rpc/src/{messages,server,client}.ts`; extend
`packages/chain/test/registry.test.ts` and `packages/node/test/node.test.ts`.

**Interfaces:**

- Chain: `listApps(options?: { after?: string; limit?: number }): Promise<{ apps: { appId: string; entry: AppEntry }[]; nextAfter: string | null }>`.
- RPC: export `AppPage { apps: AppInfo[]; nextAfter: string | null }`; add `get_apps` to RPC_METHODS.
- Client: `getApps(params?: { after?: string; limit?: number }, options?: RpcReadOptions): Promise<AppPage>`.
- Allow optional `RpcReadOptions` on existing getHead/getApp/getAppAnchor without breaking existing callers.

- [x] Add registry tests with three apps registered out of order: limit=2 yields the first two in UTF-8 key order, nextAfter equals the second ID, next page contains the third and null cursor. Assert empty registry, exclusive nonexistent cursor, Unicode ID, rejected duplicate and updated version behavior.
- [x] Add RPC assertions for JSON field encoding, default/maximum limit and invalid cursor/limit types; add timeout coverage for newly deadline-aware reads to `packages/gateway/test/rpc-read-timeout.test.ts`.
- [x] Run `rtk pnpm exec vitest run packages/chain/test/registry.test.ts packages/node/test/node.test.ts packages/gateway/test/rpc-read-timeout.test.ts`; confirm new assertions fail for missing functionality.
- [x] Implement bounded result collection from existing sorted entries, the shared AppInfo serialization used by get_app/get_apps, and client methods. Enforce byte-length/limit validation at RPC boundary. Add the full-scan shortcut comment with range iteration as the upgrade trigger.
- [x] Repeat the targeted command; all assertions pass, including existing registration/update behavior. Commit only this task's changes if commits are part of the execution workflow.

### Task 2: Settlement HTTP reads

**Files:** Modify `packages/gateway/src/gateway.ts`; create
`packages/gateway/test/explorer-api.test.ts`; update
`docs/src/reference/rpc.md` and `docs/src/apps/gateway.md`.

**Interfaces:** `GET /api/apps` returns AppPage; `GET /api/block/<height>` returns
BlockInfo. Preserve existing `/api/app/<id>` response shape. Export no new HTTP
client type; the browser consumes existing DTO JSON.

- [x] Add HTTP tests using the existing local-DHT/node fixture pattern: genesis and finalized blocks match RPC; a receipt points to the correct encoded transaction; apps pagination reflects registry updates; empty pages are valid results.
- [x] Assert height -1, fractional, overflow beyond 18446744073709551615 and malformed query/percent encoding return 400; absent block returns 404; stalled block/registry upstream returns 503. Test the block route under an existing mounted demo prefix too.
- [x] Pin error shape `{ code, error }` for new routes: `INVALID_REQUEST`, `NOT_FOUND`, `UPSTREAM_UNAVAILABLE`; assert HTTP status separately. Existing endpoints keep their established behavior.
- [x] Run `rtk pnpm exec vitest run packages/gateway/test/explorer-api.test.ts`; verify failures before adding the routes.
- [x] Implement validation and bounded RPC deadlines using Task 1 client options. Keep `/api/apps` distinct from `/api/app/<id>` and route misses distinct from unavailable upstreams. Document the added reads and the full-scan limit.
- [x] Run `rtk pnpm exec vitest run packages/gateway/test/explorer-api.test.ts packages/gateway/test/gateway.test.ts`; all pass. Record any unrelated existing failures separately.

### Task 3: Read registered app chains

**Files:** Create `packages/gateway/src/explorer.ts` and
`packages/gateway/test/explorer-peers.test.ts`; modify
`packages/gateway/src/gateway.ts` and `packages/gateway/test/explorer-api.test.ts`.

**Interfaces:**

- Export `AppReadRequest = { kind: 'head' } | { kind: 'block'; height: bigint } | { kind: 'tx'; hash: string }`.
- Export `readAppChain(entry: AppInfo, request: AppReadRequest, options: { bootstrap?: { host: string; port: number }[]; mounted?: NodeRpcClient }): Promise<HeadInfo | BlockInfo | TxInfo | null>`.
- Export `AppReadError` with code `UPSTREAM_UNAVAILABLE`. A null result means a matching peer answered but the item was not available from attempted peers.
- Gateway owns registration lookup, validation, the eight-request admission limit and HTTP mapping. Helper owns the five-second peer-attempt budget and dynamic-client cleanup.
- Expose only GET `/api/app/<id>/chain/{head,block/<height>,tx/<hash>}`; map null to 404 `DATA_UNAVAILABLE`, empty validators to 409 `NO_APP_CHAIN`, saturation to 503 `BUSY`, unavailable peers to 503 `UPSTREAM_UNAVAILABLE`.

- [x] Add local-DHT tests: mounted peer reused; first validator unavailable and second succeeds; wrong-chain head rejected; missing item retried; all offline fails within deadline; matching-but-missing returns null; dynamic clients close on success/error and mounted clients stay open.
- [x] Add route tests: unknown registration never dials; updated validator set used on the next request; simultaneous ninth request returns BUSY; slots release on every exit; POST and arbitrary suffixes never submit transactions. Test encoded slash/Unicode app IDs round-trip without widening the route namespace.
- [x] Run `rtk pnpm exec vitest run packages/gateway/test/explorer-peers.test.ts packages/gateway/test/explorer-api.test.ts`; confirm the new behavior is missing.
- [x] Implement mounted lookup by configured demo appId, then registered-validator attempts. Obtain/validate head before data; apply one deadline to head plus item per attempt, with the remaining total budget. Reuse the mount's bootstrap for fallback. Never import appchain/node into gateway production code: that would create a dependency cycle.
- [x] Repeat those tests and `packages/gateway/test/gateway.test.ts`. Verify unavailable app reads do not affect `/api/app/<id>` or settlement browsing. Document private-DHT mounting and deadline-limited discovery.

### Task 4: Shared explorer screens

**Files:** Create `packages/gateway/web/explorer.js` and
`packages/gateway/test/explorer-ui.test.ts`. Read/reuse
`packages/gateway/web/transactions.js`, `packages/gateway/web/demos.js`,
`@mordecai/protocol` and `@mordecai/wallet/browser` helpers.

**Interfaces:** Export `createExplorer(doc = document, win = window, fetcher = fetch): { open(route: string): void; close(): void }`.
`open('explorer')` and `open('apps')` read hash query state; other routes close
active reads. Use containers `#explorer-content` and `#apps-content`; return an
inert controller when these sections are absent. Query parameters follow the spec.
No wallet/session object is accepted or required.

- [x] Add tests for ten descending block rows including genesis, exclusive older pagination, lookup-type validation, app-specific URLs, safe names/IDs, and registry next-page cursor links. Assert at most two simultaneous block requests.
- [x] Assert a transaction uses receipt height/index and a matching decoded hash; mismatch is an error; receipt-without-body remains visible with a limitation. Cover all six payload kinds, exact u64 values, app-unit labels and failed anchor copy.
- [x] Assert app details remain visible with no validators, no anchor, missing history or offline app peers. Known demo labels must match config appId; unknown IDs stay visible and are never interpreted as HTML.
- [x] Use fake timers/deferred fetches: only latest views poll at 5,000 ms; same head causes no repeated block reads; route change/hidden tab aborts work; late old-chain results are ignored; returning to the view refreshes. Ten-second fetch timeout must produce a retryable error.
- [x] Run `rtk pnpm exec vitest run packages/gateway/test/explorer-ui.test.ts`; verify the missing implementation fails.
- [x] Implement the controller and screens using DOM/textContent and existing browser helpers. Store only current-page summaries; load the selected block body on demand. Keep body decoding independent of signing and display raw contract data rather than guessing an ABI.
- [x] Repeat the tests. Leave main navigation integration to Task 5, after both settlement and app data paths work.

### Task 5: Add the finished feature to the node website

**Files:** Modify `packages/gateway/web/{navigation,wallet}.js`,
`packages/gateway/public/{index.html,mordecai.css}`,
`packages/gateway/test/{navigation,landing,wallet-ui}.test.ts` and
`packages/gateway/README.md`. Update gateway documentation with final paths.

**Interfaces:** Add `data-page="explorer"` and `data-page="apps"` sections with
the Task 4 containers, focusable headings and matching data-route links.
The existing navigation callback calls explorer.open(route) alongside openDemo;
query-only hash changes must reach it. Import the explorer through wallet.js,
so the existing Vite entry/build covers it without a new asset route.

- [x] Add navigation assertions for direct app/block/tx links, query-only changes,
      back/forward, page title and aria-current; preserve Account legacy aliases and demo room parameters.
- [x] Add UI regression assertions: opening Explorer without a wallet makes no
      registration/signing request; switching pages preserves a loaded account;
      standalone wallet.html works with no explorer sections; custom --static still wins.
- [x] Run the affected navigation/landing/wallet tests and observe the missing
      explorer integration failures before modifying site wiring.
- [x] Add both sections and links, integrate the controller, and apply only styles
      needed for responsive tables, long hashes and error/status messages. Update the
      README with lookup support, app naming and historical-data limitations.
- [x] Run `rtk pnpm exec vitest run packages/chain/test/registry.test.ts packages/node/test/node.test.ts packages/gateway/test` and `rtk pnpm build`. Expect all affected tests and package/browser/book builds to pass.
- [x] Run `rtk pnpm lint`; distinguish pre-existing failures in unrelated working
      changes from this feature. Run prettier check on changed explorer files/docs,
      not format-write across the user's working tree.
- [x] Smoke-test the isolated node demo at desktop/mobile widths: browse L0, Hex
      and Outpost through transaction receipts and keyboard-scroll the Apps table.
      Verify failed transactions and unavailable peers through the real DHT/API
      tests plus browser-controller tests; verify loaded-account retention and
      back/forward through wallet/navigation tests. Do not publish or deploy.

## Completion and review

Review the final diff against the spec, focusing on read-only behavior, chain
isolation, client cleanup and preservation of concurrent account/demo changes.
Report passing checks and any unavailable manual checks. Keep existing unrelated
changes out of any explorer commit. No automatic archive, name-schema migration,
address index or separate explorer deployment is included.

## Verification results — 2026-10-26

- Full suite: 499 tests in 69 files passed on the final run.
- `tsc -b`, the existing node-web Vite build, mdBook build and full ESLint passed.
- Real Chrome smoke: settlement, Apps, Hex and Outpost block/receipt navigation,
  mobile layout and keyboard table scrolling; no page errors.
- Independent task and whole-feature reviews completed; findings fixed and reviewed.
- Valid dot-only app IDs use additive query aliases, with actual URL-parser regressions.
- One earlier contract-confirmation timeout passed in isolation and the full rerun;
  no cause was established, and transaction-path code was not changed to mask it.
- No production deployment or permanent app archive.
