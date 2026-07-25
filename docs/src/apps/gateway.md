# The Web Gateway

Browsers can't join HyperDHT — no UDP, no holepunching — so nothing in
the network is reachable from a web page by itself. The gateway
(`@mordecai/gateway`) is the browser-facing edge: a small HTTP server any
node operator can run that translates JSON into hyperswarm RPC and
serves a static frontend bundle.

```
GET  /api/config                     operator-provided app config
GET  /api/head                       chain head
GET  /api/account/<z32>              balance + nonce
GET  /api/tx/<hash>                  tx status (404 until it lands)
POST /api/tx {"tx": "<hex>"}         submit a signed, encoded transaction
GET  /api/app/<appId>                registry entry + latest anchor
GET  /api/contract/<id>/state[?prefix=<hex>]   contract storage entries
/*                                   static frontend (SPA fallback)
```

Run one from code (`Gateway.start({...})`) or the CLI:

```sh
mordecai-gateway --node <rpc-key-hex> [--port 8787] [--static <dir>] \
             [--config <file.json>] [--bootstrap host:port,…]
```

## Why gateways are safe to not trust

Transactions arrive **already signed** — the browser holds the key and
signs with `@noble/curves` over the same canonical bytes sodium signs in
the wallet daemon (`transactionSigningBytes`). State is decoded
client-side from raw storage entries. A gateway can refuse service; it
cannot forge, tamper, or spend. Gateways are therefore interchangeable:
any of N independent operators can serve any app, and the escape hatch
from the web tier is always the real thing — install the app over the
swarm.

Because an app chain's node speaks the same RPC, a second gateway
pointed at an app-chain node gives a browser the same JSON surface for
game state — that's how the outpost example serves a two-chain UI from
plain `fetch()` (see [Outpost](../examples/outpost.md)).

Working example: `scripts/frontier-demo.mjs` + `apps/frontier-web` —
the frontier land game played entirely from a browser, with in-browser
signing and no backend beyond the gateway.
