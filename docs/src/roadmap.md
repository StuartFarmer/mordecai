# Roadmap & Limitations

## Where the implementation stands

Against the spec's phased roadmap (SPEC_PT_03 §27):

| Phase                      | Status                                                      |
| -------------------------- | ----------------------------------------------------------- |
| 0 Architecture             | ✅ specs, plan, threat model                                |
| 1 Networking foundation    | ✅ feeds, swarms, replication                               |
| 2 Settlement chain         | ✅ single-sequencer _and_ multi-validator BFT               |
| 3 Wallet & identity        | ✅ wallets, keystores, Signer, sessions                     |
| 4 Smart contracts          | ✅ wasmi-in-wasm VM, marketplace contract                   |
| 5 Application registry     | ✅ on-chain registry + verified install                     |
| 6 Pear runtime integration | ✅ SDK, wallet daemon + RemoteSigner (shell UI pending)     |
| 7 Pythonic DSL             | ✅ hssnc: parse → verify → Rust → wasm32                    |
| 8 Example applications     | ◐ chess shipped; marketplace/reddit/AI/wiki pending         |
| 9 Economic primitives      | ◐ escrow + marketplace as patterns; no reusable library yet |
| 10 Platform ecosystem      | ◐ CLIs + this book; explorer/package manager pending        |

The spec §28 vertical slice — install from registry, wallet auth, p2p state
sync, on-chain payment, finalized confirmation, keep playing — passes end
to end on a multi-validator devnet (`packages/sdk/test/vertical.test.ts`).

Beyond the original phases, the `feat/app-chains` line adds two tiers on
top (SPEC_APPCHAINS.md):

- **The web tier** — the HTTP [gateway](apps/gateway.md), contract-state
  reads, and browser clients with in-browser signing
  ([frontier-web](examples/frontier-web.md)).
- **App chains** — per-app consensus with anchored outcomes
  ([architecture](architecture/app-chains.md),
  [how-to](apps/app-chains.md)), proven by the
  [outpost](examples/outpost.md) cross-chain goods market.

## Known limitations (deliberate v1 scope)

Security-relevant items are tracked in the [Threat Model](architecture/threat-model.md);
the headline ones:

- **Permissioned validators.** The set is fixed at genesis; staking,
  rotation, and slashing are future work. Safety needs < 1/3 Byzantine.
- **Consensus liveness gap.** One-vote-per-height locking has no unlock: a
  proposer crash mid-vote can stall a height (never fork it) until the
  locked validators restart. (Missed-gossip stalls are healed — locked
  proposals re-broadcast on stall rounds — but the crash case remains.)
- **Anchors attest, they don't prove.** An app chain's quorum can anchor
  a lie; the blast radius is confined to stakes voluntarily placed
  against that app. Co-signers vet state roots but not outcome-call
  semantics yet — per-app call vetting is the next hardening step. Fraud
  proofs are deliberately out of scope.
- **Flat fees, no fee market** — a funded spammer can fill blocks.
- **Single-writer feeds only.** Community-style apps (forums, wikis) need
  multi-writer structures (Autobase) — the biggest platform gap for the
  remaining example apps.
- **Pull-based events.** Receipt polling instead of subscriptions.
- **Full-scan state root.** Fine at devnet scale; swap for an incremental
  commitment behind the existing `StateCommitment` interface when it hurts.
- **The Pear desktop shell.** The approval-UI seam (`ApprovalPrompt`), the
  daemon, and remote signing are built and tested; hosting apps in the
  actual Pear/Bare shell with a real prompt window is product work that
  can't be validated headlessly.

## Natural next steps

1. Bare-compat audit of the app-side packages (`"bare"` export conditions).
2. The Pear shell: wallet UI over `WalletDaemon`, launcher → `pear run`.
3. Autobase adoption + the Reddit-style example.
4. Economic-primitives library in the DSL (auction, subscription, DAO) —
   the wager contract is the template.
5. Explorer + event subscriptions on the RPC.
