# hex-web — winner-takes-all Hex in a browser tab

The full app-chain vertical with strangers: one person runs
`scripts/hex-demo.mjs` (L1 devnet, app chain, anchor daemon, faucet,
gateways); everyone else just opens the site, gets a wallet generated in
the page, and plays.

- **Game codes.** Players agree on any string out of band. Its hash keys
  both the app-chain `Game` and the L1 `Pot` — create a game by entering a
  new code, join one by entering a code whose game hasn't started.
- **Escrow.** Creating a game stakes HSSN into `hex_escrow` on L1 (default
  1,000,000); joining matches it. The winner takes the whole pot, paid by
  the app chain's anchored `settle(game_id, winner)` outcome call.
- **Rules on-chain.** `hex.pysc` enforces turns, occupancy, and bounds on
  the classic 11×11 board. Wins are _proven_ on-chain: the client finds the
  connecting path and walks the contract along it, one adjacency-checked
  `prove_step` per stone.
- **3-minute forfeit.** Every action refreshes a `time`-based deadline
  (block timestamps); once it lapses, the opposing browser automatically
  claims the win.

```sh
pnpm --filter @hssn/example-hex-web build
node scripts/hex-demo.mjs        # → http://<host>:8787
```

Dev mode against a running demo: `pnpm --filter @hssn/example-hex-web dev`.
