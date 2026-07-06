# Holepunch Smart Settlement Network

## Part 2 — Settlement Layer, Smart Contracts, and Application Model

---

# 7. Settlement Layer

The settlement layer is responsible for maintaining globally trusted economic state.

Unlike traditional blockchains, it is **not** intended to execute entire decentralized applications.

Instead, it acts as a deterministic trust engine shared by every application on the network.

Its responsibilities are intentionally limited.

```txt
Wallets

↓

Transactions

↓

Consensus

↓

Smart Contracts

↓

Global Economic State
```

Everything else belongs to the application layer.

---

## Core Responsibilities

The settlement layer maintains:

* Native currency
* Wallet balances
* Identity
* Smart contract execution
* Ownership
* Escrow
* Marketplace settlement
* Governance
* Global application registry

Nothing more.

---

## Core Rule

The settlement layer should answer one question:

> **Can every node deterministically reach the same conclusion?**

If not, the logic does not belong on-chain.

---

# 8. Consensus

Consensus exists to establish a single ordering of economic events.

Every validator independently executes the same transactions in the same order.

```txt
Transaction

↓

Mempool

↓

Consensus

↓

Block

↓

Contract Execution

↓

State Root
```

The chain produces:

* deterministic execution
* immediate finality
* identical global state

Consensus never executes networking logic.

Consensus never executes application rendering.

Consensus never manages distributed storage.

---

## Validator Responsibilities

Validators:

* Verify signatures
* Validate transactions
* Execute contracts
* Produce blocks
* Replicate state
* Commit state roots

Validators do **not**:

* Host applications
* Store media
* Run AI models
* Moderate communities
* Stream files

---

# 9. Wallets and Identity

Every participant possesses a cryptographic identity.

```txt
Private Key

↓

Public Key

↓

Wallet Address

↓

Identity
```

The wallet becomes the universal identity across every Pear application.

Applications never implement separate authentication systems unless they choose to add human-friendly aliases.

---

## Wallet Responsibilities

Wallets manage:

* Signing
* Balances
* Permissions
* Assets
* Contract interaction

Wallets should integrate directly into the Pear runtime.

Every application automatically gains access to:

* authentication
* payments
* ownership
* signatures

without additional infrastructure.

---

# 10. Transaction Model

Every state transition occurs through transactions.

Examples:

```txt
Transfer

Deploy Contract

Execute Contract

Register Application

Update Registry

Create Marketplace Order

Vote

Stake
```

Each transaction is:

* signed
* deterministic
* ordered
* permanently recorded

---

## Transaction Lifecycle

```txt
Application

↓

Wallet signs

↓

Peer broadcasts

↓

Validators receive

↓

Consensus orders

↓

Contracts execute

↓

State commits

↓

Applications observe result
```

Applications never directly modify global state.

They submit requests.

The blockchain determines whether those requests are valid.

---

# 11. Smart Contract Model

Smart contracts are deterministic economic programs.

They are **not** distributed applications.

They execute only when transactions invoke them.

A contract resembles a pure function operating on global state.

```txt
Transaction

↓

Load Contract

↓

Execute

↓

Validate

↓

Update Storage

↓

Emit Events
```

The contract immediately exits.

It does not remain running.

---

## Responsibilities

Smart contracts define:

* Ownership rules
* Payment logic
* Marketplace settlement
* Escrow
* Governance
* Permissions
* Protocol rules

They do **not** define:

* Rendering
* Networking
* User interfaces
* Multiplayer
* AI
* Media
* Storage replication

---

# 12. Contract Storage

Each contract owns an isolated storage namespace.

```txt
contract_A/

balances

orders

escrow
```

```txt
contract_B/

users

inventory

permissions
```

Contracts cannot directly mutate each other's storage.

The only interaction mechanism is message passing.

---

## Contract Communication

Instead of:

```txt
contract_B.balance = 100
```

Contracts communicate through messages.

```txt
Execute(
    contract_B,
    "transfer",
    ...
)
```

Contract B independently decides whether to accept or reject the request.

This preserves deterministic isolation.

---

# 13. Application Model

Applications are distributed software running on Pear.

Applications are **not** smart contracts.

They consume blockchain services.

```txt
Application

↓

Hypercore

↓

Blockchain

↓

Wallet
```

Applications may continue functioning even if they never submit transactions.

---

## Application Responsibilities

Applications provide:

* Interface
* Multiplayer
* Synchronization
* Local simulation
* AI
* Media
* User experience

Applications request blockchain services only when economic state changes.

---

# 14. Application State

Applications maintain three independent kinds of state.

---

## Local State

Exists only on the local device.

Examples:

* Window layout
* UI settings
* Cached assets
* Temporary computation

Never replicated.

---

## Shared State

Replicated through Hypercore.

Examples:

* Chat
* Documents
* Multiplayer events
* Replays
* Images
* Community content

Replicated peer-to-peer.

No consensus required.

---

## Economic State

Stored exclusively on-chain.

Examples:

* Currency
* Ownership
* Assets
* Marketplace orders
* Escrow
* Identity

Consensus required.

---

# 15. On-chain vs Off-chain

The most important design decision for every application is determining where data belongs.

---

## Example: Chess

### Off-chain

* Board state
* Moves
* Replay
* Chat
* Clock
* Spectators
* Match synchronization

Hypercore handles all replication.

---

### On-chain

* Tournament registration
* Wagers
* Escrow
* Prize pool
* Final payout
* Reputation with financial consequences

The chess game itself never executes on-chain.

---

## Example: Reddit

Off-chain

* Posts
* Comments
* Images
* Votes
* Moderation logs

On-chain

* Community ownership
* Moderator permissions
* Treasury
* Premium memberships
* Creator payments

---

## Example: Marketplace

Off-chain

* Product images
* Search indexes
* Reviews
* Product metadata

On-chain

* Listings
* Ownership
* Escrow
* Settlement
* Royalties

---

## Example: AI Service

Off-chain

* Prompt execution
* Model inference
* Context
* Conversation history

On-chain

* Micropayments
* Subscription state
* Usage accounting
* Reputation

---

# 16. Native Payments

Every Pear application automatically has access to digital payments.

Instead of integrating:

```txt
Stripe

PayPal

Apple Pay

Steam Wallet
```

Applications simply invoke blockchain transactions.

```txt
Pay Provider

↓

Wallet

↓

Settlement

↓

Receipt
```

Payments become protocol primitives rather than third-party integrations.

---

# 17. Application Registry

The blockchain maintains a global registry of applications.

Applications become discoverable without centralized stores.

Each registry entry contains:

```txt
Application ID

Pear Key

Developer

Version

Contract Address

Permissions

Metadata
```

Installing an application becomes deterministic.

```txt
Search Registry

↓

Retrieve Metadata

↓

Verify Signature

↓

Download Pear Bundle

↓

Launch
```

---

# 18. Service Providers

Applications may expose optional services.

Examples:

```txt
Search

AI

Indexing

Hosting

Compute

Matchmaking

Moderation
```

Applications decide which services require payment.

Settlement occurs through the blockchain.

Execution occurs off-chain.

---

# 19. Economic Building Blocks

Rather than writing application-specific contracts, reusable protocol primitives should exist.

Examples:

```txt
Currency

Identity

Escrow

Marketplace

Auction

Subscription

Licensing

DAO

Token

Royalty

Staking
```

Applications compose these primitives into richer experiences.

This avoids reinventing economic logic.

---

# 20. Design Boundary

The platform deliberately separates trust from execution.

```txt
                Pear Application
                      │
      ┌───────────────┴───────────────┐
      │                               │
      │                               │
Hypercore Services           Blockchain Services

Chat                         Wallet

Storage                      Identity

Media                        Ownership

Networking                   Payments

Simulation                   Smart Contracts

AI                           Governance

Synchronization              Settlement
```

This separation is the defining architectural principle of the platform.

Applications remain fast, scalable, and peer-to-peer.

The blockchain remains small, deterministic, and focused exclusively on globally trusted economic state.

---

# End of Part 2

The next part defines the developer experience, including the Pythonic smart contract language, repository architecture, protocol organization, security model, phased implementation roadmap, and the first technical milestones required to build the platform from the ground up.

