# RPC API

Every node serves RPC over **`@hyperswarm/rpc`**: clients dial the node's
public key through the DHT — no host/port, works across NATs. The typed
client is `NodeRpcClient` (`@mordecai/rpc`); the SDK wraps it further.

```ts
import { NodeRpcClient } from '@mordecai/rpc';
const rpc = NodeRpcClient.connect(nodeKeyBytes, { bootstrap });
```

Requests and responses are JSON envelopes (`{ok: true, result}` /
`{ok: false, error}`); u64 values travel as decimal strings, byte fields as
lowercase hex.

## Methods

### `get_head → HeadInfo`

`{ chainId, height, headHash, stateRoot, timestampMs }` — the finalized
head.

### `get_account { address } → AccountInfo`

`{ address, balance, nonce }`. Contract accounts work too (pass the
z32-encoded contract id).

### `submit_tx { tx: hex } → { hash }`

Canonical encoded signed transaction. Admission errors (bad signature,
nonce too low, fee reserve not covered, invalid WASM, duplicate) come back
as envelope errors. Success means _admitted_, not finalized — poll
`get_tx`. On consensus nodes, admission also gossips the tx to the mesh.

### `get_tx { hash } → TxInfo | null`

`{ hash, height, index, success, fee, events: hex[], returnData: hex,
error? }` — null until the transaction lands in a finalized block. The
client's `waitForTx(hash, {timeoutMs, intervalMs})` polls this.

### `get_block { height } → BlockInfo | null`

Header fields plus the canonical encoded transactions (hex) — decode with
`@mordecai/protocol` if you need their contents.

### `get_app { appId } → AppInfo | null`

`{ appId, owner, pearKey, version, contractAddress, metadataHash, chainValidators }` — the
registry entry that installs verify against.

### `get_apps { after?, limit? } → AppPage`

`{ apps: AppInfo[], nextAfter: string | null }` lists registered apps in
lexicographic UTF-8 byte order. `after` is an exclusive app-ID cursor; pass
`nextAfter` as the next request's `after`. The default page size is 50 and the
maximum is 100. App IDs and cursors must be nonempty and at most 64 UTF-8 bytes.
An empty page is a successful result. Pages read the current registry, so a
registration or update can change later requests.

Each page currently scans the full registry before sorting and slicing. This
is suitable for small registries; it is not an indexed archive or a stable
snapshot across requests.

### `get_app_anchor { appId } → AnchorInfo | null`

`{ appId, epoch, appHeight, stateRoot }` is the latest accepted settlement
anchor for the registered app chain.

## Client conveniences

```ts
const hash = await rpc.submitTx(encodeTransaction(tx));
const info = await rpc.waitForTx(hash, { timeoutMs: 30_000 });
const page = await rpc.getApps({ limit: 50 }, { timeout: 5000 });
```

Read calls `getHead`, `getBlock`, `getTx`, `getApp`, `getApps` and
`getAppAnchor` accept an optional final `{ timeout }` argument in milliseconds.
Omitting it preserves the transport's default behavior. This does not change
transaction-submission acknowledgement or rejection handling.

## Notes

- **Trust:** an RPC node can lie by _omission_ (hide a tx, stale head) but
  cannot forge state that contradicts consensus you verify elsewhere; run
  your own non-validator node if that matters to you.
- **Events are pull-based in v1** — no subscription stream yet; receipts
  carry events and `waitForTx` polls. Feeds are the push channel between
  apps.
