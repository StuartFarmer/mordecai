# Publishing & Installing Apps

App distribution needs no store and no CDN: bundles travel peer-to-peer,
and the **chain is the authority on what code is legitimate** (spec §17).

## The registry

An on-chain entry per application id:

| Field             | Meaning                                                   |
| ----------------- | --------------------------------------------------------- |
| `owner`           | the developer key that registered it (only it may update) |
| `pearKey`         | the Hypercore feed key holding the bundle                 |
| `version`         | display version                                           |
| `contractAddress` | the app's companion contract, or zeros                    |
| `metadataHash`    | BLAKE2b-256 of the bundle — the trust anchor              |

`register_app` creates an entry (first come, first served per app id);
`update_app` replaces version/key/hash and is rejected for anyone but the
owner. Both emit receipt events (`app:registered:<id>`).

## Publishing

```ts
const { pearKey, tx } = await app.publishApp({
  appId: 'com.example.chess',
  version: '1.0.0',
  bundle: bundleBytes,
});
```

This appends the bundle to a feed, announces it on the DHT, and registers
`(appId, feedKey, hash)` on-chain in one finalized transaction. Publishing
a new version = append/replace the bundle feed + `update_app` with the new
hash. Keep seeding the feed (your machine, a friendly peer, or any user who
installed it — replication is store-and-forward).

## Installing

```ts
const { entry, bundle } = await app.installApp('com.example.chess');
```

or from the command line:

```sh
hssn-launcher install com.example.chess \
  --node <rpc-key-hex> --out ./chess [--bootstrap host:port]
```

Both do the same three steps:

1. **Registry lookup** — ask any chain node for the entry.
2. **Swarm fetch** — open the bundle feed by key and download from whoever
   has it. The serving peer is completely untrusted.
3. **Verify** — recompute BLAKE2b-256 of the bundle and compare with the
   on-chain `metadataHash`. Mismatch → refuse to install.

The security property: a compromised mirror, a malicious peer, or even the
developer's own hijacked feed **cannot ship different code** than what the
registered developer key committed to on-chain. Updates re-verify — new
code runs only after a new hash is registered by the owner.

## What launching means (today vs. the Pear shell)

Today the launcher writes the verified bundle plus its registry metadata to
disk; running it under the real Pear desktop shell (`pear run`) — with the
wallet-approval UI wired to the daemon's `ApprovalPrompt` — is the
remaining product milestone (see [Roadmap](../roadmap.md)). Everything
underneath (verified install, sessions, remote signing) is built and
tested.
