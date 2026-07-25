# What a P2P App Is (and Isn't)

A Mordecai application is **ordinary software that happens to be distributed**.
It runs on the user's machine, renders its own UI, talks directly to other
users' machines, and consults the blockchain only when money or ownership
changes hands. If you have built a client-server app, the mental shift is:

> There is no server. The users who care about some data _are_ its
> infrastructure. The chain is not your database — it is your escrow agent,
> land registry, and payment rail.

## A p2p app IS

- **Locally executed.** Game logic, rendering, AI inference, media playback
  all happen on-device. Apps keep working offline and sync when peers
  reappear.
- **Peer-replicated.** Persistent app data lives in signed append-only
  feeds; peers exchange them directly (see
  [Three Kinds of State](../architecture/state.md)).
- **Wallet-native.** The user's key _is_ their account in every app —
  authentication is a signature over a challenge, not a password.
- **Economically able.** Payments, escrow, and ownership are one SDK call,
  because every app shares the settlement chain.

## A p2p app is NOT

- **A dApp in the Ethereum sense.** Application logic does not run
  on-chain. There is no "web page that calls a contract for everything."
  The contract is a small deterministic settlement program; the app is the
  product.
- **Trustless end to end.** The _chain_ is authoritative; the _app_ is
  trusted only by the user running it (a malicious app can lie to its own
  user's screen — which is why signing authority lives outside the app; see
  [Wallets, Identity & Sessions](identity.md)).
- **Automatically consistent.** Two peers' feeds are each internally
  ordered, but there is no global order across writers. If your app needs
  universal agreement on something, that thing is economic state and
  belongs on-chain — or it needs an application-level merge rule (chess
  interleaves two single-writer feeds by ply; a forum would need
  multi-writer structures, a known v1 gap).

## The design worksheet

For every piece of data, ask in order:

1. **Does anyone need it after the session ends?** No → ephemeral, plain
   memory.
2. **Must every participant in the world agree on it, forever?** No →
   shared state, put it in a feed. This should be ~95% of your data.
3. **Is it scarce — money, ownership, a unique name, an escrowed promise?**
   Yes → economic state: a transfer, a registry entry, or a contract.

Then design the contract as the _referee of last resort_, not the game
engine: it should verify claims and move value, never simulate gameplay.
The wagered-chess contract never sees a chess move — it escrows two stakes
and pays out when both players sign the same result. The signed move feeds
exist as dispute evidence, not as contract inputs.

## Trust boundaries you inherit

- Feed entries are unforgeable but not unhostable — assume anything you put
  in a feed may be mirrored forever.
- Whoever holds a feed's key can _append_; nobody can rewrite. Design
  around append-only (e.g. "tombstone" entries instead of deletes).
- The chain's word is final: if the app's local view disagrees with a
  finalized receipt, the receipt wins.
