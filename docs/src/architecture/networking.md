# Networking: Holepunch

The entire networking layer is the [Holepunch](https://holepunch.to) stack —
chosen because it is the most mature peer-to-peer toolkit in the JS
ecosystem, and because the settlement chain itself can dogfood it.

## The pieces

- **HyperDHT** — a distributed hash table for peer discovery. Peers are
  addressed by public key, never IP; the DHT also performs NAT hole-punching
  so two home machines connect directly.
- **Hyperswarm** — encrypted connection management over the DHT. Peers join
  32-byte _topics_; the swarm finds other members and maintains direct
  Noise-encrypted sockets to them.
- **Hypercore** — the append-only, signed, replicated log described in
  [Three Kinds of State](state.md).
- **Corestore** — manages many Hypercores in one storage directory and
  multiplexes them all over each swarm connection.

## The `@hssn/networking` wrapper

Applications use two classes:

```ts
const net = Network.create({ storageDir, bootstrap? });

const feed = await net.createFeed('chat');    // locally writable, named
await feed.append('hello');
await net.joinFeed(feed);                     // announce on the DHT

const remote = await net.openFeed(key);       // read-only, filled by peers
const first  = await remote.get(0);           // requests the block, waits
```

Every swarm connection replicates the whole Corestore: once two peers are
connected for _any_ feed, every feed they both have open syncs over that
same socket. This is why a chess opponent's reply feed needs no extra
handshake — opening it by key is enough.

**Practical rule:** to _wait_ for new data, prefer `feed.get(index)` (which
actively requests the block from connected peers and resolves when it
arrives) over polling `feed.update()` (which passively waits for
announcements and can stall).

## The chain runs on the same stack

The settlement chain has no separate TCP infrastructure:

- Validators discover each other on a swarm topic derived from the **genesis
  hash** and gossip transactions, proposals, and votes over those
  connections (`@hssn/consensus`).
- Client RPC is **`@hyperswarm/rpc`**: applications dial a node by its
  public key over the DHT — no server URLs, works across NATs.
- Lagging nodes catch up via `block_request`/`block_response` messages on
  the same mesh, verifying each block's quorum certificate independently.

## What networking does _not_ guarantee

Peer discovery, encrypted transport, content authenticity, and efficient
replication — yes. Economic correctness, ownership, identity, or global
truth — never. A feed proves _who said what_; only the chain proves _who
owns what_. (Spec §6, "Networking Guarantees".)
