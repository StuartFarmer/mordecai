# Tutorial: A Wager Contract in the DSL

We'll build the escrow contract the chess app uses, from scratch. It's the
full `compiler/examples/chess_wager.pysc` that ships in the repo.

**The job:** two players each escrow a stake; the game happens elsewhere
(off-chain, over feeds); when both players report the same winner, the pot
pays out. The contract is the referee of last resort — it never sees a
chess move.

## 1. Declare the contract and its state

```python
contract ChessWager:

    state Meta[int]:
        next_id: int = 0

    state Match[int]:
        creator: address
        opponent: address
        stake: int
        # 0 = open, 1 = active, 2 = settled or cancelled
        phase: int = 0
        creator_reported: bool = False
        opponent_reported: bool = False
        creator_pick: address
        opponent_pick: address
```

`state Name[key_type]:` declares a map in the contract's isolated storage.
Fields with defaults are optional at construction; a map whose fields _all_
have defaults (like `Meta`) reads as the default instance when missing —
which is how `Meta[0].next_id` works before anything is written.

## 2. Create a match — money in

```python
    action create():
        require(value > 0, "attach a stake to create a match")
        match_id = Meta[0].next_id
        Meta[0].next_id += 1
        Match[match_id] = Match(
            creator=sender,
            opponent=sender,
            stake=value,
            creator_pick=sender,
            opponent_pick=sender,
        )
        emit("match created")
```

Three builtins do the heavy lifting: `sender` (the signing key), `value`
(currency attached to this call — **already credited to the contract's
account** when the action runs), and `require(cond, msg)` — on failure the
whole call aborts and _everything reverts, including the attached value_.
Fields without a natural initial value (`opponent`, the picks) are seeded
with `sender` as a placeholder; `phase` guards against reading them as
meaningful.

## 3. Join — matching stake, no self-play

```python
    action join(match_id: int):
        m = Match[match_id]
        require(m.phase == 0, "match is not open")
        require(sender != m.creator, "cannot play against yourself")
        require(value == m.stake, "attached value must match the stake")
        m.opponent = sender
        m.phase = 1
        emit("match joined")
```

`m = Match[match_id]` binds a state handle; reading a missing entry of a
non-defaultable map aborts with `no such Match entry`. Writes through the
handle persist immediately. After `join`, the contract's account holds
`2 × stake`.

## 4. Settle — money out, only on agreement

```python
    action report(match_id: int, winner: address):
        m = Match[match_id]
        require(m.phase == 1, "match is not active")
        require(winner == m.creator or winner == m.opponent,
                "winner must be one of the players")
        if sender == m.creator:
            m.creator_pick = winner
            m.creator_reported = True
        elif sender == m.opponent:
            m.opponent_pick = winner
            m.opponent_reported = True
        else:
            require(False, "only the players can report a result")

        if m.creator_reported and m.opponent_reported:
            if m.creator_pick == m.opponent_pick:
                m.phase = 2
                transfer(m.creator_pick, m.stake + m.stake)
                emit("match settled")
```

`transfer(to, amount)` pays out of the **contract's own balance** and
aborts the action if it can't. Note the disagreement case: each player
reports once (the flags), so a disputed match simply never settles and the
pot stays escrowed. A production version would add a timeout or arbiter
path; the signed move feeds exist precisely as dispute evidence.

Add `cancel` (creator-only, phase 0, refunds the stake) and you have the
complete shipped contract.

## 5. Compile, deploy, drive it

```sh
./compiler/hssnc check  compiler/examples/chess_wager.pysc
./compiler/hssnc build  compiler/examples/chess_wager.pysc -o build/wager --wasm
```

```ts
const { contractId } = await app.deploy(wasm);
await alice.execute(contractId, 'create', new Uint8Array(0), 100_000n);
await bob.execute(contractId, 'join', new ContractArgs().u64(0n).encode(), 100_000n);
// … play chess over feeds …
await alice.execute(contractId, 'report', new ContractArgs().u64(0n).address(aliceKey).encode());
await bob.execute(contractId, 'report', new ContractArgs().u64(0n).address(aliceKey).encode());
// → receipt events include "match settled"; alice's balance grew by 2×stake
```

The end-to-end version of exactly this flow is the test in
`apps/chess/test/chess.test.ts`.
