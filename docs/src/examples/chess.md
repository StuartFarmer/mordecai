# Chess: A Complete P2P App

`apps/chess` is the spec's flagship example (§15): a wagered chess match
where **the game never touches the chain** and **the money never touches
the game**. Its end-to-end test plays a full wagered match on a
2-validator devnet in under two seconds.

## The split

| Concern                  | Where     | Mechanism                                  |
| ------------------------ | --------- | ------------------------------------------ |
| moves, turn order        | off-chain | two Hypercore feeds, one per player        |
| chat, clocks, spectating | off-chain | more feeds (not in the demo)               |
| stakes, escrow, payout   | on-chain  | `ChessWager` contract (written in the DSL) |
| identity                 | both      | the same key signs feeds and transactions  |

## Playing (`src/match.ts`)

Each player owns one append-only feed; the host plays white. Moves
interleave by ply — white's feed holds plies 0, 2, 4…, black's 1, 3, 5… —
so the merged game is deterministic without any coordination protocol:

```ts
const hosted = await ChessMatch.host(alice, 'match-0'); // white
const black = await ChessMatch.join(bob, 'match-0', hosted.feedKey);
const white = await hosted.acceptOpponent(alice, black.feedKey);

await white.move('e4');
await black.waitForOpponent(); // 'e4' — get()-driven, resolves on arrival
await black.move('e5');
```

`move()` enforces turn alternation locally; because every entry is signed
by its author's key, neither player can forge or reorder the other's moves
— the pair of feeds is tamper-evident dispute evidence.

Move _legality_ is deliberately the client's job. Both clients validate;
if your opponent's client sends an illegal move, yours refuses to continue
and you have their signed feed to prove it. The contract stays a referee
of outcomes, not a rules engine.

## The wager (`src/wager.ts` + `compiler/examples/chess_wager.pysc`)

The contract is walked through line by line in the
[DSL tutorial](../contracts/tutorial.md). The client wrapper is thin:

```ts
const wager = new WagerClient(app, contractId);
await wager.create(100_000n); // escrow stake as attached value
await wager.join(0n, 100_000n); // opponent matches it
await wager.report(0n, winnerAddress); // each player, after the game
await wager.cancel(0n); // creator only, before join
```

## What the e2e test proves

`apps/chess/test/chess.test.ts`, against real consensus over a real DHT:

- escrow accumulates exactly `2 × stake` in the contract account;
- a wrong-stake join fails with the contract's message and reverts its
  attached value;
- cancel-after-join is rejected;
- moves flow both directions peer-to-peer with turn enforcement;
- two matching reports settle: the winner receives the full pot, the
  contract balance returns to zero, `match settled` appears in the events;
- a second settlement attempt fails (`match is not active`).

## A lesson this example taught

The move-wait originally polled `feed.update()` and could stall forever —
`update()` waits passively for peer announcements. The fix (and the rule of
thumb now in the [networking chapter](../architecture/networking.md)): use
`feed.get(index)`, which actively requests the block and resolves when it
arrives.
