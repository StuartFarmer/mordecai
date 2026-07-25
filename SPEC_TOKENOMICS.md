# Validator Policy and CAI Emission — design draft v0.1

Status: **design, not implemented.** Nothing here is built. Numbers are
starting points for modelling, not settled parameters.

Covers four questions that turn out to be one question:

1. How do app chains get a **dynamic validator set**?
2. What is a good **L1 validator policy**?
3. Should CAI have an **emission**, and who gets it?
4. How does an app **bring its own validators** for its own chain?

They're one question because the architecture deliberately pushes activity
_off_ L1 — and that means L1's fee revenue is structurally small by design.
Whatever secures L1 has to be paid for some other way, and whatever secures
an app chain has to be imported, because an app chain has nothing of its own
worth stealing.

---

## 0. What we are actually trying to do

The constraints every proposal below has to respect, taken from the existing
system rather than invented here:

- **L1 is the only thing everyone must agree on.** Money, the registry,
  escrow. Everything else is somebody's private business.
- **App chains are disposable.** A season, a match, a game. Once anchored,
  the block history can evaporate and the outcome survives on L1.
- **The anchor carries judgment, not value.** ~100 bytes. There is no
  bridge, so a corrupt app chain can only touch what was voluntarily staked
  against it.
- **App-chain currency is valueless by design** (`APP_CHAIN_ALLOCATION` is
  a fee float, `packages/appchain/src/genesis.ts`). This is load-bearing:
  it means an app chain **cannot pay for its own security**, and it means
  there is nothing on an app chain worth a long-range attack _except_ what
  L1 escrow has riding on its anchors.
- **One Ed25519 identity everywhere.** The same key acts on L1 and every app
  chain.

The last two dictate almost everything in Parts III and IV.

---

## 1. Where we are today

Grounded in the current code, because two of these are load-bearing gaps.

| Property           | L1                            | App chain                                       |
| ------------------ | ----------------------------- | ----------------------------------------------- |
| Validator set      | `genesis.validators`, fixed   | `chainValidators` in the registry entry          |
| Set is decided by  | whoever wrote genesis         | the app owner (`update_app`)                     |
| Consensus quorum   | `floor(2n/3)+1`               | same                                             |
| Anchor quorum      | —                             | `anchorQuorum()`, `execution.ts:185`             |
| Entry / exit       | none                          | owner-gated rotation                             |
| Stake              | none                          | none                                             |
| Slashing           | none                          | none                                             |
| Rewards            | tx fees → proposer            | fees → proposer, in valueless currency           |
| Supply             | fixed at genesis              | fixed float                                      |

### 1.1 The rotation gap

`update_app` can rewrite `chainValidators` (`execution.ts:467`), and L1 will
then judge anchors against the **new** set — there's a test for exactly that
(`anchors.test.ts:230`, "update_app swaps the judging set").

But the running app chain's consensus set is read from its **derived
genesis**:

```
engine.ts:66    this.validators = options.chain.genesis.validators.map(decodeAddress)
appchain/genesis.ts    appChainGenesis(appId, chainValidators) → { chainId, validators, allocations }
node.ts         PeerHub.create({ topic: genesisHash(genesis) })
```

So after a rotation, three things are true at once:

1. **The live chain still runs the old set.** Its genesis is fixed; nodes
   don't re-read the registry. It can still produce blocks — but its anchors
   are now rejected by L1 (`anchor signer is not a registered validator`).
2. **A new joiner derives a different genesis**, because the validator set
   is an input to `encodeGenesis`. Different `genesisHash` → different swarm
   topic → it never meets the running mesh.
3. **Both forks share the same `chainId` string** (`app:${appId}`), so a
   transaction signed for one is replayable on the other.

The spec is honest that this is unfinished — "validator-set rotation by
anchor" is an explicit v0.1 non-goal and rotation is listed as owner-gated
(`SPEC_APPCHAINS.md:41-42, 378`). But the current state is worse than "not
implemented": rotation is a **silent chain-splitting operation** that looks
like it succeeded. Fixing that is the first milestone below, and it is a
prerequisite for every dynamic-set design.

### 1.2 The security-budget gap

Fees go to the block proposer (`execution.ts:354-358`), so L1 validators do
earn something. But the whole architecture is designed to keep activity off
L1: an app chain does thousands of moves and settles with one ~100-byte
anchor. **The better the design works, the less L1 earns.** A fixed supply
plus structurally-suppressed fee revenue is not a security budget. Part III
argues that's what emission is for.

---

## 2. Part I — Dynamic validator sets on app chains

### 2.1 The core mistake to undo

Chain **identity** is currently derived from chain **membership**. That is
what makes membership immutable: change the set and you have changed which
chain you are on.

**Separate them.**

```
today:     genesis = f(appId, validatorSet)   → topic = hash(genesis)
proposed:  genesis = f(appId, foundingNonce)  → topic = hash(genesis)
           validatorSet = in-chain state, epoch 0 seeded from the registry
```

The genesis commits to the app and a founding nonce (so an app can
deliberately start a _fresh_ chain — a new season — by bumping the nonce).
The validator set moves into chain state, where it can change without
changing the chain's identity or its swarm topic.

`foundingNonce` also gives us something we lack today: an explicit,
intentional way to start a new app chain for the same app, which is exactly
what "seasons get their own disposable chains" wants.

### 2.2 Rotation as an anchored handoff

The set changes by a normal in-chain transaction, committed by the current
set under normal BFT rules. But L1 must be able to follow the set without
replaying the app chain — it only ever sees anchors.

So extend the anchor to carry the handoff:

```
AnchorPayload {
  appId, epoch, appHeight, stateRoot, call?, signatures,
  validatorSetHash,          // the set that produced this anchor
  nextValidatorSet?          // present only on a rotation anchor
}
```

Rules on L1:

- An anchor is judged against the set L1 currently records for the app —
  which is the set installed by the **last accepted anchor**, not by
  `update_app`.
- A rotation anchor must be signed by a quorum of the **outgoing** set. The
  outgoing set is the authority for its own replacement. This is the
  standard handoff pattern and it is what makes the chain of sets verifiable
  from genesis by anyone holding only L1 data.
- `validatorSetHash` must match what L1 has recorded, which kills the
  ambiguity about which set signed.

Now L1 holds a verifiable chain of validator sets, each endorsed by its
predecessor, and a new peer can bootstrap the current set from the registry
without trusting anyone.

### 2.3 What `update_app` becomes

Owner-gated rotation has to stop being a direct write to the judging set,
because that is precisely the operation that forks the chain.

Two coherent options; I'd take (b):

**(a) Owner proposes, chain ratifies.** `update_app` writes a _pending_ set.
It takes effect only when the current set anchors a rotation to it. Keeps
owner control, removes the fork, but a dead validator set means the owner
can never recover the chain.

**(b) Owner controls policy, not membership.** `update_app` can only change
the app's **policy contract** (§5). Membership changes flow exclusively
through anchored handoff. Recovery from a dead set is handled explicitly by
a founding-nonce bump — start a new chain, seeded from the last anchored
state root, rather than pretending the old one continued.

(b) is more honest: a stalled chain is a real event and papering over it with
an owner override reintroduces the trusted party the architecture exists to
remove. It also makes "the app owner can steal the game" structurally
impossible, which matters once real escrow rides on anchors.

### 2.4 Joining, leaving, and churn

- **Minimum set size.** Below 4, BFT tolerates zero faults and the quorum
  math is degenerate. Refuse rotations that take a set below 4 unless the
  app opts into a documented single-operator mode.
- **Bounded churn per rotation.** Replacing more than ~1/3 of the set in one
  handoff lets an outgoing majority install an arbitrary successor. Cap it
  at 1/3 per epoch so any takeover spans multiple anchored epochs and is
  visible on L1 in between.
- **Cooldown.** One rotation per N epochs, so rotation can't be used to
  grind proposer selection.
- **Joining mid-life.** A new peer reads the current set + last anchored
  `(epoch, appHeight, stateRoot)` from L1, syncs from peers, and **checks
  the synced state root against the L1 anchor**. That check is what makes
  syncing from untrusted peers safe, and it's the same trick the launcher
  already uses (verify against the on-chain hash).
- **Exit.** A validator that stops signing is removed by the next rotation.
  If enough leave that quorum is unreachable, the chain is stalled by
  definition — see §2.3(b).

### 2.5 Long-range safety

Once sets rotate, an old set retains its keys forever and could sign an
alternative history from an old epoch. In a normal PoS chain this is the
weak-subjectivity problem. Here it is much easier, because **L1 is an
unforgeable checkpoint**:

- Epochs are strictly increasing per app and already enforced on L1.
- A joiner trusts the latest L1 anchor, not the longest app-chain history.
- Rewriting anchored history requires rewriting L1, which is the thing
  everybody agrees on.

So an app chain is only as re-writable as its **unanchored tail**. That is a
clean, explainable security boundary, and it argues for **short epochs when
value is at stake**: the tail is exactly the window of loss. An app should be
able to set its epoch interval and require an anchor before a high-value
settlement, rather than accepting a fixed 5s default.

---

## 3. Part II — L1 validator policy

### 3.1 Decentralization vs speed is not a tradeoff we have to make

This is the part of the design I feel most strongly about. Most chains agonise
over this because they run one chain for everything. We don't — we already
split the tiers:

```
app chain    300ms blocks, ~zero fees, small trusted-ish set, disposable
L1           slow, expensive, maximally decentralised, permanent
```

The speed already lives somewhere. So **L1 should refuse the tradeoff and
buy decentralisation with every parameter it has.** Every millisecond shaved
off an L1 block buys nothing the app-chain tier doesn't already provide, and
costs node diversity. Concretely:

- **Block time 2–5s, not 300ms.** 300ms is right for a game among ten peers
  on a LAN-ish swarm; it's an exclusionary hardware and bandwidth requirement
  for a global validator set.
- **Small blocks.** Anchors are ~100 bytes. An L1 that stays small is one a
  hobbyist can run on a home connection, and that is the entire point.
  Resist raising block size — it's the classic centralisation ratchet, and
  here we have an unusually strong argument against it, because the demand
  that would justify bigger blocks is supposed to go to an app chain instead.
- **Target set size ~100.** Big enough to be meaningfully distributed, small
  enough that BFT message complexity (O(n²) votes) stays sane at 2–5s.

The honest cost: L1 settlement feels slow. A market trade takes seconds, not
milliseconds. That's acceptable precisely because the game doesn't wait on it
— the outpost demo already shows the pattern, where play is instant on the
app chain and only settlement touches L1.

### 3.2 Proposed policy

- **Bonded proof-of-stake, permissionless above a floor.** Anyone bonding ≥
  the floor may enter; the top ~100 by stake form the active set.
- **Deterministic epoch rotation.** Set changes at epoch boundaries only
  (hours, not blocks), so light clients and app-chain peers can follow the
  set cheaply.
- **Unbonding period strictly longer than the longest anchor dispute
  window.** Otherwise a validator can exit before its misbehaviour becomes
  provable. This coupling between L1 unbonding and app-chain anchoring is
  easy to miss and it is the one parameter I'd nail down first.
- **Slashing, two tiers.** Equivocation (two signed votes, same height and
  round, different blocks) is objectively provable and should be severe —
  say 5–100% scaling with how much of the set equivocated together, which
  punishes coordinated attacks far harder than isolated bugs. Liveness
  failure gets a mild, non-slashing reward penalty; punishing downtime
  harshly mostly punishes people with bad internet, which is a
  centralisation pressure dressed as security.
- **No delegation at first.** Delegation is how stake concentrates into a
  handful of custodial pools in practice. Launching without it, and adding
  it only with explicit anti-concentration design, is worth the smaller
  initial set.

### 3.3 Centralisation concerns, stated honestly

- **Fees go entirely to the proposer today** (`execution.ts:354-358`). Under
  stake-weighted proposer selection that compounds: the largest validator
  proposes most often, earns most, and grows fastest. Splitting rewards
  between proposer and the attesters who actually formed the quorum is a
  meaningful mitigation, and it also pays for the work that provides safety
  rather than only the work that provides liveness.
- **Correlated identity.** One Ed25519 key everywhere is great UX and a
  concentration risk: the same operators will run L1 validators, app-chain
  validators, and gateways. A "decentralised" app chain whose five validators
  are five processes owned by one L1 whale is not decentralised. Policy
  contracts (§5) should be able to require **distinct bonded identities**,
  and we should assume operators will try to Sybil that.
- **Gateways are a real centralisation surface.** Browsers can't join the
  DHT, so every web user reaches the chain through somebody's gateway. They
  can't forge (transactions are signed, state is decoded client-side) but
  they can **censor and surveil**. Many independent gateways is a health
  metric worth tracking, not an implementation detail.
- **The registry is a namespace.** Whoever registers `com.example.outpost`
  owns it. Squatting and the eventual need for dispute resolution are
  governance problems we should choose deliberately rather than inherit.
- **Bootstrap centralisation.** Public DHT bootstrap nodes are a small set of
  hosts. Worth documenting as a known dependency.

---

## 4. Part III — CAI emission

### 4.1 Why emit at all

Because the architecture suppresses its own security budget. Every design
win — app chains, ~100-byte anchors, off-chain feeds — removes fee revenue
from L1. A fixed supply plus deliberately-minimal L1 activity means security
spend trends toward zero exactly as adoption grows. Emission is how we pay
for security in the years before settlement volume alone can.

It is a real cost: emission dilutes holders to pay validators. The argument
for it is that the alternative — funding security by pushing activity back
onto L1 — would destroy the thing that makes this design interesting.

### 4.2 Schedule

A decaying emission to a low perpetual tail:

```
year 1      ~5%  annualised, on circulating supply
decay       ~30% reduction per year
tail        ~0.5–1% in perpetuity
```

Rationale: high early emission buys a large validator set when fee revenue is
near zero; the tail keeps paying for security once it isn't, and avoids the
unsolved "fee-only security" question. A perpetual tail is mildly
inflationary and I'd rather have that than a security cliff.

**These numbers are placeholders.** They need modelling against a real
projection of validator operating costs and settlement volume before anyone
commits to them.

### 4.3 Distribution

Per block, split the emission:

- **~60% to the attesting quorum**, split evenly among validators whose votes
  are in the commit certificate — **evenly, not stake-weighted**, so
  emission mildly counteracts stake concentration instead of compounding it.
- **~30% to the proposer**, for liveness and the work of building the block.
- **~10% to an anchor rebate pool**, refunding relayers their anchor fees.

That last one is deliberate. Anchoring is the operation the whole
cross-chain settlement story depends on, it costs a relayer real CAI
(`AnchorDaemon` pays from a funded account), and nobody is compensated for
it. Rebating it makes reliable anchoring a paid public service instead of
something an app operator subsidises out of goodwill.

### 4.4 Sinks

Emission without sinks is just dilution. Candidate burns:

- **App registration and renewal** — also prices out namespace squatting.
- **A share of transaction fees burned** rather than paid to the proposer,
  which ties CAI value to settlement demand.
- **Contract deployment**, proportional to code size, which is a real
  ongoing cost to every full node.

Target: **net issuance approaching zero** as settlement volume grows, without
ever hitting a cliff.

---

## 5. Part IV — Bring-your-own validation for app chains

### 5.1 The fundamental asymmetry

An app chain's currency is valueless by design. So:

- There is nothing on an app chain to stake **that anyone cares about**.
- Its validators cannot be paid in its own currency in any meaningful sense.
- Its security must therefore be **imported from L1**, or it is social
  trust with extra steps.

The good news is that the exposure is already bounded: the anchor carries
judgment, not value, so a corrupt app chain can only ever touch what was
voluntarily staked against it. We aren't securing the app chain in the
abstract — only the L1 escrow riding on its anchors. **The security budget
of an app chain need only exceed what its anchors can move.** That is a much
easier target than "secure a blockchain", and it should be stated as the
design goal.

### 5.2 A policy contract per app

Let the registry entry point at an L1 **policy contract**, written in the
existing DSL. The protocol enforces the handoff mechanics (§2.2); the policy
contract decides who is eligible.

```
registry entry:  appId, owner, pearKey, version, contractAddress,
                 metadataHash, validatorSetHash, policyContract   ← new
```

On a rotation anchor, L1 asks the policy contract to approve the incoming
set. That single hook covers wildly different models without any of them
being special-cased in the protocol:

**(a) Owner-appointed** — policy returns true for whatever the owner signed.
Today's behaviour, now explicit rather than implicit. Fine for a hobby game.

**(b) Bonded open set.** Anyone bonding ≥ X CAI against the app may join;
equivocation proofs burn the bond. This is the workhorse: security scales
with the escrow at risk, and the app operator doesn't have to know or trust
the validators.

**(c) Player-elected.** Eligibility from in-game state — the season's top
players, or anyone holding a game asset. Reads naturally in the DSL and fits
games where the players _are_ the community.

**(d) Rented validation.** Professional operators advertise capacity; apps
pay per epoch from an L1 escrow. This is the one that makes small apps
viable, because a ten-player game cannot recruit its own validator set.

(d) plausibly becomes a real market: operators already running an L1
validator have the hardware, the identity, and the reputation to serve
dozens of app chains at near-zero marginal cost. That is a genuinely good
business and it is the most likely path to app chains being secure by
default rather than by effort.

### 5.3 Slashing without full fraud proofs

We do **not** need general execution fraud proofs to make bonding
meaningful, which is fortunate because those are a research project.

**Equivocation is cheap and objective.** Two attestations for the same
`(appId, epoch)` with different `stateRoot`, both signed by the same
validator, are a self-contained proof of misbehaviour. Anyone can submit the
pair to L1; L1 verifies two signatures and burns the bond. No app-chain
execution, no interactive game, no trusted party — this is enforceable with
the primitives that already exist.

That single condition covers the attack that actually matters: signing two
conflicting versions of a settlement. It does not cover a unanimous set
lying about state, which no proof system fixes without re-execution — for
that, the honest answer is (b)'s bond sizing plus §5.1's bounded exposure.

### 5.4 Paying app-chain validators

Not from app-chain currency, which is valueless. Options that work:

- **App revenue.** A cut of in-game L1 settlement into an escrow the
  validators claim per epoch — natural for the outpost goods market.
- **Player stakes.** Wagered seasons already escrow CAI on L1; a slice funds
  the validators for that season. The people who benefit from correct
  settlement pay for it.
- **Owner subsidy.** The operator funds it, like paying for hosting.
- **L1 anchor rebate** (§4.3), covering the relay cost specifically.

---

## 6. Risks and open questions

- **Emission parameters are guesses** until modelled against real operating
  costs. §4.2 is the least-supported section here.
- **Bond sizing for app chains is unsolved.** "Bond must exceed what the
  anchors can move" is right in principle, but the escrow at risk moves
  continuously while the bond is set in advance. Possibly the policy
  contract should cap settleable value as a function of the posted bond,
  which inverts the problem into something enforceable.
- **Anti-Sybil for distinct identities** (§3.3) has no clean answer. Bonding
  makes Sybils expensive but not impossible.
- **Governance is unspecified.** Who changes emission? A chain that needs a
  hard fork to retune inflation has a governance problem whether or not it
  admits it.
- **Rotation is a live footgun today** (§1.1) and should be fixed before
  anyone runs a real app chain, independently of everything else here.

## 7. Suggested build order

1. **Fix the rotation fork.** Decouple genesis from the validator set
   (§2.1), move the set into chain state, keep the swarm topic stable. Pure
   correctness work, no economics, unblocks everything else.
2. **Anchored handoff** (§2.2): extend the anchor, verify against the
   recorded set, chain of sets on L1.
3. **Policy contract hook** (§5.2) with owner-appointed as the default, so
   existing behaviour is preserved explicitly.
4. **Equivocation slashing** (§5.3) — small, self-contained, and the thing
   that makes bonds mean anything.
5. **L1 staking and set selection** (§3.2).
6. **Emission and sinks** (§4), last, once there's something to measure.

Steps 1–2 are prerequisites for a credible app-chain story at all. Steps 5–6
are where the economics need modelling rather than opinion.
