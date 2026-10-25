# Frontier in the Browser

Frontier is the land-economy contract (claim tiles, build farms and
lumbermills, harvest by block height, trade wood↔wheat through an
escrowed on-chain order book) played from a plain web page — the proof
of the web tier: **open a URL, click a tile, own land**, with no wallet
extension and no backend beyond a [gateway](../apps/gateway.md).

## Shared node demo

Start the persistent node with `node scripts/hex-demo.mjs` after building the node
and demo bundles. Open **Wallet**, load or create a wallet, fund test CAI in
**Faucet**, then select **Demos → Frontier**. The game uses that wallet without
another key import. Closing or replacing the wallet revokes its signing facade.
Each action reserves up to 500,000 base units for fees; the Wallet tab records
transaction receipts and handles uncertain submission retries.

This is one persistent world of 144 tiles on `mordecai-demo`. Claim wilderness,
build a farm or lumbermill for 10 wood, and harvest resources. Growth follows
block height: waiting alone does not produce resources. Trade wood and wheat
through escrowed orders with a second wallet, or transfer a tile to a complete,
valid recipient wallet address. A full world remains full; players can trade or
transfer land rather than resetting other players' progress.

The shared deployment uses journaled `frontier-deploy` and `frontier-init` steps.
Restarting the node reuses its existing contract and world, alongside Hex and
existing balances. Public configuration contains only chain ID and contract
address. No player seed is passed to the embedded client or stored by it.

## Standalone development demo

```sh
pnpm build && pnpm --filter @mordecai/example-frontier-web build
node scripts/frontier-demo.mjs     # → http://127.0.0.1:8787
```

The demo starts a 3-validator devnet, deploys
`compiler/examples/frontier.pysc`, funds two dev accounts, and serves
`apps/frontier-web` from the gateway. Switch between alice and bob in
the UI to trade against yourself.

## How the standalone client works

- **Signing in the browser.** Keys derive from seeds in `/api/config`
  (devnet custody); `@noble/curves` signs the same canonical
  `transactionSigningBytes` the wallet daemon signs with sodium. The
  gateway never sees a key. ~65 KB gzipped, total.
- **State reads.** One `GET /api/contract/<id>/state` sweep returns raw
  storage entries; the client decodes the DSL layout (`s:<Map>:` keys,
  fields in declared order) into tiles, accounts, and orders — the same
  pattern any explorer or indexer would use.
- **Gateway reads.** Transactions are signed by the player; displayed state and
  receipts are read from the connected gateway. The browser does not independently
  verify consensus proofs.

The contract itself is walked through in [Land](land.md) (frontier is
land plus a second building kind and the escrowed market). The on-chain
behavior is pinned by `packages/chain/test/frontier-e2e.test.ts`; the
HTTP surface by `packages/gateway/test/gateway.test.ts`.
