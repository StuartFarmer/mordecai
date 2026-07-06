# Three Kinds of State

Every piece of data in an HSSN application belongs to exactly one of three
categories (spec §3). Getting this classification right is the most
important design decision an app developer makes.

## Ephemeral state

Exists only while the app runs: mouse positions, voice chat, live cursors,
network sessions, temporary AI context. Never stored, never replicated,
never on-chain. Plain in-memory application code.

## Shared state

Persistent application data that should replicate between peers but needs
no universal agreement: chat history, documents, game moves and replays,
images, community content.

Shared state lives in **Hypercore feeds**:

- **Append-only** — history can't be rewritten.
- **Signed** — every entry is authenticated by the feed owner's key; a peer
  relaying your chess moves cannot forge them.
- **Replicated on demand** — peers holding a feed serve it to peers who
  want it, directly over encrypted connections.

Shared state is _authentic but not authoritative_: you can prove who wrote
what and in what order, but nothing forces every node in the world to store
or agree on it. That's exactly right for application data.

## Economic state

Information every participant must agree on forever: wallet balances,
contract storage, token ownership, escrow, the application registry.

Economic state lives **on-chain**, in a key-value store committed to by a
Merkle root in every block header:

| Prefix                    | Contents                                                 |
| ------------------------- | -------------------------------------------------------- |
| `a:` + pubkey             | account `{balance, nonce}`                               |
| `cc:` + contract id       | deployed WASM code                                       |
| `cs:` + contract id + key | per-contract isolated storage                            |
| `app:` + app id           | registry entries (owner, pear key, version, bundle hash) |

It changes only through signed transactions, executed identically by every
validator, finalized by BFT quorum. It is intentionally small — consensus
is the expensive tier.

## Worked examples (spec §15)

| App         | Off-chain (feeds)                            | On-chain                                       |
| ----------- | -------------------------------------------- | ---------------------------------------------- |
| Chess       | board state, moves, clocks, chat, spectators | tournament entry, **wagers, escrow, payout**   |
| Reddit      | posts, comments, votes, mod logs             | community ownership, mod permissions, treasury |
| Marketplace | product images, search, reviews              | listings, ownership, escrow, settlement        |
| AI service  | prompts, inference, conversation             | micropayments, subscriptions, usage accounting |

The pattern: **scarce things on-chain, everything else off.** Currency,
ownership, escrow, identity, governance — on-chain. Content, computation,
communication — off.
