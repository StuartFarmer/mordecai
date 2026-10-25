# How-To: Run Your App on Its Own Chain

This walks through the whole app-chain lifecycle with `@mordecai/appchain`:
start or discover, join, play, and optionally anchor and settle. The finished version of every step
is `packages/appchain/test/market.test.ts` and `scripts/outpost-demo.mjs`.

## When you want one

Use a feed when one author owns the data. Use an app chain when **the
group's agreement is the data**: contended game state, shared rules,
anything that must survive any single player leaving — and especially
anything L1 money will settle on. Contracts encode the _referee_
(legality, resources, outcomes); the app keeps everything else
(rendering, search, AI, UI).

## Start without settlement

App networks can run independently. Create a persistent identity first:

```sh
mordecai app init --dir ./game
```

Then start the first peer from your app's Node.js entry point:

```ts
import { readKeyFile } from '@mordecai/node';
import { AppChain } from '@mordecai/appchain';

const keyPair = readKeyFile('./game/peer.key');
const game = await AppChain.start({
  appId: 'com.example.game',
  chainValidators: [keyPair.publicKey],
  keyPair,
  dir: './game',
  gateway: { port: 8787 },
  // feedKeys: [bundleFeedKey, sharedDataFeedKey],
});
```

Share the machine's reachable gateway URL. Another participant can join:

```sh
mordecai app connect --dir ./my-game --app http://192.168.1.20:8787
```

Or use `AppChain.connect('http://192.168.1.20:8787', { dir: './my-game' })`.
The peer reads `/api/connect`, verifies the connection document's structure
and genesis hash, and joins the advertised native peer network. The URL is
an introduction, not a permanent central server. Every joined app peer
serves the same network configuration with its own RPC key.

Both roles seed the advertised feed keys and run HTTP access. A key in
`chainValidators` also votes; every other key participates without voting.
The source URL supplies the initial trust configuration. An existing data
directory rejects a different genesis rather than switching networks.

Settlement is optional. When you register this app later, use the same app
ID and validator order so the derived genesis stays identical. Settlement
contracts and anchoring remain separate setup. You may advertise optional
`settlement: { nodeKey, chainId, bootstrap }` metadata from `AppChain.start`.
Direct joins do not contact that settlement node automatically.

The following sections describe the registry-based entry path and optional
settlement integration.

## 1. Register the app with its validator set

The registry entry is the root of trust. For a match or guild world, the
validators are simply the players' wallet keys:

```ts
await mordecai.publishApp({
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
import { AppChain } from '@mordecai/appchain';

const game = await AppChain.join(l1Rpc, 'com.example.outpost', {
  dir: './outpost-chain',
  // keyPair: myKeys, // optional; otherwise creates/reuses dir/peer.key
  blockIntervalMs: 300, // game speed, not L1 speed
});
await game.waitForPeers(1); // let the mesh form before the first move
```

Joining starts the HTTP gateway, chain verification and replication for
both roles. It also downloads and seeds the registered app bundle.
`game.node.gateway.port` is the browser API port; `game.node.network`
provides feed access. Pass `feedKeys` for other app-selected feeds, or call
`game.node.network.seedFeed(key)` for feeds discovered while running.
These dynamic subscriptions must be selected again when the app reconnects.
No bundle is automatically executed.

Validators automatically answer `anchor_sign` on their node endpoint —
dialed by the same keys the registry publishes, so there is no extra
discovery. Ordinary peers sync, verify, store and serve data without voting.

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
import { AnchorDaemon } from '@mordecai/appchain';

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

`appAddress(appId)` is exported by `@mordecai/chain` (node side) and
`@mordecai/sdk` (app side, Bare-safe). Design the contract so the app's
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
- **Browser UIs:** use the node's built-in [gateway](gateway.md); pass
  `gateway: { port, staticDir, config }` to configure it. Its JSON surface
  is identical to L1's.
- **Disposal:** after the last anchor of a season, the chain's data dirs
  can be deleted. L1 keeps the anchor and the settlement forever.
