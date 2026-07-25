# Mordecai

## A Decentralized Operating System for Peer-to-Peer Applications

---

# 1. Goal

Build a minimal decentralized platform that combines:

- Native peer-to-peer networking.
- Distributed application hosting.
- Fast deterministic settlement.
- Digital-currency-grade consistency.
- Smart contracts.
- Native digital payments.
- Global identity.
- A Python-like smart contract language.
- A foundation for games, marketplaces, AI services, and decentralized applications.

Unlike traditional blockchains, the blockchain is **not** the application platform.

Instead, the platform consists of two complementary systems:

```txt
Holepunch Network
    ↓
Distributed Applications

Settlement Chain
    ↓
Trust + Ownership + Payments
```

Applications remain peer-to-peer.

Only economic state is globally replicated through consensus.

---

# 2. Vision

Modern web applications combine three independent systems:

```txt
Frontend

↓

Backend

↓

Database
```

A decentralized platform should preserve this separation rather than attempting to execute entire applications on-chain.

This project instead separates responsibilities into four layers.

```txt
Pear Applications

↓

Holepunch Network

↓

Settlement Chain

↓

Consensus
```

Each layer has a narrowly defined purpose.

---

## Pear Applications

Applications provide:

- User interface
- Game logic
- AI interaction
- Chat
- Media
- Multiplayer
- Local computation

Applications should feel like ordinary software.

They are simply distributed instead of hosted.

---

## Holepunch Network

Holepunch provides:

- Peer discovery
- NAT traversal
- Secure transport
- Distributed storage
- Replication
- Streaming
- Package distribution

Holepunch never attempts to determine truth.

It simply distributes signed data.

---

## Settlement Chain

The blockchain provides:

- Identity
- Wallets
- Native currency
- Ownership
- Smart contracts
- Economic settlement
- Global state

It does **not** provide:

- File storage
- Chat
- Streaming
- Game simulation
- Rendering
- AI inference

---

## Consensus

Consensus exists solely to produce deterministic agreement.

Its responsibilities are intentionally small:

- Order transactions
- Execute contracts
- Validate signatures
- Produce finalized blocks
- Replicate economic state

Nothing else.

---

# 3. Fundamental Philosophy

The central design principle is:

> Applications are distributed programs.
>
> The blockchain is a distributed trust engine.

Most existing blockchains blur these responsibilities.

This project deliberately separates them.

---

## Three Categories of State

Every piece of data belongs to one of three categories.

### Ephemeral State

Temporary information that exists only while an application is running.

Examples:

- Mouse movement
- Voice chat
- Video streams
- Live player position
- Temporary AI context
- Network sessions

Properties:

- Never stored permanently.
- Never globally replicated.
- Never part of consensus.

---

### Shared State

Persistent application data that should replicate between peers but does not require universal agreement.

Examples:

- Chat history
- Chess moves
- Documents
- Music
- Videos
- Images
- Reddit posts
- Game replays

Properties:

- Stored in Hypercore.
- Signed by their author.
- Append-only.
- Efficiently replicated.
- May be mirrored by anyone.

Shared state is authentic, but not globally authoritative.

---

### Economic State

Information that every participant must agree upon forever.

Examples:

- Wallet balances
- Token ownership
- Marketplace orders
- Escrow
- Smart contract storage
- Governance
- Identity
- Reputation with financial consequences

Properties:

- Stored on-chain.
- Finalized through consensus.
- Deterministic.
- Globally replicated.

Economic state is intentionally small.

---

# 4. Design Principles

The platform follows several core principles.

---

## Principle 1

Only scarce resources belong on-chain.

Examples:

```txt
Currency
Ownership
Escrow
Governance
Identity
```

Everything else remains peer-to-peer.

---

## Principle 2

Applications are first-class citizens.

The blockchain exists to serve applications.

Applications do not exist to serve the blockchain.

---

## Principle 3

Consensus is expensive.

Consensus should never be used for:

- Chat
- Multiplayer synchronization
- File storage
- AI inference
- Media streaming

Consensus is reserved only for operations requiring global trust.

---

## Principle 4

Applications remain usable offline or locally whenever possible.

The blockchain is consulted only when economic state changes.

---

## Principle 5

Every application automatically receives:

- Identity
- Wallet
- Payments
- Ownership
- Smart contracts

without implementing these independently.

---

## Principle 6

Networking and economics remain independent.

Applications continue functioning even if they perform no blockchain operations.

---

# 5. Overall Architecture

The complete platform consists of four independent systems.

```txt
                User
                  │
                  │
          Pear Application
                  │
     ┌────────────┴────────────┐
     │                         │
     │                         │
Hypercore APIs          Blockchain APIs
     │                         │
     │                         │
Holepunch Network      Settlement Chain
     │                         │
     └────────────┬────────────┘
                  │
             Consensus
```

Each system has clearly defined responsibilities.

---

## Pear

Responsible for:

- User interface
- Local computation
- Application logic
- Rendering
- Networking APIs
- Wallet integration

Never responsible for:

- Consensus
- Economic settlement
- Ownership

---

## Hypercore

Responsible for:

- Files
- Chat
- Media
- Event logs
- Multiplayer synchronization
- Distributed databases

Never responsible for:

- Truth
- Ownership
- Payments

Hypercore distributes data.

It does not validate economics.

---

## Settlement Chain

Responsible for:

- Wallet balances
- Smart contracts
- Identity
- Native currency
- Ownership
- Marketplace settlement
- Governance

Never responsible for:

- Images
- Videos
- Game state
- Streaming
- AI

---

## Consensus

Responsible for:

- Transaction ordering
- Contract execution
- Finality
- State commitment

Never responsible for application execution.

---

# 6. Networking Layer

The networking layer is built entirely on the Holepunch ecosystem.

Its purpose is to make distributed applications as simple to build as traditional client/server software.

---

## HyperDHT

HyperDHT provides decentralized peer discovery.

Applications use it to locate peers without centralized servers.

Responsibilities:

- Peer lookup
- Public key routing
- NAT traversal support
- Secure rendezvous

Applications never need to know IP addresses.

---

## Hyperswarm

Hyperswarm builds encrypted peer-to-peer overlays.

Responsibilities:

- Peer connections
- Swarm membership
- Connection management
- Replication transport

Applications join swarms using cryptographic identifiers.

---

## Hypercore

Hypercore is the distributed storage primitive.

Every feed is:

- Append-only
- Signed
- Verifiable
- Replicable

Examples:

```txt
Chat Feed

↓

message

message

message
```

```txt
Replay Feed

↓

move

move

move
```

```txt
Document Feed

↓

revision

revision

revision
```

The blockchain never stores these feeds.

---

## Pear

Pear is the distributed application runtime.

Applications are installed directly from the network.

```txt
Install Application

↓

Lookup Registry

↓

Retrieve Pear Key

↓

Join Swarm

↓

Download Bundle

↓

Verify Signature

↓

Launch
```

Applications are no longer downloaded from centralized app stores.

---

## Networking Guarantees

The networking layer guarantees:

- Peer discovery
- Encrypted transport
- Content authenticity
- Efficient replication
- Offline synchronization
- Decentralized application distribution

The networking layer does **not** guarantee:

- Economic correctness
- Ownership
- Identity
- Trust
- Payments
- Consensus

Those responsibilities belong exclusively to the settlement chain.

---

# End of Part 1

The first part establishes the architectural philosophy and networking model. The next section will define the settlement blockchain itself: its execution model, smart contracts, wallets, identity, transaction lifecycle, and the boundary between on-chain economic state and off-chain application state.
