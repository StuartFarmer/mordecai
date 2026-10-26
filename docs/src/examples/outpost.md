# Outpost: Goods, Orders and Settlement

Outpost is a cross-chain goods exchange: buy goods, fulfill orders and watch
payment settle. The order book leads the interface; land and harvesting live
in a collapsed **Supply & production** panel. Frontier is the land and trading
game; Outpost focuses on the fulfillment and payment flow.

The **production economy runs
on a player-run app chain**, the **goods market runs on L1**, and **one
wallet identity acts on both** — the Ed25519 key that holds CAI on L1
is the same key that owns tiles and wood in the game. L1 currency buys
in-game items with no bridge anywhere.

```sh
pnpm build && pnpm --filter @mordecai/example-outpost-web build
node scripts/outpost-demo.mjs      # → http://127.0.0.1:8787
```

## The trade loop

1. **bob (L1)** — `place_order("wood", 10)` with 1000 CAI attached.
   `goods_market.pysc` escrows it. Wood does not exist on L1; the order
   is a claim on something that only exists in the game.
2. **alice (app chain)** — claims land, harvests, clicks _deliver_:
   `outpost.pysc` moves 10 wood from her game account to bob's — keyed
   by the **same addresses** they use on L1 — and records a `Delivery`.
3. **the anchor daemon** — next epoch, the app's quorum (alice's and
   bob's validator keys) attests the game's state root plus one outcome
   call: `settle(order_id, alice)`. The market contract checks only
   `sender == config.game` and releases the escrow to alice.

CAI never left L1. Wood never left the game. The anchor carried
_judgment_ — "order 0 was delivered by alice" — not value. Alice's L1
balance after the demo is her starting balance + exactly 1000: her only
L1 transaction ever was being paid.

## The two contracts

`compiler/examples/outpost.pysc` (app chain) is frontier's land economy
plus the cross-chain hook:

```python
action deliver(order_id: int, buyer: address, good: str, amount: int):
    require(not exists(Delivery[order_id]), "order already delivered")
    ...move goods from sender to buyer...
    Delivery[order_id] = Delivery(seller=sender, buyer=buyer,
                                  good=good, amount=amount)
```

`compiler/examples/goods_market.pysc` (L1) escrows and settles:

```python
action place_order(good: str, amount: int):
    require(value > 0, "attach the payment as value")   # escrow
    ...

action settle(order_id: int, seller: address):
    require(sender == config.game, "only the game may settle deliveries")
    o = Order[order_id]
    require(o.phase == 0, "order is not open")
    o.phase = 1
    transfer(seller, o.price)
```

The settlement logic that connects them — "which delivered orders are
still open?" — is the anchor daemon's `outcome` callback in
`scripts/outpost-demo.mjs`: ~25 lines of JS reading both chains' state
and emitting one `settle` call per epoch.

## The web client

`apps/outpost-web` is one page speaking to two gateways: game moves and
world reads go to the app-chain gateway (`:8788`), market orders and
balances to the L1 gateway (`:8787`). One seed signs on both chains, in
the browser. Delivered orders show _"awaiting verified anchor and L1 payment…"_
until confirmed L1 state shows _"Paid on L1"_. The standalone demo targets
~5s anchor epochs, but confirmation can take longer. The latest anchor and
both chain heights remain visible in the UI.

## What it proves

Every layer of the architecture in one flow: registry as root of trust,
deterministic per-app genesis, group state under BFT at game speed for
~zero fees, quorum-attested outcomes as the only cross-chain artifact,
one identity across all lanes, and a browser UI over untrusted gateways.
The protocol-level proof is `packages/appchain/test/market.test.ts`;
adversarial cases (replay, impersonation, double settlement) are all
asserted there.

## On the node site

Create an account in **Account**, then open **Demos → Outpost**. Registration
automatically grants 1,000,000 test CAI on L1 and funds the separate app-chain
fee balance. Your account signs game moves on the shared Outpost app chain
and market orders on the node's existing L1.
The embedded demo never imports the development accounts or operator seeds.
World state, validator identities and deployment receipts survive host restarts.

Place a buy order to escrow L1 test CAI for goods. Another wallet can fulfill
it from available inventory. Suppliers can open **Supply & production** to
claim a tile, build and harvest as app-chain block height advances. Delivering the exact buyer, good and amount
lets the next signed anchor settle payment; confirmed L1 state determines payout.
A mismatched delivery cannot release payment or block other valid orders, but
it occupies that order's delivery slot: its buyer can cancel and create a new order.

This is not an atomic exchange: cancellation racing a delivery can leave test
goods transferred without payment. Cancelled orders are shown separately from
confirmed payouts. The standalone launcher retains its separate, temporary
development network and Alice/Bob account mode.
