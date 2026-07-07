# Introduction

Mordecai Network is a decentralized platform for peer-to-peer software. It
combines two independent systems:

```text
Pear Applications          ← UI, game logic, chat, media, simulation
      │
Holepunch Network          ← peer discovery, encrypted transport,
      │                      replicated storage, app distribution
Settlement Chain           ← identity, currency, ownership, contracts
      │
Consensus                  ← deterministic ordering + finality
```

The defining principle: **applications are distributed programs; the
blockchain is a distributed trust engine.** They are deliberately kept
apart.

- Your app's data — chat, documents, game moves, media — lives in signed,
  append-only **Hypercore feeds**, replicated directly between the peers who
  care about it. No servers, no consensus, no fees.
- Only **economic state** — balances, ownership, escrow, the app registry —
  goes through the chain, where a fixed validator set orders transactions,
  executes contracts deterministically, and finalizes blocks with BFT
  quorum certificates.

A marketplace listing, seller conversation, image set, and reputation trail
can replicate directly between interested users. The chain only gets involved
when a purchase needs one public answer: payment transferred, ownership moved,
or escrow released. That ratio — everything local and peer-to-peer except the
few operations that need global trust — is the whole design.

## What every application gets for free

By building on the SDK, an application inherits (spec principle 5):

- **Identity** — the user's Ed25519 wallet key works in every app; the same
  key signs transactions, owns Hypercore feeds, and answers login
  challenges.
- **Payments** — native currency transfers and contract calls are one SDK
  method, not a payment-processor integration.
- **Ownership & contracts** — deploy WASM contracts (written in Rust or the
  Pythonic DSL) for escrow, marketplaces, wagers, governance.
- **Distribution** — apps are registered on-chain and fetched from the
  swarm, verified against the on-chain hash. No app store.
- **Replication** — append-only feeds with authenticated history, live sync,
  and offline catch-up.

## How to read this book

- **Quickstart** gets a devnet running and money moving in five minutes.
- **Architecture** explains each layer and the boundaries between them.
- **Building P2P Applications** is the developer guide: what belongs
  on-chain vs off, the SDK surface, identity, and publishing.
- **Smart Contracts** covers the execution model, a step-by-step DSL
  tutorial, the full language reference, and the raw Rust ABI.
- **Examples** walks through the shipped apps and contracts.
- **Reference** documents the CLIs, the RPC API, and the repo.

The normative sources remain the specifications in the repository root
(`SPEC_PT_01–03.md`) and `IMPLEMENTATION_PLAN.md`; this book documents the
system as actually built.
