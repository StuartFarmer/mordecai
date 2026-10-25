# Interactive Frontier, Outpost and Chess demos

Status: approved by the user; implementation authorized with three parallel agents.

Independent builder check: no important unanswered planning questions.

## Intent and confirmed scope

Visitors should use the node site's Wallet and Faucet, then select a working
demo from Demos without importing their key again. The user requested preparing
the remaining apps like Hex, continuing incremental git commits, and selected
**one persistent shared world per demo** for Frontier and Outpost.

Implement Frontier, Outpost and Chess in parallel, as subsequently requested. Keep the running Hex deployment,
wallet balances and rooms. All native-token transactions use the existing
`mordecai-demo` L1. App-chain fee balances remain separate. No public deployment
or push is included.

## Approaches

- Reuse the embedded React/Shadow DOM and revocable wallet facade already used
  by Hex. This preserves the existing game UIs and the single-wallet experience.
  This is the proposed implementation approach.
- Separate standalone sites would preserve more of the current boot scripts,
  but require another key import and would fragment the node demo experience.
- Separate invite-only worlds for the economy games would require isolated
  contracts/markets or room-aware contract storage. The user selected shared
  worlds instead. Chess remains a two-player match with invite links.

Chess has no browser client today. Preserve its off-chain-moves/on-chain-wager
split by relaying wallet-signed game messages through the node. Direct browser
HyperDHT access is not supported by the current networking stack; requiring a
native client would defeat the browser demo. This relay is an implementation
proposal, not a user-selected transport. Keep the existing native ChessMatch
library working and describe the web transport accurately in the docs.

## Shared integration

- Add working routes and lazy bundles for Frontier, Outpost and Chess under the
  existing Demos dropdown. Build all bundles without deleting one another.
- Reuse the wallet session, transaction serialization, receipt history, uncertain
  submission retry and close/change revocation. No seeds in props, public config,
  URLs, room records or browser persistence. An absent wallet shows a Wallet link.
- Keep each demo's CSS contained. Replace Alice/Bob identity switches in embedded
  apps with the loaded address, own/other-player labels and a Manage wallet link.
- Validate numeric amounts as positive bounded integers before signing, and
  include fees in affordability checks. Use the Faucet tab for L1 funding.
- Preserve standalone clients and existing launcher commands. Their legacy
  development-account mode stays explicitly separate from the embedded demos.
- Extend the persistent node host through small per-demo boot modules, reusing
  `bootstrapTransaction` and existing gateway mounts. Add deployments without
  changing existing genesis, Hex bootstrap records or stored identities.
- New services must stop cleanly. Separate or serialize operator spenders so
  bootstrapping, anchoring and funding cannot race a shared account nonce.

## Frontier

Deploy and initialize the existing Frontier contract once on the shared L1.
Visitors claim tiles, build, harvest, trade goods and transfer owned tiles to a
validated wallet address. Reuse the existing map and market. The world has the
existing 144 tiles; when full, explain this state rather than resetting players'
land. No per-user quota, automatic reset, private worlds or new game mechanics.

Resource growth follows block height, as it does today. Do not promise that
waiting alone produces resources; describe the rule and show current growth.
Other players' transactions and the running demo's anchors can advance height.

## Outpost

Run one persistent Outpost app chain, its goods-market contract on the shared
L1, and its own anchor daemon. Give Outpost distinct persisted validator identities:
the current co-signing RPC identity serves one app, so sharing Hex's validator
keys would conflict. Give its L1 relayer a separate persisted spending identity
or a shared serialization mechanism. Fund app fees through a dedicated mounted
faucet, following Hex. Never expose operator keys as player accounts.

Visitors claim land, build and harvest on the app chain. Buyers escrow test CAI
on L1; another wallet delivers goods in Outpost, then settlement pays the seller.
Show submitted, delivered, settling, confirmed and cancelled states distinctly.

The existing outcome callback checks only the order ID and open phase. Before
releasing payment, compare delivery buyer, good and amount against the actual L1
order and verify its open state. A mismatched delivery must never pay out or
prevent processing unrelated valid deliveries. Cover this with regression tests.

This MVP retains separate commits on the two chains. An invalid delivery can
occupy that order's app-chain delivery slot; its buyer can cancel the open L1
order and place a new one. A cancellation racing delivery can leave transferred
test goods without payment. Explain that limit in the guide and surface a
cancelled-order status in the UI; do not claim atomic exchange. A reservation
protocol is outside this demo conversion.

## Chess

Add a small browser board with legal move selection, promotion, move history,
check/checkmate/stalemate state, resignation, and draw handling. Use a maintained
chess-rules library, after checking its official API and license, rather than
writing a rules engine. Reuse existing React/build dependencies.

Create/join a two-player room with a copyable invitation URL. The creator plays
white, the joiner black; another copy of the same wallet cannot join itself.
Use the shared wallet for wager creation/join/result transactions, and expose
public state to spectators without granting them a signing role.

The proposed browser transport is a same-origin room API. Persist ordered,
wallet-signed messages; verify signatures and chess rules on the host and when
replaying in the browser. A narrow session method signs only typed Chess messages
with a separate domain, chain/deployment identity, room ID, sequence number and
previous-message hash. Never offer an arbitrary raw-signing API. This prevents
cross-room replay, stale moves and transaction-signature reuse.

Authenticate both room membership and each append. Verify wager participation
against confirmed L1 state before enabling moves. Bind room IDs to wager IDs
unambiguously, including concurrent creations. Conflicting appends fail without
changing history; retrying an identical accepted message returns the same result.
Serialize durable writes per room and validate body sizes, message schemas and
path identifiers. Wallet close or replacement revokes later message signatures.

Reuse ChessWager for stakes and matching result reports. Extend it minimally for
mutually agreed draws/refunds while preserving its existing winner-report API and
native tests. Only creator cancellation before a join is unilateral. A browser
checkmate/resignation result prompts the corresponding signed on-chain report;
settlement requires matching reports from both wallets. Show whose report is
still missing. There is no automatic adjudication of disputes or abandoned active
matches in this MVP, so test stakes can remain locked if a player refuses to report.
Make that limitation visible before staking. Never present a local game result
as a completed payout until the receipt confirms it.

Room history and state survive host restart, and loading the same wallet restores
access from its invite link. A relay can withhold service, but cannot forge a
player's signature; this is not a claim of direct browser-to-browser replication.

## Verification and commits

1. Commit the approved design and implementation plan.
2. Commit Frontier after two-wallet claiming, building, harvesting, trading and
   transferring work through the node wallet.
3. Commit Outpost after two-wallet order/delivery/payout and mismatched-delivery
   rejection work; preserve the existing L1 and Hex state across restart.
4. Commit Chess after create/join, legal/illegal moves, signature/replay rejection,
   resignation/winner payout, agreed-draw refund and room recovery pass.
5. Update mdBook/startup docs; verify builds, meaningful regression tests, lint,
   formatting, mobile navigation and wallet close/change for all demos.

Use one independent review before completion. Keep changes reviewable and leave
the local node demo running. No reset of the user's persistent demo data.

## Calls left to implementation

Exact module/file names, factoring shared encoders or embed helpers when genuinely
repeated, chess board presentation, the rules-library version, and the durable
room-store representation. Prefer existing code and dependencies; add no generic
plugin framework, matchmaking service, account system or public room directory.
