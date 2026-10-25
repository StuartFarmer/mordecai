# The Two Planes

Most blockchains try to be the application platform. Mordecai deliberately does
not. It splits the world into an **application plane** (fast, free,
peer-to-peer, scaled by the users themselves) and a **settlement plane**
(small, deterministic, globally agreed).

```text
                          User
                            │
                     Pear Application
                            │
        ┌───────────────────┴───────────────────┐
        │                                       │
   Hypercore APIs                        Blockchain APIs
        │                                       │
 HyperDHT / Hyperswarm                Wallet / Contracts
        │                                       │
        └───────────────────┬───────────────────┘
                            │
                    Settlement Chain
                            │
                       Consensus (BFT)
                            │
                  Deterministic Global State
```

## Layer map

| Layer (spec §25)     | What it does                      | Package(s)                                                         |
| -------------------- | --------------------------------- | ------------------------------------------------------------------ |
| L5 Applications      | UI, game logic, media, simulation | `apps/*`                                                           |
| L4 SDKs              | wallet, payments, feeds, install  | `@mordecai/sdk`, `@mordecai/wallet`, `@mordecai/pear-integration`  |
| L3 Smart contracts   | escrow, ownership, marketplaces   | `@mordecai/vm`, `contracts/*`, `compiler/`                         |
| L2 Settlement chain  | accounts, blocks, consensus, RPC  | `@mordecai/protocol`, `state`, `chain`, `consensus`, `node`, `rpc` |
| L1 Holepunch network | discovery, transport, replication | `@mordecai/networking`                                             |
| L0 Cryptography      | Ed25519, BLAKE2b, keystores       | `@mordecai/crypto`                                                 |

Each layer depends only on the ones beneath it. Applications never touch
consensus; consensus never executes application logic.

## The core rule

> Can every node deterministically reach the same conclusion?

If yes, the logic _may_ belong on-chain (and only if it also needs global
trust). If no — anything involving wall-clock time, network calls,
randomness, media, or user interaction — it belongs in the application
plane. This single question resolves nearly every design decision; the
worked examples are in [Three Kinds of State](state.md) and
[What a P2P App Is (and Isn't)](../apps/what-is-a-p2p-app.md).

## Division of labor at runtime

Connecting a native node starts all services for the selected network:
state verification and replication, chain storage and serving, feed seeding,
RPC, and an HTTP gateway. App connections automatically seed the registered
bundle; apps select additional data feeds by key.

- **Validators** do all of that and participate in consensus. Their keys
  are listed in the network's fixed validator set.
- **Peers** do all of that without proposing or voting. Their keys are
  not in the validator set. There is no separate seeder or gateway role
  to choose when connecting.

A node serves either the settlement chain or one application's chain.
An app-chain connection discovers configuration through a peer URL or an
app ID resolved by settlement RPC; direct discovery requires no settlement.
Neither path downloads settlement history. Browser-only clients still use a
running node's HTTP gateway because browsers cannot join the native DHT.
