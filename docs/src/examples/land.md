# Land: State Maps & Config

`compiler/examples/land.pysc` is the DSL conformance example — a tiny land
game exercising every core language feature: config, two state maps (one
int-keyed, one address-keyed), defaults, `exists`, and the `height`
builtin. It also shows the _shape_ of a game economy done on-chain-lightly.

```python
contract Land:

    config:
        max_tiles: int

    state Tile[int]:
        owner: address
        building: str = ""
        last_harvest_height: int = 0

    state Account[address]:
        wood: int = 0
        wheat: int = 0

    action claim_tile(tile_id: int):
        require(tile_id < config.max_tiles, "tile is off the map")
        require(not exists(Tile[tile_id]), "tile is already claimed")
        Tile[tile_id] = Tile(owner=sender, last_harvest_height=height)
        Account[sender].wood += 25

    action harvest(tile_id: int):
        tile = Tile[tile_id]
        require(tile.owner == sender, "only the tile owner can do that")
        require(tile.building == "farm", "tile has no farm to harvest")
        grown = height - tile.last_harvest_height
        require(grown > 0, "nothing to harvest yet")
        Account[sender].wheat += grown
        tile.last_harvest_height = height
```

(Plus `transfer_tile` and `build_farm` — see the file.)

## Things to notice

- **`config` + generated `init`.** `max_tiles` is set once by calling
  `init(100)` after deploy; every action reading `config` aborts until
  then, and nothing can change it after.
- **`exists()` for first-claim semantics** — the idiomatic
  "create-if-absent, reject-if-present" check.
- **`height` as the only clock.** Wheat "grows" per block. Two harvests in
  the _same_ block: the first collects, the second hits
  `nothing to harvest yet` — deterministic time, no wall clock. (The e2e
  test asserts exactly this pair of outcomes.)
- **`Account[address]` maps** — per-user inventories keyed by the caller's
  key: the standard pattern for balances of anything that isn't the native
  currency.

## Where it runs in CI

`packages/chain/test/dsl-e2e.test.ts` compiles this file with `hssnc`
(when a Rust/Python toolchain is present), deploys the result, and asserts
the require messages, the one-shot `init`, and the height-driven harvest
behavior against a real chain — the spec Phase 7 milestone, executed on
every full test run.
