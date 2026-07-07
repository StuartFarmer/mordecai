# @hssn/gateway — browser-facing HTTP edge

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

Run from code (`Gateway.start({...})`) or the CLI:

```sh
hssn-gateway --node <rpc-key-hex> [--port 8787] [--static <dir>] \
             [--config <file.json>] [--bootstrap host:port,…]
```

See `scripts/frontier-demo.mjs` for the full devnet + contract + gateway
wiring, and `apps/frontier-web` for a client.
