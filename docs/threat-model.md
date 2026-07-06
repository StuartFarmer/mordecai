# Threat Model (v1, first pass)

Scope: the v1 platform as defined in `IMPLEMENTATION_PLAN.md` — a
fixed-validator settlement chain running over Holepunch, WASM contracts, and
Pear applications with wallet integration. This document tracks what each
layer trusts, what it must defend against, and which gaps v1 knowingly ships
with. It follows the security boundaries in SPEC_PT_03 §26.

## Assets

- **Private keys** — user wallets, validator keys, app developer keys.
- **Economic state** — balances, contract storage, the app registry.
- **Consensus integrity** — one canonical, final block history.
- **Application authenticity** — the bundle a user installs is the bundle the
  registered developer signed.
- **Availability** — the chain keeps producing blocks; apps keep working
  peer-to-peer even when the chain is unreachable.

## Trust boundaries

### Identity / signatures

Every state transition is a signed transaction. Nothing unsigned is accepted.

- Signing preimages are domain-separated (`hssn:tx:v1`, `hssn:block:v1`,
  `hssn:vote:v1`) so bytes signed for one purpose can never validate as
  another.
- `chain_id` in every signed message prevents cross-network replay; per-sender
  nonces prevent same-network replay.
- Canonical encoding (one valid byte form per structure, enforced on decode)
  prevents malleability: a third party cannot produce a second valid encoding
  of a signed message.

### Consensus

- Safety assumption: fewer than 1/3 of the fixed validator set is Byzantine.
  With ≥ 2/3 pre-commits required for finality, two conflicting blocks cannot
  both finalize under that assumption.
- Every validator re-executes every transaction; a proposer cannot invent
  state. State roots are cross-checked; divergence is detectable immediately.
- Proposer timestamps are bounded by consensus rules and never read by
  contract execution (no wall-clock in the deterministic path).

### Contracts (WASM sandbox)

- Deterministic instruction set only: modules containing float opcodes are
  rejected at deploy; no clock, randomness, network, or filesystem host
  functions exist.
- Fuel metering bounds execution; memory, call-depth, and storage-size caps
  bound resources. Out-of-fuel is a deterministic failure, identical on every
  validator.
- Storage isolation: a contract can write only its own namespace. Cross-
  contract effects happen only via message passing (`call`), and the callee
  enforces its own rules.

### Applications / wallet

- Applications are trusted only by the user running them (§26). They never
  hold keys. They request signatures through the wallet, which mediates with
  per-app session permissions; payment-signing requires explicit user
  approval. "Auto-authenticate" must never mean "auto-sign."
- The registry binds `app_id → pear_key → developer key`. Installation
  verifies the bundle signature against the registry entry, not against
  whatever peer served the bytes.

### Networking (Holepunch)

- Hypercore guarantees feed authenticity and append-only history; it
  guarantees nothing about economic truth. No node treats gossip content as
  valid until signatures and consensus rules check out.
- Transport is encrypted (Noise); peers are identified by public key, not IP.

## Adversaries considered in v1

| Adversary                  | Vector                                   | Mitigation                                                                  |
| -------------------------- | ---------------------------------------- | --------------------------------------------------------------------------- |
| Malicious peer             | Sends malformed/oversized messages       | Strict canonical decode, hard size limits, per-peer backoff                 |
| Malicious tx author        | Replay, malleability, fee griefing       | Nonces, chain_id, canonical encoding, max_fee + fuel accounting             |
| Malicious proposer         | Invalid block, bad timestamp, censorship | Full re-execution by all validators, timestamp bounds, round-robin rotation |
| < 1/3 Byzantine validators | Equivocation, vote withholding           | 2/3 finality threshold; liveness degrades but safety holds                  |
| Malicious contract         | Resource exhaustion, storage escape      | Fuel/memory/depth caps, namespace isolation, float rejection                |
| Malicious app              | Phishing signatures, draining wallet     | Wallet-mediated signing, per-app permissions, explicit payment approval     |
| Fake app distributor       | Serving a tampered bundle                | Registry-anchored developer signatures verified before launch               |

## Known gaps accepted in v1 (must be revisited)

1. **≥ 1/3 Byzantine validators** breaks safety; the validator set is static
   and permissioned. Staking/rotation/slashing are post-v1.
2. **No fee market** — flat fees; a funded spammer can fill blocks. Mempool
   per-sender caps are a stopgap.
3. **Network-level DoS** on the DHT/swarm (eclipse, sybil peers) is mitigated
   only by validator-to-validator direct connections, not solved.
4. **Key recovery** — mnemonic backup only; no social recovery or rotation of
   a compromised wallet key.
5. **Privacy** — all economic state is public; no confidentiality goals in v1.
6. **Light clients** trust the block-log Hypercore feed plus quorum
   signatures; no fraud/validity proofs yet.

Each gap should either be closed or explicitly re-accepted at every subsequent
milestone review.
