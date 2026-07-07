# How-To: Run Your App on Its Own Chain

This walks through the whole app-chain lifecycle with `@hssn/appchain`:
register, join, play, anchor, settle. The finished version of every step
is `packages/appchain/test/market.test.ts` and `scripts/outpost-demo.mjs`.

## When you want one

Use a feed when one author owns the data. Use an app chain when **the
group's agreement is the data**: contended game state, shared rules,
anything that must survive any single player leaving — and especially
anything L1 money will settle on. Contracts encode the _referee_
(legality, resources, outcomes); the app keeps everything else
(rendering, search, AI, UI).

## 1. Register the app with its validator set

The registry entry is the root of trust. For a match or guild world, the
validators are simply the players' wallet keys:

```ts
await hssn.publishApp({
  appId: 'com.example.outpost',
  version: '1.0.0',
  bundle,
  chainValidators: [alice.publicKey, bob.publicKey],
});
```

Rotation is an owner-gated `update_app` with a new set; the _current_
set at execution time judges each anchor.

## 2. Join the chain

Every peer derives the same genesis from the registry entry alone:

```ts
import { AppChain } from '@hssn/appchain';

const game = await AppChain.join(l1Rpc, 'com.example.outpost', {
  dir: './outpost-chain',
  keyPair: myKeys, // validator if in the set, follower otherwise
  blockIntervalMs: 300, // game speed, not L1 speed
});
await game.waitForPeers(1); // let the mesh form before the first move
```

Validators automatically answer `anchor_sign` on their node endpoint —
dialed by the same keys the registry publishes, so there is no extra
discovery. Followers sync and serve reads.

## 3. Deploy the rules and play

The app chain runs the same VM and DSL as L1, so game rules are ordinary
contracts, deployed and executed with the same transaction format — just
against `chainId: "app:" + appId`, at your block interval, with fees that
cost nothing real (the genesis gives validators a fee float; app-chain
currency is valueless by design). Moves never touch L1.

## 4. Anchor, with an outcome

One validator runs the daemon (any validator; several is fine — epochs
come from L1, so they converge):

```ts
import { AnchorDaemon } from '@hssn/appchain';

const daemon = new AnchorDaemon({
  chain: game.chain,
  appId: 'com.example.outpost',
  validators: [alice.publicKey, bob.publicKey],
  keyPair: myKeys,
  l1: { chainId, nodeKey, bootstrap },
  relayer, // any funded L1 account; untrusted
  epochIntervalMs: 5_000, // or call daemon.anchorNow() yourself
  outcome: async (chain) => {
    // Read your own chain, decide what L1 should hear. One call per epoch.
    const fills = await chain.getContractState(gameContract, prefix('s:Delivery:'));
    return pickSettlement(fills) ?? null; // {contract, action, args} | null
  },
});
```

The daemon builds the attestation from the chain head, self-signs,
collects co-signatures (each co-signer refuses anything its own chain
disagrees with), and relays the anchor to L1. Nothing anchors while the
chain is idle.

## 5. Gate the L1 contract on the app

The receiving contract needs exactly one line of authorization:

```python
contract GoodsMarket:
    config:
        game: address          # set to appAddress(appId) at init

    action settle(order_id: int, seller: address):
        require(sender == config.game, "only the game may settle")
        ...
```

`appAddress(appId)` is exported by `@hssn/chain` (node side) and
`@hssn/sdk` (app side, Bare-safe). Design the contract so the app's
authority is _scoped_: it can report outcomes, never touch stakes it
wasn't given, and a `cancel_after(deadline)` refund path covers the
quorum dissolving without reporting.

## 6. What to test

Mirror `market.test.ts`: the happy path (escrow → play → anchored
outcome → payout), then the adversarial set — replayed anchors (stale
epoch), sub-quorum and outsider signatures, direct calls impersonating
the app, double settlement. All of those are receipt-level assertions
against in-process chains; the whole suite runs in seconds.

## Ops notes

- **Old data dirs:** anchors shipped with `PROTOCOL_VERSION 2`; devnets
  from before it need fresh data dirs.
- **Browser UIs:** point a second [gateway](gateway.md) at any app-chain
  node — the JSON surface is identical to L1's.
- **Disposal:** after the last anchor of a season, the chain's data dirs
  can be deleted. L1 keeps the anchor and the settlement forever.
