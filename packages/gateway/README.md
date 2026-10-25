# @mordecai/gateway — browser-facing HTTP edge

Browsers can't join HyperDHT, so this package bridges them in: a small
HTTP server that translates JSON requests into hyperswarm RPC calls
against any chain node, and serves a static frontend bundle. Any node
operator can run one; gateways are interchangeable and untrusted —
transactions arrive signed, state is decoded client-side, so a gateway
can refuse service but cannot forge or tamper.

```
GET  /api/config                     operator-provided app config
GET  /api/head                       chain head
GET  /api/account/<z32>              balance + nonce
GET  /api/tx/<hash>                  tx status (404 until it lands)
POST /api/tx {"tx": "<hex>"}         submit a signed, encoded transaction
GET  /api/contract/<id>/state[?prefix=<hex>]   contract storage entries
/*                                   staticDir (SPA fallback)
```

Without `staticDir`, `/` serves a compact Mordecai homepage with the tagline
“P2P toolkit for a distributed world” and live node details from `/api/head`.
The readout checks every ten seconds, times out after five seconds, and clears
stale values if the node is unavailable.

`/docs/` serves the bundled mdBook, including the six-part field guide at
`/docs/field-guide.html`. The old `/guide`, `/guide/`, and `/guide.html` URLs
redirect to that chapter. The book provides navigation, search, and code copying;
its instructions remain readable without JavaScript.

Install mdBook 0.5.2 on the build machine. `pnpm build` compiles the packages
and writes the book to `packages/gateway/public/docs/`, which is included in
this package's `public` assets. `pnpm build:docs` rebuilds only the book.
Running a built node needs no mdBook installation or separate book server.

`--static <dir>` replaces the homepage and documentation with your own
frontend, including SPA fallback. Unknown paths on the built-in site return 404.

Run from code (`Gateway.start({...})`) or the CLI:

```sh
mordecai-gateway --node <rpc-key-hex> [--port 8787] [--static <dir>] \
             [--config <file.json>] [--bootstrap host:port,…]
```

See `scripts/frontier-demo.mjs` for the full devnet + contract + gateway
wiring, and `apps/frontier-web` for a client.
