# The Web Gateway

Browsers can't join HyperDHT — no UDP, no holepunching — so nothing in
the network is reachable from a web page by itself. The gateway
(`@mordecai/gateway`) is the browser-facing edge: a small HTTP server any
node operator can run that translates JSON into hyperswarm RPC and
serves a static frontend bundle.

```
GET  /api/connect                    public app-network connection document
GET  /api/config                     operator-provided app config
GET  /api/head                       chain head
GET  /api/block/<height>             block header + encoded transactions
GET  /api/apps[?after=<appId>&limit=<n>]   registered apps page
GET  /api/account/<z32>              balance + nonce
GET  /api/tx/<hash>                  tx status (404 until it lands)
POST /api/tx {"tx": "<hex>"}         submit a signed, encoded transaction
GET  /api/app/<appId>                registry entry + latest anchor
GET  /api/app/<appId>/chain/head     registered app-chain head
GET  /api/app/<appId>/chain/block/<height>  app-chain block
GET  /api/app/<appId>/chain/tx/<hash> app-chain receipt
GET  /api/contract/<id>/state[?prefix=<hex>]   contract storage entries
/*                                   static frontend (SPA fallback)
```

Every `Node.start(...)` and `AppChain.join(...)` starts this gateway
automatically, for validators and ordinary peers alike. The connect CLIs
print its HTTP URL; library callers use `node.gateway.port` (or
`app.node.gateway.port`). Supply `gateway: { port, staticDir, config }` to
customize it. Without a port, the library chooses an available one.

Without a custom `staticDir` (CLI: `--static`), the gateway serves a built-in
Mordecai landing page at `/`. Its assets are bundled locally, and
the page polls `/api/head` for the chain ID, height, and latest block hash.
If chain data cannot be fetched, the readout shows the node as unavailable
and retries automatically. Custom frontends continue to use SPA fallback;
unknown paths on the default page return 404.

The landing page links to the Markdown/MDX documentation at `/docs/`, including the
[Field Guide](../field-guide.mdx) for joining the network, creating a wallet,
starting an app network, joining an app, and signing and submitting a payment.
The old `/guide`, `/guide/`, and `/guide.html` URLs redirect to that chapter.
A custom `staticDir` replaces both the built-in homepage and documentation.

`node scripts/node-demo.mjs` starts the persistent demo site on port 8790.
Its Demos menu shares the in-memory wallet across Hex, Frontier, Outpost, Chess,
Microblog and Bounties. Games receive a revocable signing/transaction interface,
never the private key. Microblog posts are signed off-chain; tip attribution is
stored before the browser broadcasts a reviewed payment. Bounty rewards and
public responses live on the settlement chain. See the
[Microblog](../examples/microblog.md) and [Bounties](../examples/bounties.md) guides.

`pnpm build` builds the packages, existing React demos, Astro site, and documentation
search index in `packages/gateway/public/site/`. Running a built node needs no
separate Astro process. `pnpm build:docs` refreshes the site after content edits.
Missing documentation pages and assets return 404 instead of the homepage.
See [Site authoring](../reference/site.md) for interactive MDX examples.

A separate gateway is still available when you want an independent web edge.
Run one from code (`Gateway.start({...})`) or the CLI:

```sh
mordecai-gateway --node <rpc-key-hex> [--port 8787] [--static <dir>] \
             [--config <file.json>] [--bootstrap host:port,…]
```

## Direct peer discovery

App nodes publish `GET /api/connect` independently of `/api/config`.
The document contains version `1`, `appId`, the serving peer's `nodeKey`,
`genesisHash`, ordered `chainValidators`, `feedKeys`, optional DHT
`bootstrap` endpoints, and optional `settlement` metadata. Keys and hashes
are 32-byte hex strings. The application chain derives its genesis from
the app ID and validator set and checks it against `genesisHash`.

Only public connection fields are advertised. Frontend configuration,
operator files and wallet keys are not copied into the connection document.
Settlement-only gateways return 404 unless explicitly configured to
advertise an app connection.

`mordecai app connect --app <peer-url>` uses this endpoint without contacting
settlement. Fetches have a ten-second timeout and a 1 MiB response limit.
A reverse proxy can expose a gateway under a path prefix; direct connection
appends `/api/connect` to that prefix.

## Explorer reads

Settlement (L0) block reads return the existing `BlockInfo` JSON shape: header,
hash and canonical encoded transaction hex. Heights are unsigned decimal u64
values, from `0` to `18446744073709551615`. Receipt `index` identifies the
transaction within the block's `txs` array. Amounts and fees use integer CAI
base units on settlement and integer app-chain base units on app chains.

`/api/apps` returns `{ apps, nextAfter }` with 50 entries by default and a
maximum `limit` of 100. Supply the returned `nextAfter` as the exclusive
`after` cursor. Each page scans the full registry; pagination is intended for
small registries, and reads do not create an archive or indexer. Entries
reflect the current registry, so separate pages are not a frozen snapshot.
Use `encodeURIComponent` for app IDs and cursors, including IDs with Unicode
or slashes. For the valid IDs `.` and `..`, use `GET /api/app?appId=<id>` for
registration and anchor, and
`GET /api/app/chain/{head,block/<height>,tx/<hash>}?appId=<id>` for chain reads:
URL parsers remove dot-only path segments even when dots are percent-encoded.
These aliases also accept other registered IDs and require exactly one `appId`
parameter. Unknown query parameters, duplicate parameters and malformed
percent encoding are rejected on explorer routes. Path-based block and
app-chain reads take no query parameters. Block and registry reads have a
five-second RPC timeout and are
also available under enabled `/api/demos/<name>/api/` mounts.

Registered app-chain reads first look up the current registration with a
one-second timeout. An existing demo mount is reused when
`config.demos[name].appId` matches the registered ID. If the mount cannot
serve the data, the gateway tries the current registered `chainValidators`
using that mount's DHT bootstrap. Without a mount it uses the gateway's
bootstrap. This supports private-DHT demos without accepting a browser's
arbitrary peer key or URL. Each peer's head must identify `app:<appId>` before
its data is read. Discovery and peer reads share a five-second budget with
one second per attempt to read a head and item, after the registration lookup. This
is deadline-limited discovery; an unavailable result does not prove that no
other peer holds the data.

At most eight app-chain requests are in flight per gateway, including
registration lookup. These routes accept only GET and never submit app-chain
transactions. Registration and settlement-anchor details remain accessible
through the existing `/api/app/<appId>` response when app peers are offline.

New explorer routes return errors as `{ code, error }`:

| HTTP status | Code                   | Meaning                                                                                |
| ----------- | ---------------------- | -------------------------------------------------------------------------------------- |
| 400         | `INVALID_REQUEST`      | Invalid height, ID, cursor, hash or query                                              |
| 404         | `NOT_FOUND`            | Missing settlement block, unregistered app or unknown route                            |
| 404         | `DATA_UNAVAILABLE`     | Matching app peers answered but lacked the item                                        |
| 409         | `NO_APP_CHAIN`         | Registered app has no chain validators                                                 |
| 503         | `BUSY`                 | Eight app-chain reads are already in flight                                            |
| 503         | `UPSTREAM_UNAVAILABLE` | Registry, settlement node or app peers did not answer successfully within the deadline |

Existing API routes keep their established response shapes and behavior.

## Why gateways are safe to not trust

Transactions arrive **already signed** — the browser holds the key and
signs with `@noble/curves` over the same canonical bytes sodium signs in
the wallet daemon (`transactionSigningBytes`). State is decoded
client-side from raw storage entries. A gateway can refuse service; it
cannot forge, tamper, or spend. Gateways are therefore interchangeable:
any of N independent operators can serve any app, and the escape hatch
from the web tier is always the real thing — install the app over the
swarm.

An app-chain node's built-in gateway gives a browser the same JSON surface for
game state — that's how the outpost example serves a two-chain UI from
plain `fetch()` (see [Outpost](../examples/outpost.md)).

Working example: `scripts/frontier-demo.mjs` + `apps/frontier-web` —
the frontier land game played entirely from a browser, with in-browser
signing and no backend beyond the gateway.
