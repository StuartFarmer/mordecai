# Consensus

HSSN v1 runs a deliberately simple fixed-validator BFT protocol
(`@hssn/consensus`). The goals, in order: **safety** (no two conflicting
finalized blocks), **immediate finality** (no reorgs, ever), and
simplicity. Open participation is explicitly out of scope for v1.

## The protocol

- The validator set is fixed in the genesis config. Quorum is
  `⌊2n/3⌋ + 1` votes.
- The proposer for `(height, round)` is `validators[(height + round) mod n]`
  — a deterministic round-robin.
- The proposer drafts a block from its mempool, **validates it fully
  without committing**, broadcasts it, and votes for its hash.
- Every validator that receives the proposal re-executes it against its own
  head; if the state root matches, it votes.
- A validator votes for **at most one block hash per height** and stays
  locked on it. When any hash gathers a quorum of votes, everyone holding
  the verified block commits it, storing the votes as the block's
  **finality certificate**.
- If a proposer is silent past the round timeout, the round increments and
  the next validator may propose.

Blocks are produced on demand — when there are pending transactions — not
on a fixed tick, so an idle chain writes nothing.

## Why one-vote-per-height is safe

Two conflicting quorums would require `≥ n/3` validators to vote for two
different hashes at the same height. Honest validators never do (they lock
on their first vote), so safety holds under the standard `< n/3` Byzantine
assumption — without implementing full Tendermint rounds.

The trade-off is **liveness**: there is no unlock rule, so if a proposer
crashes _after_ some validators voted but before quorum, that height can
stall until those validators restart. This is a documented v1 gap (see the
[Threat Model](threat-model.md)); the common failure — a validator that is
simply down when its proposer turn comes — is handled cleanly by round
rotation and is covered by tests.

## Certificates and catch-up

Every finalized block stores its quorum votes. This makes blocks
_self-verifying_: a brand-new node syncs by requesting block ranges from
any peer on the consensus mesh and, for each block, independently checks
the proposer signature, re-executes every transaction, compares state
roots, and verifies that the certificate carries ≥ quorum valid validator
signatures over the block hash. The serving peer is completely untrusted.

## Transaction gossip

Any node's RPC accepts a transaction; after mempool admission it is
broadcast to the mesh so every validator holds it. Mempools order
per-sender by nonce and only feed proposers contiguous nonce runs.

## What's tested

The suite (`packages/consensus`, `packages/node`) proves: four validators
converge to identical heads with ≥ quorum certificates; the chain keeps
committing after the next-up proposer is killed (round skip); a
late-joining observer syncs from genesis with certificate verification;
and an RPC-submitted transfer settles identically on validators that never
saw the submission.
