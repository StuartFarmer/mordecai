# outpost — the MMORTS cross-chain demo

A small MMORTS proving the app-chains design end to end: the **game runs
on a player-run app chain** (claim land, build farms/lumbermills, harvest
by block height), the **goods market runs on L1** (buyers escrow HSSN),
and **one wallet identity acts on both** — the same Ed25519 key that
holds HSSN on L1 owns tiles and wood in the game.

The trade loop, with no bridge anywhere:

1. **bob (L1)** — `place_order(wood, 10)` with 1000 HSSN attached; the
   market contract escrows it.
2. **alice (app chain)** — earns wood in-game, clicks _deliver_: the game
   contract moves 10 wood from her account to bob's **at the same
   addresses they use on L1**, and records the `Delivery`.
3. **the anchor daemon** — next epoch, the app chain's quorum
   (alice + bob's validator keys) attests its state root plus one outcome
   call: `settle(order_id, alice)`. On L1 the market checks only
   `sender == config.game` and releases the escrow to alice.

HSSN never left L1; wood never left the game; the anchor carried
judgment, not value (app-chains spec invariants 1–3).

## Run it

```sh
pnpm build && pnpm --filter @hssn/example-outpost-web build
node scripts/outpost-demo.mjs
```

Open http://127.0.0.1:8787. Two funded identities (alice, bob) come from
`/api/config`; the L1 gateway is same-origin, the app-chain gateway
(:8788) is called cross-origin. Delivered orders show
“settling on next anchor…” and flip to “settled” within one ~5s epoch.

Contracts: `compiler/examples/outpost.pysc` (game),
`compiler/examples/goods_market.pysc` (market). The protocol-level proof
of this flow is `packages/appchain/test/market.test.ts`.
