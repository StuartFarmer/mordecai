# App Chains

An **app chain** is the same chain stack that runs L1 — `Chain`,
`ConsensusEngine`, the VM, the DSL — instantiated _by an app's own peers_
with a per-app genesis (SPEC_APPCHAINS.md). It is not new infrastructure:
the node is a library, and an app chain is a second instantiation of it,
discovered over the same swarm (topic = genesis hash), exactly the way an
app instantiates a Hypercore feed.

That completes the state model. Ask of any piece of data: _who has to
agree to it?_

| who must agree?     | lane          | primitive                 |
| ------------------- | ------------- | ------------------------- |
| nobody (one author) | shared state  | hypercore feed            |
| the app's peers     | **app chain** | Chain + VM + DSL, per-app |
| everyone (money)    | L1            | the settlement chain      |

A feed answers "what did this peer say, in order?" — single writer, no
consensus needed. An app chain answers "what did the _group_ decide, in
order?" — the data structure you need the moment two players contend for
the same tile. L1 answers "what does everyone owe everyone?" An app chain
is, almost literally, a hypercore feed with a state machine and a referee
attached.

## Design invariants

1. **No value bridging.** Nothing mints on an app chain against an L1
   deposit. App-chain resources are native to it and die with it.
2. **Payments stay on L1.** The only cross-chain artifact is the
   **anchor**: a quorum-attested statement "our chain reached state root
   R at height H", optionally carrying one **outcome call**.
3. **L1 trusts exactly the app's registered quorum for that app's
   results, and nothing else.** The blast radius of a corrupt app chain
   is the pot voluntarily staked against it. No shared bridge, no pooled
   risk.
4. **Anchors make forgetting safe.** Once an epoch is anchored, the app
   chain's block history is disposable. The permanent record is ~100
   bytes on L1.
5. **Relayers are untrusted.** Anyone may submit an anchor transaction;
   the attestation signatures are the authority.

## How anchoring works

The registry entry (spec §17) carries the app chain's validator set
(`chainValidators`). From it, every joiner derives the same genesis —
`chainId = "app:" + appId`, validators, fee-float allocations — so the
genesis hash, which is the swarm topic, needs no coordination.

Each validator signs an **attestation** over
`anchorSigningBytes = domain ‖ l1ChainId ‖ appId ‖ epoch ‖ appHeight ‖
stateRoot ‖ call`, and only signs what its _own_ chain agrees with — a
local lookup, no proofs. Signatures from **more than 2/3** of the
registered set make an `anchor` payload, relayed to L1 inside an
ordinary fee-paying transaction. Execution verifies the quorum against
the registry, requires a strictly increasing epoch (replay protection),
records `an:<appId> → {epoch, appHeight, stateRoot}`, and — if an
outcome call is present — runs it with a special sender:

```
appAddress(appId) = BLAKE2b-256("hssn:app-sender:v1" ‖ appId)
```

A 32-byte account with no private key. Only an anchor quorum can act as
it, so a contract authorizes its app with one line of ordinary DSL:

```python
require(sender == config.game, "only the game may report")
```

No new DSL builtins, no host functions, no merkle proofs, no oracle. "The
app chain calls an L1 function" is literally what happens.

## Trust model, stated plainly

A quorum-signed state root gives _finality attestation_, not _validity_.
If an app's quorum colludes it can anchor a lie — and the damage is
confined to whatever was voluntarily staked against that app on L1
(invariant 3). Because execution is deterministic and blocks replicate
as feeds, anyone can replay and _detect_ a bad anchor; automated
adjudication (fraud proofs) is deliberately post-v1. Disputes and
challenge windows are **contract patterns**, not protocol features: hold
payouts N blocks, let a competing certificate freeze settlement.

Known v0.1 gap: co-signers vet the attested state root but not the
outcome call's semantics — a colluding quorum could mis-settle its own
app's escrow. Per-app call vetting on the co-signer is the next
hardening step.

## Lifecycle

Player-run chains are ephemeral by design. Spin a genesis per match or
season, run at game-speed block intervals for ~zero fees, anchor the
outcome, let the chain evaporate. L1 keeps the anchor and the
settlement; peers keep the block history exactly as long as anyone cares
to seed it — the same retention model as every other feed.
