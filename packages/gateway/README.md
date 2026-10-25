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

Without `staticDir`, `/` serves the built-in Mordecai landing page: locally
bundled guardian artwork and a live chain readout from `/api/head`. No frontend
build or external asset service is required. The readout checks every ten seconds,
times out after five seconds, and clears stale values if the node is unavailable.
`--static <dir>` replaces the page with your own frontend, including SPA fallback.
Unknown paths on the built-in page return 404.

The bundled `/guide` field guide covers building the CLI, joining L1, creating
a wallet, starting and joining app networks, and signing/submitting payments.
It includes a complete app starter and copy buttons with a native selection
fallback for HTTP peers without clipboard access. All instructions remain
readable without JavaScript. Custom frontends take precedence over this route too.

Run from code (`Gateway.start({...})`) or the CLI:

```sh
mordecai-gateway --node <rpc-key-hex> [--port 8787] [--static <dir>] \
             [--config <file.json>] [--bootstrap host:port,…]
```

See `scripts/frontier-demo.mjs` for the full devnet + contract + gateway
wiring, and `apps/frontier-web` for a client.

## Landing artwork

`public/guardian.jpg` was generated with the built-in image-generation tool,
using the gold armour, ivory robes, and stone arches of the
[visual reference](https://pt.pinterest.com/pin/1008876754062576636/) as inspiration.
The generated PNG was converted to JPEG for delivery. Generation prompt:

> Use case: stylized-concept. Asset type: original website hero artwork for Mordecai, a layer-one blockchain. Create a tall portrait 1024x1536 painterly oil illustration of a mysterious crowned guardian in intricately engraved antique gold armor and heavy ivory robes standing beneath a monumental Romanesque stone arch. Face entirely concealed behind a beautiful closed gold helmet. Hands rest on the hilt of a long ceremonial sword pointed down. Strong symmetrical architectural composition, guardian seen from knees upward, crown fully visible, broad arch framing the silhouette. Dramatic warm sunlight brushes the gold and fabric from upper left, deep near-black umber shadows behind. Restrained gilded medieval manuscript meets fine-art fantasy book cover; tangible brushwork and aged gold texture, quiet and dignified rather than aggressive. Palette: antique gold, warm ivory, charcoal, muted brown. Dark edges blend into a charcoal webpage. Fill the frame with the guardian and arch; no wide empty margins. No text, lettering, logos, watermark, UI, modern objects, blue glow, or extra people. Make an original composition, not a reproduction.
