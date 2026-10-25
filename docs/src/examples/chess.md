# Chess: browser rooms and native P2P matches

The node site offers **Demos → Chess**. Load a wallet in Wallet, fund it from
Faucet, and create a room with a positive integer stake in base units. Copy the
invitation to another browser with a different wallet. The creator plays white;
the joiner matches the stake and plays black. Extra visitors can spectate.

Select a piece and destination to move; choose a promotion piece before moving
a pawn onto its last rank. The board validates legal moves, checkmate, stalemate,
repetition and other automatic draws. Players can resign or offer/accept a draw.
Both players must then use **Report result on L1**. The page keeps settlement
pending until confirmed contract state closes the wager. Each side's report is
shown separately; submitting a local game result does not itself pay out.

**Active stakes can remain locked if a player refuses to report or abandons a
match. There is no automatic adjudication or active-match timeout.** Only the
creator can cancel before an opponent joins. Matching draw reports refund each
stake, less transaction fees already paid. Keep enough balance for fees.

The browser uses a same-origin signed-message relay, not direct HyperDHT.
Messages bind the chain, deployed contract, room, sequence, previous hash and
action to the wallet signature. Host and browser replay the same signatures and
rules using [chess.js 1.4.0](https://jhlywa.github.io/chess.js/), distributed under
its [BSD-2-Clause license](https://github.com/jhlywa/chess.js/blob/master/LICENSE).
The host verifies confirmed wager membership before accepting play. A room-key
mapping on L1 binds each creation to its match even when several users create
simultaneously. A host can withhold service, but cannot forge player messages.

Room histories survive host restart. Reopen the invitation and load the same
wallet to resume. Retry an uncertain move with **Retry identical signed message**;
accepted identical retries do not append again. If registration was interrupted
after creating the wager, use **Recover room registration** and, if needed, paste
the confirmed creation hash from Wallet history. Only public receipt hashes are
saved by the game. Closing or replacing a wallet revokes further sends/signatures.

`apps/chess` remains the native Hypercore example. Its transport and `WagerClient`
API are unchanged; the browser client lives in `apps/chess-web`.

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

## Browser contract additions

`create_room(room: address)` creates an ordinary sequential match and records
`Room[room].match_plus_one`. The 32-byte room identifier is generated in the
browser, and registration verifies the confirmed create transaction and signer.
Native `create()`, `join()`, `report()` and `cancel()` retain their interfaces.
`draw(match_id)` records a player's draw report and refunds both stakes only when
both players agree. A later winner report clears that player's draw choice.

Tests cover signature tampering, wrong deployment/room, sequence replay, illegal
moves, self-join, conflicting concurrent appends, exact retries and persisted
recovery. Real-network escrow tests cover concurrent room creation, mutual draws,
creator cancellation and the original native winner payout.
