# hex-web — winner-takes-all Hex in a browser tab

The full app-chain vertical with strangers: one person runs
`scripts/hex-demo.mjs` (L1 devnet, app chain, anchor daemon, faucet,
gateways); everyone else opens the site, loads a wallet or creates a temporary
one in the browser, and plays.

For the complete onboarding flow, open `/wallet.html` on the demo gateway,
create a wallet, download its unencrypted private-key backup, and claim test CAI.
Return to the game and load the same file. Hex also funds that identity on both
chains when needed for stakes and app fees. New keys remain in browser memory;
load the backup again after refreshing. Legacy saved Hex identities remain
available through **Use saved Hex wallet**. Keep backups private and use only
test tokens. Full walkthrough: [Web Wallet, Faucet, and Hex](../../docs/src/examples/hex-web.md).

- **Game codes.** Players agree on any string out of band. Its hash keys
  both the app-chain `Game` and the L1 `Pot` — create a game by entering a
  new code, join one by entering a code whose game hasn't started.
- **Escrow.** Creating a game stakes CAI into `hex_escrow` on L1 (default
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
pnpm --filter @mordecai/example-hex-web build
node scripts/hex-demo.mjs        # → http://<host>:8787
```

Dev mode against a running demo: `pnpm --filter @mordecai/example-hex-web dev`.

## Integrated node site

Run `pnpm build` then `node scripts/node-demo.mjs`; open port 8790 and choose
**Demos → Hex**. Wallet and Faucet are shared with the node site. The embedded
build receives a revocable transaction facade instead of a private key; its
Shadow DOM keeps game styles separate from the site. The standalone build and
launcher above remain available. The integrated launcher's data persists in
`.mordecai-demo/`; see the book guide for restart and deployment details.
