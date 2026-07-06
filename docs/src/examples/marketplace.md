# The Marketplace Contract

`contracts/marketplace` (Rust) is the spec Phase 4 milestone contract and
the reference for hand-written contracts against the raw ABI. Items have an
owner, a price, and a for-sale flag; buying is atomic.

## Actions

| Action     | Args           | Value                 | Effect                                        |
| ---------- | -------------- | --------------------- | --------------------------------------------- |
| `list`     | price u64      | —                     | new item owned by caller; returns id (u64 LE) |
| `buy`      | item id        | **exactly the price** | pays the seller, flips owner, marks off-sale  |
| `cancel`   | item id        | —                     | owner takes it off sale                       |
| `relist`   | item id, price | —                     | owner puts it back on sale                    |
| `get_item` | item id        | —                     | returns owner(32) ‖ price(8 LE) ‖ for_sale(1) |

## The atomic-trade pattern

`buy` is the canonical use of attached value:

```rust
if c::attached_value() != item.price { c::fail("attached value must equal price"); }
if !c::transfer(&item.owner, item.price) { c::fail("payout failed"); }
store_item(id, &Item { owner: buyer, price: item.price, for_sale: false });
```

The buyer's payment was credited to the contract before the action ran; the
contract forwards it to the seller and transfers ownership in the same
atomic action. Any failure — wrong price, item off sale, buying your own
item — aborts, and the buyer's attached value comes back automatically.
There is no state in which money moved but ownership didn't.

## Storage layout

`item:<id LE8>` → `owner(32) ‖ price(8 LE) ‖ for_sale(1)`, plus `next_id`.
Hand-rolled fixed-order encoding — deterministic by construction, cheap to
decode. (The DSL generates the equivalent codec automatically.)

## Tests

`packages/chain/test/contracts.test.ts` covers the full trade (list → buy →
ownership flip → seller paid), the refund path on wrong attached value,
re-buy of an off-sale item, and — via the follower-replay test — that
marketplace blocks re-execute to identical state roots on other validators.

The e2e marketplace _application_ (UI over this contract) is future
example-suite work; the contract itself is production-shaped.
