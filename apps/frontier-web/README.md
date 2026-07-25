# frontier-web — the frontier game in a browser

The mordecai frontier example, running on HSSN: claim tiles, build farms
and lumbermills, harvest by block height, and trade wood/wheat through the
escrowed on-chain order book — all from a plain web page.

This is the **web tier** of the frontend-flow design: browsers can't join
HyperDHT, so the page talks JSON to an `@hssn/gateway` (any node operator
can run one) and signs every transaction locally with Ed25519
(`@noble/curves`) over `@hssn/protocol`'s canonical signing bytes. The
gateway never sees a key; it can refuse service but cannot forge or
tamper.

## Run it

```sh
pnpm build                                   # workspace packages
pnpm --filter @hssn/example-frontier-web build   # this app → dist/
node scripts/frontier-demo.mjs               # devnet + contract + gateway
```

Open the printed URL (default `http://127.0.0.1:8787`). Two funded dev
accounts (alice, bob) come from the gateway's `/api/config`; switch
between them in the UI to trade against yourself.

For UI development with hot reload, keep the demo running and:

```sh
pnpm --filter @hssn/example-frontier-web dev   # Vite, proxies /api → :8787
```

## How it maps

| mordecai (CosmWasm)               | here                                        |
| --------------------------------- | ------------------------------------------- |
| `frontier.pysc` (mordsl)          | `compiler/examples/frontier.pysc` (hssnc)   |
| cosmjs + Comet RPC                | `src/chain.js` → gateway JSON API           |
| cw-storage-plus key decoding      | DSL storage layout (`s:<Map>:` + LE keys)   |
| dev accounts in chain-config.json | dev accounts in `/api/config` (devnet only) |

The contract state is read in one `GET /api/contract/<id>/state` sweep and
decoded client-side; the UI polls every 2.5s, the same cadence as the
original.
