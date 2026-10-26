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
GET  /api/block/<height>             settlement block and encoded transactions
GET  /api/account/<z32>              balance + nonce
GET  /api/tx/<hash>                  tx status (404 until it lands)
GET  /api/apps[?after=<id>&limit=50]  registered apps, exclusive cursor, max 100
GET  /api/app/<id>                   registration and latest settlement anchor
GET  /api/app/<id>/chain/head         app-chain head
GET  /api/app/<id>/chain/block/<height>   app-chain block
GET  /api/app/<id>/chain/tx/<hash>     app-chain transaction receipt
GET  /api/app?appId=<id>             registration and anchor query alias
GET  /api/app/chain/{head,block/<height>,tx/<hash>}?appId=<id>   chain query aliases
POST /api/tx {"tx": "<hex>"}         submit a signed, encoded transaction
GET  /api/contract/<id>/state[?prefix=<hex>]   contract storage entries
/*                                   staticDir (SPA fallback)
```

Use the query aliases for the valid IDs `.` and `..`, which URL parsers remove
from path segments even when percent-encoded. Aliases accept any registered ID,
require exactly one `appId` parameter, and reject other parameters and malformed
encoding. Existing path-based app URLs keep their meaning; encode their IDs once
with `encodeURIComponent`.

Without `staticDir`, `/` serves a compact Mordecai homepage with the tagline
“P2P toolkit for a distributed world” and live node details from `/api/head`.
The readout checks every second, times out after five seconds, and clears
stale values if the node is unavailable.

`/docs/` serves the bundled mdBook, including the six-part field guide at
`/docs/field-guide.html`. The old `/guide`, `/guide/`, and `/guide.html` URLs
redirect to that chapter. The book provides navigation, search, and code copying;
its instructions remain readable without JavaScript.

Install mdBook 0.5.2 on the build machine. `pnpm build` compiles the packages,
bundles the browser wallet, and writes the book to `packages/gateway/public/docs/`, which is included in
this package's `public` assets. `pnpm build:docs` rebuilds only the book.
Running a built node needs no mdBook installation or separate book server.

`--static <dir>` replaces the homepage and documentation with your own
frontend, including SPA fallback. `/wallet.html`, `/wallet` (redirect), and the
exact `/wallet-assets/` files remain reserved for the built-in web wallet.
Unknown paths on the built-in site return 404.

The built-in site is a single-page app: `/#/` shows Home, `/#/account` shows
Account, `/#/explorer` opens Explorer and `/#/apps` opens the app directory.
Legacy `/#/wallet` and `/#/faucet` links open Account. **Demos** opens the
operator-enabled demos. The top bar also links to documentation, the chain API
and GitHub. Hash navigation and browser back/forward preserve the loaded account.
Account initially shows create/load controls; loading it reveals account details
and transaction forms. Closing the account clears drafts and returns to create/load.
The standalone `/wallet.html` page remains available for custom app frontends
such as Hex.

## Explorer and registered apps

Explorer is read-only and needs no account. `/#/explorer` browses ten recent
**Settlement (L0)** blocks at a time. Choose an explicit block-height or
transaction-hash lookup; direct links use `/#/explorer?height=42` or
`/#/explorer?tx=<64-hex-hash>`. App-chain links add `app=<URL-encoded-id>`,
for example `/#/explorer?app=hex&height=42`. Only the visible latest-block view
polls, every five seconds. Detail pages and app-directory pages do not poll.

`/#/apps` pages through registrations (50 by default, up to 100), and
`/#/apps?app=<URL-encoded-id>` shows one registration, its last settlement
anchor and a separate live app head when available. Configured demo names such
as Hex and Outpost appear only when `config.demos[name].appId` matches the
registered ID; other IDs appear unchanged. Explorer displays integer **CAI base
units** for settlement and **app-chain base units** for app chains.

Registration and settlement anchors remain visible when an app has no chain or
its peers are offline. Historical blocks and transaction bodies depend on data
held by reachable peers; this gateway provides no permanent archive or indexer.
A transaction 404 means not found or unavailable, without implying pending or
failed execution. Receipts can remain readable when their containing block is
unavailable. The latest-anchor record has no settlement transaction hash, so
there is no direct anchor-transaction link from that record; older anchors can
still be inspected through settlement blocks and transactions.

App reads use operator-mounted networks or registered validator keys, verify the
reported chain ID, and never accept arbitrary network URLs from the browser.
These are node-reported results, not independent consensus verification; an
accepted settlement anchor attests the app quorum's claim. New explorer API
errors return JSON `{code, error}`; invalid input is 400, missing data is 404,
an app without a chain is 409, and unavailable or busy peers are 503.

The web wallet generates and loads keys entirely in the browser, shows this
gateway's balance, and pre-fills the faucet address. Keys stay in memory; its
downloadable JSON backup is unencrypted and intended for test tokens. It accepts
raw Ed25519 seeds, validated libsodium private keys, and its own JSON backups,
not the CLI's encrypted keystore. The same backup can be loaded by the Hex demo.
See the book's **Web Wallet, Faucet, and Hex** walkthrough.

The Wallet view sends simple CAI transfers and signs unsigned hexadecimal payloads
encoded by `encodePayload` from `@mordecai/protocol`. Both flows require a loaded
wallet and show a decoded review before broadcasting. The signer uses that
wallet's key and the current network/nonce; keys never leave the browser.
Transfers use whole base units and a maximum fee of 1,000 units. The general
transaction form accepts a fee ceiling and all protocol payload types, including
contract deployment/calls and app registry/anchor transactions. Both flows
recheck the network, nonce, balance, and any attached value before sending.

Receipts and the last ten submissions appear for this tab's session. An uncertain
submission blocks new sends; retry broadcasts identical signed bytes. Keep the
tab open until the result is known: pending state and history are not persisted.
A receipt reports confirmation or execution failure; a used nonce without a
receipt is explicitly reported as unknown. Transaction API failures distinguish
definite admission rejection (`400`, `rejected: true`) from an uncertain RPC
result (`503`). Older nodes without the rejection flag remain uncertain.

Run from code (`Gateway.start({...})`) or the CLI:

```sh
mordecai-gateway --node <rpc-key-hex> [--port 8787] [--static <dir>] \
             [--config <file.json>] [--bootstrap host:port,…]
```

See `scripts/frontier-demo.mjs` for the full devnet + contract + gateway
wiring, and `apps/frontier-web` for a client.

## Test CAI faucet

The built-in Faucet tab includes a faucet form, available without loading a wallet. It is disabled until the operator
supplies a dedicated funded wallet. Visitors provide only a public wallet address.
Each claim transfers **10,000 base units** from that wallet; this does not mint CAI.
The faucet pays the transaction fee as well. The form shows a transaction link
and reports confirmation only after a successful receipt.

Create a separate wallet (the CLI prompts for a passphrase):

```sh
node packages/wallet/dist/cli.js create --keystore ./faucet-wallet.json
```

Fund its printed address through an ordinary transfer on the intended network.
For a **new** test network, you can instead allocate funds at genesis:

```sh
node bin/mordecai.mjs l1 init --dir ./test-node --chain-id my-testnet \
  --alloc '<faucet-address>=1000000000'
```

Set `MORDECAI_FAUCET_PASSPHRASE` in the process environment to the wallet's
passphrase, then start the node:

```sh
node bin/mordecai.mjs l1 start --dir ./test-node --port 8787 \
  --faucet-keystore ./faucet-wallet.json
```

The standalone gateway accepts the same option:

```sh
node packages/gateway/dist/cli.js --node '<rpc-key-hex>' --port 8787 \
  --faucet-keystore ./faucet-wallet.json
```

From code, pass `faucet: wallet` to `Gateway.start`, or `gateway: { faucet: wallet }`
to `Node.start`. Keep keys out of `config`: that object is publicly served.
Never reuse a validator wallet or another actively spending wallet for the faucet.

```
GET  /api/faucet                 {enabled, address?, amount?, cooldownSeconds?}
POST /api/faucet {"address":"…"}  202 {hash, amount, status:"submitted"}
```

Requests have a 512-byte body limit. Invalid addresses return 400; disabled,
unfunded, busy, or unavailable faucets return 503. A cooldown or exhausted hourly
budget returns 429 with `Retry-After` in seconds. Amounts are fixed by the server.

MVP limits are one claim per recipient and socket IP per minute, and 100 claims
per rolling hour per gateway. Only one unconfirmed transfer is allowed at once.
After an uncertain submission the service retains and resubmits the exact signed
bytes instead of signing a different transfer with the same nonce. Check the
receipt before requesting again if the connection fails.

Limits and pending state are in memory and reset on restart. Run only one faucet
gateway per wallet. Forwarded IP headers are ignored, so a reverse proxy makes
visitors share its one-minute IP cooldown; configure shared durable limits and
trusted proxy handling before a larger public deployment. Fund this MVP wallet
only with tokens intended for giveaway.

`node apps/devnet/devnet.mjs` enables the funded faucet on node 0 and prints its
homepage URL. The local devnet and its balances are temporary.

## Integrated demos

`pnpm build` includes the isolated Hex browser bundle. `node scripts/node-demo.mjs`
starts the built-in SPA and all four demos on the same persistent settlement network.
Frontier and Outpost each use one shared world; Hex and Chess use invitation rooms.
Chess relays wallet-signed moves through this gateway and settles wagers only after
both players report matching results. Closing Wallet revokes all demo signers. See the
book's Web Wallet, Faucet, and Hex guide for startup and room invitations.

From code, `GatewayOptions.networks` mounts named RPC connections at
`/api/demos/<name>/api/*`. Each entry has its own `nodeKey`, optional `bootstrap`,
`faucet`, and `faucetAmount`. These are server-side options; browser configuration
contains only public contract addresses, chain IDs and same-origin API paths.
`faucetAmount` changes the fixed grant for that faucet; defaults remain 10,000.
The node demo uses 10,000,000 L1 units and 1,000,000,000 app fee units per claim.
