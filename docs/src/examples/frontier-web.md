# Frontier in the Browser

Frontier is the land-economy contract (claim tiles, build farms and
lumbermills, harvest by block height, trade wood↔wheat through an
escrowed on-chain order book) played from a plain web page — the proof
of the web tier: **open a URL, click a tile, own land**, with no wallet
extension and no backend beyond a [gateway](../apps/gateway.md).

```sh
pnpm build && pnpm --filter @hssn/example-frontier-web build
node scripts/frontier-demo.mjs     # → http://127.0.0.1:8787
```

The demo starts a 3-validator devnet, deploys
`compiler/examples/frontier.pysc`, funds two dev accounts, and serves
`apps/frontier-web` from the gateway. Switch between alice and bob in
the UI to trade against yourself.

## How the client works

- **Signing in the browser.** Keys derive from seeds in `/api/config`
  (devnet custody); `@noble/curves` signs the same canonical
  `transactionSigningBytes` the wallet daemon signs with sodium. The
  gateway never sees a key. ~65 KB gzipped, total.
- **State reads.** One `GET /api/contract/<id>/state` sweep returns raw
  storage entries; the client decodes the DSL layout (`s:<Map>:` keys,
  fields in declared order) into tiles, accounts, and orders — the same
  pattern any explorer or indexer would use.
- **No trust in the gateway.** It relays signed bytes and serves raw
  state. Any other gateway serves the same app identically.

The contract itself is walked through in [Land](land.md) (frontier is
land plus a second building kind and the escrowed market). The on-chain
behavior is pinned by `packages/chain/test/frontier-e2e.test.ts`; the
HTTP surface by `packages/gateway/test/gateway.test.ts`.
