# Mordecai

## Part 3 — Developer Platform, Roadmap, Repository Structure, and Design Principles

---

# 21. Smart Contract Language

Application developers should not be required to write low-level blockchain code.

Instead, they should write contracts using a small, deterministic, Python-like language that compiles into safe contract bytecode.

The language should prioritize:

- readability
- simplicity
- deterministic execution
- static verification

rather than becoming a general-purpose programming language.

---

## Example

```python
contract Marketplace:

    action buy(item_id):

        item = Item[item_id]

        require(item.owner != sender)
        require(Account[sender].balance >= item.price)

        transfer(
            from=sender,
            to=item.owner,
            amount=item.price
        )

        item.owner = sender
```

The language should feel familiar to Python users while remaining intentionally constrained.

---

## Compilation Pipeline

Contracts never execute as Python.

Instead:

```txt
Python Source

↓

Parser

↓

Typed AST

↓

Static Verification

↓

Intermediate Representation

↓

Generated Rust

↓

WASM

↓

Deploy
```

Only verified deterministic code reaches the blockchain.

---

## Language Restrictions

Version 1 should deliberately remain small.

Supported:

- integers
- booleans
- strings
- addresses
- maps
- structs
- enums
- arithmetic
- comparisons
- simple conditionals
- deterministic loops with static bounds
- contract actions

Not supported:

- floating point
- reflection
- recursion
- imports
- threads
- networking
- filesystem access
- randomness
- wall-clock time
- dynamic code execution

The language should evolve slowly.

Simplicity is a feature.

---

# 22. Runtime APIs

Applications interact with two independent runtimes.

---

## Hypercore API

Provides:

```txt
create_feed()

append()

replicate()

subscribe()

publish()

download()

join_swarm()
```

These APIs manipulate distributed application state.

---

## Blockchain API

Provides:

```txt
wallet()

sign()

transfer()

deploy()

execute()

query()

subscribe_events()
```

These APIs manipulate economic state.

---

Applications compose both APIs naturally.

---

# 23. Developer Workflow

Building an application should resemble modern software development.

```txt
Create Pear Project

↓

Develop Application

↓

Create Smart Contracts

↓

Deploy Contracts

↓

Register Application

↓

Publish Pear Bundle

↓

Users Install

↓

Application Joins Network
```

The blockchain is simply another service consumed by the application.

---

# 24. Repository Structure

The project should be organized as a monorepo.

```txt
platform/

    chain/
        consensus/
        state/
        contracts/
        node/
        wallet/

    networking/
        hypercore/
        hyperswarm/
        replication/
        storage/

    pear/
        runtime/
        package/
        installer/
        launcher/

    sdk/
        rust/
        python/
        typescript/

    compiler/
        parser/
        verifier/
        codegen/
        templates/

    contracts/
        token/
        identity/
        escrow/
        marketplace/
        dao/
        auction/

    applications/
        registry/
        explorer/
        wallet/
        examples/

    examples/
        chess/
        reddit/
        marketplace/
        ai/
        wiki/

    docs/
        architecture.md
        protocol.md
        language.md
        sdk.md
        threat-model.md
```

Each subsystem should remain independently testable.

---

# 25. Protocol Layers

The platform naturally separates into protocol layers.

```txt
Layer 5

Applications

────────────────────────

Layer 4

SDKs

────────────────────────

Layer 3

Smart Contracts

────────────────────────

Layer 2

Settlement Chain

────────────────────────

Layer 1

Holepunch Network

────────────────────────

Layer 0

Cryptography
```

Each layer depends only on the one beneath it.

This minimizes coupling.

---

# 26. Security Model

Security depends on several independent boundaries.

---

## Identity

Every transaction must be signed.

No unsigned state transition is accepted.

---

## Consensus

Validators independently execute every transaction.

State divergence is impossible without Byzantine failure.

---

## Smart Contracts

Contracts:

- execute deterministically
- own isolated storage
- communicate only by messages
- cannot access host resources

---

## Applications

Applications are trusted only by the user running them.

Applications never gain permission to modify blockchain state directly.

They submit signed requests through wallets.

---

## Networking

Hypercore verifies:

- signatures
- append-only history
- feed authenticity

It does **not** verify ownership or economic correctness.

---

## Design Philosophy

Networking is trustless.

Consensus is authoritative.

Applications are user-controlled.

Contracts are deterministic.

---

# 27. Development Roadmap

The platform should be built incrementally.

Every phase should produce a usable system.

---

# Phase 0 — Architecture

Goal

Define the platform.

Deliverables

- Architecture specification
- Protocol definitions
- Repository structure
- Threat model
- Development tooling

No implementation.

---

# Phase 1 — Networking Foundation

Goal

Establish distributed networking.

Deliverables

- HyperDHT integration
- Hyperswarm integration
- Hypercore feeds
- Basic replication
- Pear application launcher

Milestone

Two peers exchange replicated data.

---

# Phase 2 — Settlement Chain

Goal

Create the global trust engine.

Deliverables

- Validators
- Native currency
- Wallets
- Transactions
- Block production
- Finality
- RPC

Milestone

Users transfer currency between wallets.

---

# Phase 3 — Wallet & Identity

Goal

Provide universal authentication.

Deliverables

- Key generation
- Signing
- Identity management
- Wallet SDK
- Application authentication

Milestone

Every Pear application automatically recognizes the user's wallet.

---

# Phase 4 — Smart Contracts

Goal

Introduce deterministic programmable state.

Deliverables

- Contract deployment
- Storage
- Execution
- Events
- Contract SDK

Milestone

Deploy a marketplace contract and execute trades.

---

# Phase 5 — Application Registry

Goal

Create decentralized application discovery.

Deliverables

- Registry contract
- Metadata schema
- Version management
- Package signatures

Milestone

Users install applications directly from the registry.

---

# Phase 6 — Pear Runtime Integration

Goal

Connect applications to the blockchain.

Deliverables

- Wallet integration
- Blockchain SDK
- Event subscriptions
- Transaction helpers

Milestone

Applications initiate payments without external infrastructure.

---

# Phase 7 — Pythonic DSL

Goal

Simplify smart contract development.

Deliverables

- Parser
- AST
- Type checker
- Verifier
- Code generator

Milestone

Compile a Python-like contract into deployable WASM.

---

# Phase 8 — Example Applications

Goal

Validate the architecture.

Applications

- Chess
- Marketplace
- Reddit
- AI Assistant
- Wiki

Each demonstrates different uses of:

- Hypercore
- Smart contracts
- Payments

---

# Phase 9 — Economic Primitives

Goal

Expand reusable protocol contracts.

Implement

- Escrow
- Marketplace
- Auction
- DAO
- Subscription
- Royalties
- Licensing
- Identity

Applications begin composing primitives rather than implementing economics themselves.

---

# Phase 10 — Platform Ecosystem

Goal

Turn the protocol into a complete developer platform.

Deliverables

- Explorer
- Package manager
- SDKs
- Testing framework
- Deployment CLI
- Documentation
- Developer portal

The platform becomes self-sustaining.

---

# 28. First Technical Milestone

The first complete vertical slice should demonstrate every architectural layer.

A user should be able to:

```txt
1.

Launch a Pear application.

↓

2.

Automatically authenticate with wallet.

↓

3.

Join a peer-to-peer Hypercore feed.

↓

4.

Synchronize shared application state.

↓

5.

Execute an on-chain payment.

↓

6.

Receive finalized confirmation.

↓

7.

Continue using the application.
```

This proves that:

- networking
- applications
- wallets
- settlement
- contracts

operate as one coherent system.

---

# 29. Long-Term Vision

The objective is not merely another blockchain.

The objective is a decentralized operating system for peer-to-peer software.

Developers should think:

> "I'm building an application."

—not—

> "I'm building a blockchain."

Applications should naturally inherit:

- identity
- payments
- ownership
- contracts
- governance

without sacrificing the flexibility of traditional software.

---

# 30. Design Principles

The project should always preserve these principles.

---

## Applications First

Applications are the primary product.

The blockchain exists to support them.

---

## Minimal Consensus

Consensus should remain as small as possible.

Only globally trusted economic state belongs on-chain.

---

## Modular Architecture

Networking, applications, consensus, and contracts should evolve independently.

No subsystem should unnecessarily depend on another.

---

## Developer Experience

The easiest way to build a decentralized application should also be the correct way.

Complexity belongs inside the platform—not inside applications.

---

## Native Economics

Payments should be as easy as sending a function call.

Developers should never need to integrate external payment processors.

---

## Deterministic Trust

The blockchain should never attempt to become a distributed application runtime.

It should remain a deterministic engine for trust, ownership, and settlement.

---

## Composable Ecosystem

Every protocol primitive should be reusable.

Applications should compose identity, escrow, marketplaces, governance, subscriptions, and payments into richer systems rather than rebuilding them independently.

---

# Final Architecture

```txt
                          User
                            │
                     Pear Application
                            │
        ┌───────────────────┴───────────────────┐
        │                                       │
        │                                       │
   Hypercore APIs                        Blockchain APIs
        │                                       │
        │                                       │
 HyperDHT / Hyperswarm                Wallet / Contracts
        │                                       │
        └───────────────────┬───────────────────┘
                            │
                    Settlement Chain
                            │
                       Consensus Layer
                            │
                  Deterministic Global State
```

The resulting platform combines the strengths of peer-to-peer networking with the guarantees of blockchain consensus.

Holepunch provides communication, replication, storage, and application distribution.

The settlement chain provides identity, ownership, payments, and deterministic execution.

Smart contracts provide programmable economic logic.

Pear applications provide the user experience.

Each layer remains simple because each layer has exactly one responsibility.

Together they form a decentralized application platform where software behaves like traditional applications, while trust, ownership, and value exchange become native capabilities of the network itself.
