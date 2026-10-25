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
GET  /api/account/<z32>              balance + nonce
GET  /api/tx/<hash>                  tx status (404 until it lands)
POST /api/tx {"tx": "<hex>"}         submit a signed, encoded transaction
GET  /api/app/<appId>                registry entry + latest anchor
GET  /api/contract/<id>/state[?prefix=<hex>]   contract storage entries
/*                                   static frontend (SPA fallback)
```

Every `Node.start(...)` and `AppChain.join(...)` starts this gateway
automatically, for validators and ordinary peers alike. The connect CLIs
print its HTTP URL; library callers use `node.gateway.port` (or
`app.node.gateway.port`). Supply `gateway: { port, staticDir, config }` to
customize it. Without a port, the library chooses an available one.

Without a custom `staticDir` (CLI: `--static`), the gateway serves a built-in
Mordecai landing page at `/`. Its artwork and assets are bundled locally, and
the page polls `/api/head` for the chain ID, height, and latest block hash.
If chain data cannot be fetched, the readout shows the node as unavailable
and retries automatically. Custom frontends continue to use SPA fallback;
unknown paths on the default page return 404.

The landing page links to `/guide`, a bundled CLI field guide with copyable
examples for joining the network, creating a wallet, starting an app network,
joining an app, and signing and submitting a payment. It also works without
JavaScript; a custom `staticDir` replaces both built-in pages.

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
