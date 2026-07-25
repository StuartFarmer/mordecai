# The SDK

`@mordecai/sdk` is the application-facing runtime (spec §22): one object that
gives an app its identity, payments, contracts, app distribution, and
replicated state.

```ts
import { Mordecai } from '@mordecai/sdk';

const app = Mordecai.connect({
  wallet, // any Signer: a local Wallet, or a RemoteSigner (see Identity)
  nodeKey, // RPC public key of any chain node (32 bytes)
  storageDir, // where this app's feeds live
  chainId, // e.g. 'mordecai-devnet'
  bootstrap, // optional; defaults to the public DHT
});
```

## Blockchain API

Every call signs with the next account nonce, submits over hyperswarm RPC,
and **waits for finality** — the returned `TxInfo` is a finalized receipt:

```ts
const r = await app.transfer(toAddress, 250_000n);
// r: { success, height, fee, events: hex[], returnData: hex, error? }

const { contractId } = await app.deploy(wasmBytes);

const r2 = await app.execute(
  contractId,
  'buy', // action (exported by the contract)
  new ContractArgs().u64(itemId).encode(), // args (see below)
  50_000n, // attached value (escrowed payment)
);

const acct = await app.account(); // { balance, nonce } as strings
```

A failed contract call returns `success: false` with the contract's abort
message in `error` — the fee was charged, but every state effect (including
attached value) was reverted.

### Argument encoding

`ContractArgs` matches the contract-side `ArgReader` and DSL parameters —
values in declaration order:

```ts
new ContractArgs().u64(id).address(pubkey).str('hello').bool(true).encode();
```

(u64 = 8 bytes LE; bool rides as u64 0/1; str/bytes are u32-length-prefixed;
address is a length-prefixed 32-byte key.)

## Identity API

```ts
const auth = await app.authenticate(challengeBytes);
// { address, publicKey, signature } — verify with @mordecai/crypto verify()
```

Use this for app-level login: the counterparty sends a fresh challenge, the
user's signature proves control of the address. Never reuse challenges.

## Shared-state API

```ts
const feed = await app.createFeed('chess-moves'); // writable, deterministic per name
await feed.append('e4');
await app.joinFeed(feed); // announce on the DHT

const theirs = await app.openFeed(key); // by 32-byte feed key
const move = await theirs.get(0); // requests + waits
```

## App distribution API

```ts
await app.publishApp({ appId, version, bundle }); // feed + on-chain registration
const { entry, bundle } = await app.installApp(appId); // fetched + hash-verified
```

Details in [Publishing & Installing Apps](publishing.md).

## Patterns

- **One `Mordecai` per app instance.** It owns a Corestore and an RPC session.
- **Sequential transactions per wallet.** Nonces are strictly ordered;
  `submit` queries the account nonce each time, so awaiting each call is
  the simple correct pattern.
- **Events are polled, not pushed** (v1): `waitForTx` polls the receipt.
  For app-to-app signaling, prefer feeds — that's what they're for.
