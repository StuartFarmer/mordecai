# Social demos and Outpost focus

The user approved building the proposed microblog and information bounty sites with
subagents, and identified Outpost as too similar to Frontier. The two existing
social-demo specifications define the MVP. All balances and rewards use test CAI.

## Ownership and scope

- Microblog worker: signed public posts, durable feed and tip attribution, confirmed
  payment verification, embedded UI, typed wallet messages, tests and guide.
- Bounties worker: escrow contract, bounded public text, response/award/refund UI,
  compiler byte-length validation, monetary tests and guide.
- Outpost worker: orders and settlement first; production remains available in a
  secondary supply section. Preserve the existing world and contracts.
- Coordinator: shared wallet reservations and revocation, signing domains,
  navigation/assets/API routing, launcher, workspace dependencies, integration
  tests, preview verification and incremental Git commits.

## Completion checks

- [x] Outpost foregrounds buying, delivery and settlement.
- [x] Microblog posts survive restart; tips count only proven successful payments.
- [x] Bounties enforce escrow, authorization, deadlines and mutually exclusive payouts.
- [x] Both sites use the shared wallet and appear under Demos.
- [x] Tests, build, lint and formatting pass.
- [x] Browser flows and persistent-node restart checked; changes committed.

## Verification

357 tests across 63 files and nine compiler tests passed. The full TypeScript,
six-demo bundle and mdBook build, ESLint and Prettier checks passed. Independent
review found and fixed a mutable attribution input race and blocked receipt
lookups; regressions cover revocation, exact-byte retries, transport timeouts,
and confirmation recovery after ten stalled probes.

Desktop browser checks used two public fixture wallets to publish a signed post,
tip it 100 test CAI, fund a 10,000-test-CAI bounty, submit a response and award it.
The recipient's balance increased by exactly 10,000. Both new sites were checked
at mobile width. A final persistent-node restart preserved the post, confirmed
tip, bounty award and recipient balance, plus all six existing game contracts.
The preview remains at `http://127.0.0.1:8790`.

Incremental commits include `9aa2fa3` (Outpost) and `1c9cfee` (bounty contract);
the integration commit includes both browser sites, shared wallet support and guides.

No public deployment, real-money launch, private submissions, social ranking or
dispute arbitration is included. Bounty creators choose the winner; unanswered or
unawarded bounties refund the creator after their award deadline.
