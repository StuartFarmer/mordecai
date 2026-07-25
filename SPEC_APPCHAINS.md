# App Chains — anchored per-app consensus (feature spec, v0.1)

Status: draft for the `feat/app-chains` branch.
Depends on: the platform as of spec parts 1–3 plus the gateway/web tier
(`packages/gateway`, `apps/frontier-web`).

---

## 1. Concept

An **app chain** is the group-truth lane of a Pear app: the same `Chain` +
`ConsensusEngine` + VM + DSL that run L1, instantiated _by the app's own
peers_ with a per-app genesis, discovered over the same swarm (topic =
genesis hash). It sits between the two lanes that already exist:

| who must agree?     | lane                | primitive                 |
| ------------------- | ------------------- | ------------------------- |
| nobody (one author) | content             | hypercore feed            |
| the app's peers     | **app chain (new)** | Chain + VM + DSL, per-app |
| everyone (money)    | L1                  | the existing chain        |

Design invariants, agreed up front:

1. **No value bridging.** Nothing mints on an app chain against an L1
   deposit; there are no exits, no escrows spanning chains. App-chain
   resources are native to the app chain and die with it.
2. **Payments stay on L1.** The only cross-chain artifact is the
   **anchor**: a quorum-attested statement "our chain reached state root
   R at height H" plus, optionally, one **outcome call** — an ordinary
   contract call delivered _as the app_ (`sender = appAddress(appId)`).
3. **L1 trusts exactly the app's registered quorum for that app's
   results, and nothing else.** The blast radius of a corrupt app chain
   is the pot voluntarily staked on it.
4. **Anchors make forgetting safe.** Once an epoch is anchored, the app
   chain's block history is disposable (seeded at the peers' leisure);
   the permanent record is the anchor.
5. **Relayers are untrusted.** Anyone may submit an anchor transaction;
   the attestation signatures are the authority. The relayer pays the L1
   fee with its own account.

Non-goals for v0.1: fraud proofs, validity proofs, validator-set rotation
by anchor (rotation is owner-gated `update_app`), fee-free app-chain
accounts beyond the genesis allocation convention, Bare-native in-app
execution (apps may run the chain in-process under Node or as a sidecar;
the wasmtime-on-Bare port is tracked separately).

---

## 2. Wire-level design

### 2.1 App sender address

```
appAddress(appId) = BLAKE2b-256( "mordecai:app-sender:v1" ‖ utf8(appId) )
```

A 32-byte account key with no known private key. Contracts authorize app
outcomes with plain DSL: `require(sender == config.game, ...)`.

### 2.2 Anchor attestation (what app validators sign)

```
anchorSigningBytes =
  "mordecai:anchor:v1" ‖ string(l1ChainId) ‖ string(appId) ‖ u64(epoch)
  ‖ u64(appHeight) ‖ fixed32(stateRoot)
  ‖ u8(hasCall) [‖ fixed32(contract) ‖ string(action) ‖ bytes(args)]
```

- `epoch` — strictly increasing per app (replay protection on L1).
- `appHeight`/`stateRoot` — the app chain's head being attested.
- Binding `l1ChainId` prevents cross-network replay; binding the call
  into the same preimage means the quorum signs the outcome, not just
  the root.
- Validators only sign attestations whose `stateRoot` matches their own
  chain at `appHeight` — they are running the chain, verification is a
  local lookup, no proofs needed.

### 2.3 New payload: `anchor` (tag 6)

```
anchor {
  appId:       string (≤ MAX_APP_ID_BYTES)
  epoch:       u64
  appHeight:   u64
  stateRoot:   32 bytes
  call?:       { contract: 32 bytes, action: string, args: bytes }   // hasCall u8
  signatures:  vec{ validator: 32 bytes, signature: 64 bytes }  (≤ MAX_APP_VALIDATORS)
}
```

Carried in an **ordinary transaction** — normal sender (the relayer),
normal nonce, normal fee (flat + per-byte prices the signature bytes;
the outcome call draws on the normal fuel budget from `maxFee`). This is
deliberately _not_ a new authorization path at the transaction envelope:
admission, mempool, hashing, blocks are all untouched.

Execution of an `anchor` payload (all-or-nothing, like any payload):

1. Registry lookup: `appId` registered, `chainValidators` non-empty.
2. Epoch: `payload.epoch > lastAnchoredEpoch(appId)` (initially 0).
3. Quorum: signatures from **distinct** keys, each in
   `chainValidators`, count ≥ `floor(2n/3) + 1`, each verifying against
   `anchorSigningBytes`.
4. Record `anchor:<appId> → { epoch, appHeight, stateRoot }` in L1
   state (it is part of the state root; anchors are auditable).
5. If `call` present: `runContract` with `caller = appAddress(appId)`,
   `value = 0`, normal fuel metering. A failed call fails the whole
   payload (the anchor is not recorded) — the quorum can re-anchor at a
   later epoch with a corrected call.
6. Emit event `anchor:<appId>:<epoch>`.

### 2.4 Registry extension

`AppRecord` (register_app / update_app payloads) and `AppEntry` (stored
form) gain:

```
chainValidators: vec<32-byte pubkey>   (0..MAX_APP_VALIDATORS = 64)
```

Empty = the app has no chain. `update_app` (owner-gated, as today)
rotates the set; the _current_ set at execution time judges each anchor.

### 2.5 App-chain genesis convention

Deterministic from the registry entry, so every joiner derives the same
genesis hash (= swarm topic) with no extra coordination:

```
chainId     = "app:" + appId
validators  = chainValidators (z32)
allocations = each validator gets 1_000_000_000_000 (fee float; app-chain
              currency is valueless by invariant 1)
```

---

## 3. Phases

### Phase 1 — protocol: anchor payload + registry fields

**Where:** `packages/protocol/src/{constants,transaction}.ts`, tests in
`packages/protocol/test/`.

**Work**

- `PAYLOAD_TAG_ANCHOR = 6`, `MAX_APP_VALIDATORS = 64`,
  `DOMAIN_ANCHOR = 'mordecai:anchor:v1'`.
- `AnchorPayload` + read/write in the payload codec (strict: dedup and
  count limits enforced at decode where cheap, full checks in execution).
- `chainValidators` appended to `AppRecord` read/write (u32 count +
  fixed 32-byte entries).
- `anchorSigningBytes(l1ChainId, payload)` exported next to
  `transactionSigningBytes` (same Writer discipline; one canonical
  encoding).
- Bump `PROTOCOL_VERSION` → 2.

**What breaks, how, fix**

- `packages/protocol/test/golden.test.ts` — register/update_app vectors
  change bytes → regenerate vectors, add anchor vectors. This is the
  _intended_ tripwire; treat every other golden diff as a bug.
- Old nodes decode new register_app/anchor txs as `WireError` → mixed
  old/new networks fork at the first new-format tx. Prerelease stance:
  no compatibility shim; devnets restart from fresh data dirs (stored
  blocks with old-format app payloads will not decode under the new
  reader). Documented in the branch notes.
- Genesis hashes are unaffected (genesis doesn't embed app records).

**Tests**

- Roundtrip: anchor payload with 0/1/many signatures, with and without
  call; AppRecord with 0/1/64 validators; rejection at 65.
- Golden vectors for both.
- `anchorSigningBytes` domain separation: differs across l1ChainId,
  appId, epoch, call presence.

### Phase 2 — chain: anchor execution + registry storage

**Where:** `packages/chain/src/execution.ts` (+ small `chain.ts` reads),
tests in `packages/chain/test/`.

**Work**

- `appAddress(appId)` (blake2b domain hash) exported.
- `AppEntry.chainValidators` in encode/decode; register/update_app
  execution copies it through.
- `anchorStateKey(appId)` (`an:` prefix) + record codec
  `{epoch, appHeight, stateRoot}`.
- `checkInclusion`: `anchor` case — non-empty appId, signature count in
  bounds (cheap gates only; crypto stays in execution so mempool
  admission stays O(bytes)).
- `executePayload` `anchor` case implementing §2.3 semantics.
- `requiredBalance`: anchors fall through to the `default` (`maxFee`).
- `Chain.getAnchor(appId)` read API.

**What breaks, how, fix**

- `AppEntry` stored encoding changes → chains persisted before this
  branch fail `decodeAppEntry` on old entries. Same prerelease stance:
  reset dev data dirs. (`Chain.open` already refuses stale state via the
  genesis/state-root check, so the failure is loud, not silent.)
- RPC `AppInfo` grows `chainValidators` (additive JSON — old clients
  unaffected) and a `get_app_anchor`-shaped read is added to `messages`/
  `server`/`client`.
- Nothing else: anchors are ordinary txs, so mempool/blocks/receipts
  are untouched by construction.

**Tests** (unit, two in-process `Chain`s where needed)

- Happy path: register app with 2 validators → anchor epoch 1 with both
  sigs → `getAnchor` returns record; event emitted.
- Quorum math: 1-of-1 accepted; 2-of-3 accepted; 1-of-2 rejected;
  duplicate-signer padding rejected; signer outside the set rejected.
- Replay/ordering: same epoch twice rejected; lower epoch rejected;
  epoch may skip (1 → 5 accepted).
- Signature binding: flipping any of l1ChainId / appId / epoch / height
  / root / call bytes invalidates.
- Outcome call: executes with `sender = appAddress`; DSL
  `require(sender == config.game)` admits it and rejects the same call
  from a normal key; failed call → whole anchor payload fails, epoch
  not consumed, relayer still pays fee.
- Rotation: update_app swaps validator set; old set's anchors rejected,
  new set's accepted.

### Phase 3 — `@mordecai/appchain`: run + attest + relay

**Where:** new `packages/appchain` (depends on node, chain, rpc,
protocol, crypto).

**Work**

- `appChainGenesis(appId, entry)` — the §2.5 convention.
- `AppChain.start({ appId, entry | rpc, dir, keyPair, bootstrap })` —
  wraps `Node.start` with the derived genesis. Validator if `keyPair` is
  in the set, follower otherwise. (The node stack is unchanged; this is
  composition.)
- Attestation helpers: `buildAttestation(chain, {appId, l1ChainId,
epoch, call?})` (reads head height/root), `signAttestation`,
  `verifyAttestation`.
- `registerCosigner` — an `anchor_sign` method registered **on the
  validator's existing node RPC endpoint** (the node's DHT identity is
  the validator keypair, so peers dial each other by the keys the
  registry already publishes; a second RPC server on the same keypair
  would collide on the DHT). Handler: verify `stateRoot` matches the
  _local_ chain at `appHeight` (waiting briefly if behind), sign,
  return. This is how a proposer collects the quorum without new
  consensus messages. Requires a small `NodeRpcServer.respondRaw` +
  `Node.rpcServer` accessor.
- `AnchorDaemon` — epoch timer (or `anchorNow()`): build attestation,
  self-sign, gather co-signatures, assemble the anchor payload, submit
  to L1 through `NodeRpcClient` with a funded relayer wallet, await
  receipt. Outcome via an app-supplied callback
  `outcome(chain) => {contract, action, args} | null` (JS decides what
  to report by reading app-chain state; a DSL-level outbox is future
  work).

**What breaks:** nothing existing — new package. Failure modes to
handle inside the package: co-signer behind head (bounded wait, then
anchor without a call or with fewer sigs if still quorate), L1 rejection
(stale epoch → refresh from `getAnchor` and retry), relayer balance
exhausted (surface loudly).

**Found during implementation** (two latent consensus-liveness gaps that
small player-run chains hit immediately, fixed on this branch):

- _Swarm discovery race_: two `PeerHub`s joining the same topic can
  announce/look up in the wrong order and hyperswarm's own re-query
  interval is minutes — the mesh simply never formed in fresh
  two-validator chains. Fix: the hub re-queries the topic every second
  while it has zero peers.
- _Proposal into an empty mesh_: a proposer that broadcasts before the
  mesh is up cannot re-propose (the one-vote-per-height lock forbids
  it), and gossip is not stored — the height deadlocked forever. Fix:
  on every stall-round rotation the engine re-broadcasts its locked
  proposal and vote (idempotent; duplicates are dropped by receivers,
  so safety is unaffected). `AppChain.waitForPeers(n)` is the
  belt-and-braces app-side pattern.

**Tests**

- Genesis determinism: two joiners derive identical genesis hash.
- Two-validator app chain over an in-process DHT testnet: play txs on
  the app chain, `anchorNow()` collects the co-signature via the
  Cosigner RPC and lands the anchor on a real L1 node; `getAnchor`
  reflects it.
- Follower join: third peer with no validator key syncs and serves
  reads.

### Phase 4 — SDK + gateway surface

**Where:** `packages/sdk`, `packages/rpc`, `packages/gateway`.

**Work**

- `publishApp({ ..., chainValidators? })` passes the set through;
  `Mordecai.appAddress(appId)` convenience; `Mordecai.joinChain(appId, opts)` →
  registry lookup + `AppChain.start`.
- RPC: `AppInfo.chainValidators`, `get_app_anchor` (or fold into
  `get_app`); client methods.
- Gateway: `GET /api/app/<appId>` (registry entry incl. validators +
  latest anchor). Full app-chain _state_ reads through the gateway
  (`/api/app/<id>/state`) are listed but optional in v0.1 — the demo
  reads app-chain state through a second gateway pointed at an
  app-chain node, which needs zero new code.

**What breaks:** gateway/rpc tests extended, not changed; `publishApp`
default (`[]`) keeps every existing caller working.

**Tests:** registry roundtrip through SDK (`publishApp` →
`installApp`/`getApp` sees validators); gateway `/api/app/...` shape.

### Phase 5 — vertical proof: a wagered season

**Where:** `packages/appchain/test/season.test.ts` (acceptance),
`compiler/examples/season_pool.pysc`, optional `scripts/season-demo.mjs`.

**The L1 contract** (DSL, ~20 lines):

```python
contract SeasonPool:
    config:
        game: address            # appAddress(appId)

    state Pot[int]:
        total: int = 0
        paid: bool = False

    action stake():
        Pot[0].total += value    # players attach their stake

    action payout(winner: address):
        require(sender == config.game, "only the game may report")
        require(not Pot[0].paid, "season already settled")
        Pot[0].paid = True
        transfer(winner, Pot[0].total)
```

**Acceptance flow** (the whole feature in one test):

1. L1 devnet; two players funded.
2. `publishApp('mmo-season-1', { chainValidators: [alice, bob] })`.
3. Deploy `SeasonPool` on L1 with `game = appAddress('mmo-season-1')`;
   both players `stake()` with attached value.
4. Both players `joinChain('mmo-season-1')` — the frontier contract is
   deployed _on the app chain_ and they play several fast, fee-trivial
   moves there.
5. Season ends: the daemon anchors with
   `call = payout(winner)`; quorum = both players' signatures.
6. Assert on L1: anchor recorded (epoch, height, root), pot paid to the
   winner, `payout` from a normal key rejected, anchor replay rejected.
7. Assert disposability: stop the app chain, delete its data dir — L1
   state (anchor + settled pot) is unaffected.

This is the MMORTS thesis in miniature: rules ran where the players
are, at their block interval, for ~zero fees; only ~100 bytes of
outcome touched L1; money moved only by quorum judgment.

---

## 4. Test matrix summary

| layer    | suite                                | proves                                    |
| -------- | ------------------------------------ | ----------------------------------------- |
| protocol | anchor/AppRecord roundtrips + golden | one canonical encoding, frozen bytes      |
| protocol | signing-bytes separation             | no cross-context signature reuse          |
| chain    | anchor execution unit tests          | quorum, epochs, binding, app-sender rules |
| chain    | rotation test                        | update_app governs the judging set        |
| appchain | cosigner + daemon over DHT testnet   | real collection + relay path              |
| appchain | season acceptance                    | the end-to-end feature                    |
| sdk/gw   | registry + `/api/app` shapes         | client surface                            |
| all      | existing 159 tests stay green        | nothing regressed                         |

## 5. Explicitly deferred

- Fraud/validity proofs; challenge windows live in _contracts_ (a
  `payout_after`/contest pattern), not the protocol.
- Validator rotation via anchored handoff (today: owner-gated).
- DSL-level outbox (`emit_l1(...)`) replacing the JS outcome callback.
- Merkle inclusion proofs against anchored roots (would enable L1
  verification of arbitrary app-chain state; nothing in v0.1 needs it).
- Bare-native VM (gas-instrumented wasm via the engine's own
  WebAssembly) so the chain runs inside the Pear process itself.
- Block-feed persistence (hypercore as the app chain's block store,
  MemoryStore + replay as state) — the natural next step for
  disposable chains.
