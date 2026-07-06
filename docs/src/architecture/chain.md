# The Settlement Chain

The chain is a deterministic trust engine shared by every application. It
maintains accounts, executes contracts, and nothing else — no file storage,
no app hosting, no media.

## Accounts and identity

An identity is an Ed25519 keypair. The address is the z32-encoded public
key (the same encoding hyperdht uses — one keypair works as wallet, feed
owner, and app login). An account is `{balance: u64, nonce: u64}`; the
nonce is a strictly sequential counter providing replay protection.

## Transactions

Five payload kinds:

| Payload            | Effect                                                       |
| ------------------ | ------------------------------------------------------------ |
| `transfer`         | move native currency                                         |
| `deploy_contract`  | store validated WASM; contract id = H(sender ‖ nonce ‖ code) |
| `execute_contract` | invoke an action, optionally attaching `value`               |
| `register_app`     | create an owner-gated registry entry                         |
| `update_app`       | new version/hash, only by the registering key                |

Every transaction carries `chainId` (cross-network replay protection),
`nonce`, `sender`, `maxFee`, and an Ed25519 signature over a
domain-separated canonical preimage.

### Lifecycle

```text
app builds payload → wallet signs → RPC submit_tx → mempool
  → gossip to validators → proposer includes it in a block
  → all validators execute identically → ≥2/3 vote → finalized
  → app polls waitForTx → receipt {success, fee, events, returnData}
```

### Inclusion vs execution failure

Two distinct failure levels, both deterministic:

- **Non-includable** (bad signature, wrong chain id, nonce mismatch,
  can't cover the fee reserve, invalid WASM): the transaction cannot appear
  in a valid block at all. Proposers drop it; a block containing one is
  itself invalid.
- **Execution failure** (insufficient balance, contract `require`/abort,
  out of fuel): the transaction _is_ included; its payload effects revert
  atomically, but the fee is charged and the nonce consumed — so a failed
  transaction can never be replayed.

## Fees

`fee = FLAT_FEE + bytes + ceil(fuelUsed / FUEL_PER_FEE)`, always ≤ `maxFee`,
paid to the block proposer. For contract calls, the sender's balance must
cover `maxFee + value` at inclusion; the unused reserve is refunded after
execution. A hard `MAX_FUEL` cap bounds worst-case execution regardless of
how high a fee the sender offers.

## Blocks and state commitment

A block header binds: height, previous-block hash, timestamp, proposer,
the Merkle root of its transactions, and the **state root** — a Merkle
commitment over the entire key-value state after execution. Every
validator recomputes the state root; any divergence is detected
immediately. Block 0's `prevHash` is the hash of the genesis config
itself, tying the whole history to the exact initial conditions.

Execution uses layered **overlays**: each block builds a write set over the
persistent store; each transaction gets a child overlay (discarded on
failure); each cross-contract call gets a grandchild. Commit is atomic per
block, and reopening a data directory verifies the stored state against the
head's state root.
