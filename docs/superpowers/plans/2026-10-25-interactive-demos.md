# Interactive Demos Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development. The user explicitly requested parallel app workers; this overrides the skill's sequential dispatch default.

**Goal:** Three more playable node demos, plus separate proposals for tipped microblogging and information bounties.
**Architecture:** Reuse Hex embedding and wallet sessions; per-demo startup modules mount services on the existing persistent L1. Root owns shared integration while app workers own disjoint files.
**Tech Stack:** Existing Node/TypeScript, React/Vite, DSL/WASM, Vitest; a verified chess rules library.
**Spec:** docs/superpowers/specs/2026-10-25-interactive-demos-design.md

## Global Constraints

- Preserve existing genesis, Hex state, balances and bootstrap records.
- One persistent shared world each for Frontier and Outpost.
- Keys stay in the wallet; public configs and games receive only revocable facades.
- All on-chain sends share nonce locks and uncertain receipt handling.
- Preserve native Chess and standalone game builds.
- No push, public deployment or new-site implementation. Commit complete increments.
- All shell commands start with `rtk`. Workers do not stage/commit shared work or spawn agents; root commits reviewed scopes.

## Review Focus

- Wallet changes during pending requests must revoke old sends and discard stale reads.
- Adding app deployments must preserve existing identities and bootstrap journals.
- App validators/relayers must not collide across chains or spend concurrent nonces.
- Incorrect Outpost deliveries must not pay out or block other valid orders.
- Chess room authentication, replay, retries and concurrent creation must bind to the correct wager.

## Shared interfaces

Root supplies boot context `{base, repoRoot, rpc, chainId, nodeKey, bootstrap, bootL1}`.
`bootL1(step, payload)` journals a confirmed transaction using the existing relayer;
all new boot calls happen before any anchor daemon starts. Prefix step names by demo.

Each module exports `bootFrontier(ctx)`, `bootOutpost(ctx)` or `bootChess(ctx)`.
Returns `{config, networks?, handleRequest?, start?, close?}`. `start()` begins timers
after all bootstrap work. `close()` stops services. `networks` uses GatewayOptions
shape. `handleRequest(req,res,url): Promise<boolean>` handles only Chess room routes
and returns false otherwise. Root mounts it ahead of generic app-chain routing.

Embedded bundles export `mount(container,{session,config})`, IIFE globals
`MordecaiFrontier`, `MordecaiOutpost`, `MordecaiChess`, at `demo-assets/<name>.js`.
Bundle configs must use `emptyOutDir:false` because assets share a directory.
`session.getSnapshot()` exposes `{address,publicKey,sendTransaction}` with the Hex
signature `(base,chainId,payload,maxFee)`. Chess adds a narrow `signChessMessage`
method implemented in `packages/wallet/src/chess.ts`; root wires that callback
into the session without exposing wallet seeds. Chess worker defines and tests
the exact typed schema and reports it to root.

### Task 1: Frontier (worker)

**Files:** apps/frontier-web/**; scripts/lib/frontier-demo.mjs; docs/src/examples/frontier-web.md.
**Interfaces:** bootFrontier context above; returns config `{chainId,contract}`.

- [ ] Add failing tests for facade sends, input bounds and wallet-aware behavior.
- [ ] Adapt the existing app to optional supplied config/session, preserving standalone mode; replace embedded identity switch and fixed transfer recipient.
- [ ] Add isolated embed entry/build config and persistent L1 deployment helper.
- [ ] Run scoped tests and standalone/embedded build; record outputs and report file ownership.

### Task 2: Outpost (worker)

**Files:** apps/outpost-web/**; scripts/lib/outpost-demo.mjs; scripts/lib/outpost-outcome.mjs; scripts/outpost-demo.mjs; docs/src/examples/outpost.md; scoped tests under apps/outpost-web/test.
**Interfaces:** bootOutpost returns `{config,networks:{outpost},start,close}`; config includes chainId, appChainId, appId, market, outpost, appApi `/api/demos/outpost`, appFaucet `/api/demos/outpost/api/faucet`.

- [ ] Add failing tests for exact delivery matching, unrelated valid deliveries, app-only funding and facade sends.
- [ ] Adapt browser app to supplied wallet/config, fee-aware amounts and disconnected state.
- [ ] Create persistent boot module with distinct app validator identities, app faucet and L1 relayer; use existing bootstrap journal and defer daemon startup.
- [ ] Share corrected settlement selection with standalone launcher; document non-atomic cancellation limit.
- [ ] Run scoped tests and both builds; report configuration and lifecycle details.

### Task 3: Chess (worker)

**Files:** apps/chess-web/** (new); packages/wallet/src/chess.ts and its export/test; packages/gateway/src/chess-rooms.ts and its tests; scripts/lib/chess-demo.mjs; compiler/examples/chess_wager.pysc; rebuilt contracts/dist/chess_wager.wasm; apps/chess/test/**; docs/src/examples/chess.md.
**Interfaces:** bootChess returns `{config,handleRequest,close}`; root mounts room handler. Root owns gateway.ts and package/root lockfile integration. Send dependency requests to root before installing.

- [ ] Verify chess-rules library via official documentation/license; provide dependency changes to root.
- [ ] Test typed message signatures, room/deployment binding, replay and illegal-move rejection, identical retry and durable recovery.
- [ ] Implement narrow wallet signing, authenticated room API, persistent ordered messages and deterministic room-to-wager association.
- [ ] Extend wager with mutually agreed draw refund, preserve existing report API; rebuild only affected WASM and test winner/draw/cancel paths.
- [ ] Build browser board, invitations, promotion, game results, spectator reads and explicit pending settlement/abandoned-stake limits.
- [ ] Test concurrent rooms, fresh wallet and close/change, restart; report exact integration schema.

### Task 4: Shared integration (root)

**Files:** scripts/hex-demo.mjs; packages/gateway/{src/gateway.ts,web/_,public/_,test/*,package.json}; package.json; pnpm-lock.yaml; apps/hex-web/vite.embed.config.js; docs/src/examples/hex-web.md.

- [ ] Test additional navigation, lazy asset selection, supported app routes and session signing revocation.
- [ ] Add demo registry and pages; generalize Hex loader only as far as the four known demos require.
- [ ] Wire per-demo boot modules before anchor startup and close services on shutdown.
- [ ] Wire bounded Chess handler and message signer; retain existing transaction serialization.
- [ ] Build all assets and verify two-wallet browser flows, mobile navigation, persistent restart and original Hex behavior.
- [ ] Run full suite, lint/format, independent review and fixes; commit complete scoped increments.

### Task 5: Microblogging proposal (fourth worker, queued)

**Files:** docs/superpowers/specs/2026-10-25-tipped-microblog-design.md.

- [ ] Read existing wallet, storage/feed and payment capabilities.
- [ ] Propose smallest interactive site: posts, authors, feed, wallet identity and direct tips linked to posts; explain persistence/moderation and transaction confirmation.
- [ ] Compare viable on/off-chain content approaches, distinguish assumptions and unresolved product choices, and define an MVP acceptance walkthrough. No product code.

### Task 6: Information bounty proposal (fifth worker, queued)

**Files:** docs/superpowers/specs/2026-10-25-information-bounties-design.md.

- [ ] Read existing escrow/contract/wallet capabilities.
- [ ] Propose questions/data requests with a pinned reward, responses and a single best-response award; distinguish pledged amounts from funded escrow.
- [ ] Specify creator selection, deadline/cancel/refund policy, content privacy, funding transparency and payout confirmation; identify policy choices requiring user input. No product code.

## Coordination rulings

The user approved implementation and explicitly selected parallel agents; no further
plan approval is required. Continue in the existing feature checkout with disjoint
ownership. Only three child slots are available, so queue design workers as slots
open. Root serializes git operations and installs. No broad concurrent formatting.
Use a final independent review as the approved spec requires; inspect each worker's
scoped tests and diff before accepting its increment.
