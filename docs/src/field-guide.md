# Field Guide

Six starting points, from your first peer to your first payment. Run these
examples from your Mordecai checkout in a POSIX shell. Keep your data
directories: they hold your node identities.

## Get the tools {#tools}

Install Node.js 20 or newer, pnpm 10, Git, curl, and mdBook 0.5.2. Then build
the checkout; the examples below use its CLI directly.

```sh
git clone https://github.com/StuartFarmer/mordecai.git
cd mordecai
pnpm install
pnpm build
pnpm mordecai --help
```

Ready when: help lists the `l1` and `app` command groups.

Already have a checkout? Run `pnpm install` and `pnpm build` there. The build
includes this book in every node's gateway; mdBook is only needed at build
time. Prebuilt WASM is included; Rust and Python are only needed to rebuild
contracts. See [Repository Layout & Building](reference/repo.md) for tooling.

## Join a network {#join-network}

Get the L1 network's exact `genesis.json` from its operator and save it in
your checkout. Its hash determines which network you join.

```sh
pnpm mordecai l1 connect \
  --dir ./my-node \
  --genesis ./genesis.json \
  --port 8787
```

Your node syncs, verifies, and serves chain data. Open `http://localhost:8787`
for its homepage and `http://localhost:8787/docs/` for this book. A key in the
genesis validator set also votes.

Keep this terminal open and use another for the next steps. After Ctrl-C,
repeat the command to resume. The saved identity and genesis are reused.
For a private DHT, add the operator's `--bootstrap host:port`.

### Starting your own L1 instead?

`init` creates a new network with this node as its default validator. It
does not join the network you are browsing.

```sh
pnpm mordecai l1 init --dir ./new-network --chain-id my-network
pnpm mordecai l1 start --dir ./new-network --port 8789
```

Add `--alloc <address>=<amount>` to `init` to fund an account in genesis.
Create its wallet first. Share `./new-network/genesis.json` with peers.

## Create a wallet {#wallet}

Create an encrypted keystore and choose a passphrase at the hidden prompt.
The wallet tool is a separate CLI.

```sh
node packages/wallet/dist/cli.js create --keystore ./wallet.json
node packages/wallet/dist/cli.js address --keystore ./wallet.json
```

You get an address and a 24-word recovery phrase. Save the phrase privately;
share only your address.

A new wallet starts unfunded. Receive funds from an existing holder or the
network operator before sending a payment. Wallet keys and node keys are
separate identities. See [Wallets, Identity & Sessions](apps/identity.md).

## Create an app network {#create-app}

An app chain can run independently of L1. First create its persistent
validator identity:

```sh
pnpm mordecai app init --dir ./my-app
```

`init` creates the key only. Save this complete starter as `app.mjs` in the
checkout root to start the first peer.

```js
import { readKeyFile } from './packages/node/dist/index.js';
import { AppChain } from './packages/appchain/dist/index.js';

const keyPair = readKeyFile('./my-app/peer.key');
const app = await AppChain.start({
  appId: 'com.example.world',
  chainValidators: [keyPair.publicKey],
  keyPair,
  dir: './my-app',
  gateway: { port: 8788 },
});

console.log(`App gateway: http://localhost:${app.node.gateway.port}`);
const stop = async () => {
  await app.stop();
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
```

Run it and leave the terminal open:

```sh
node app.mjs
```

Your single-validator app chain is reachable at port 8788. Share the
machine's reachable IP or domain with others; `localhost` only reaches
their own machine.

This creates the network. Your app's UI and contract rules are separate.
Registration on L1 is optional and currently uses the SDK's
`publishApp(...)`; there is no CLI publish command. For more, see
[How-To: Run Your App on Its Own Chain](apps/app-chains.md).

## Join an app {#join-app}

Replace the example URL with an existing app peer's gateway. Direct joining
needs no settlement node.

```sh
pnpm mordecai app connect \
  --dir ./joined-app \
  --app https://game.example.com
```

Your peer syncs the app chain, seeds its advertised data, and prints its own
gateway URL. Joining does not execute the app bundle.

To try the starter on the same machine, use `--app http://localhost:8788`.
Every joined app peer can introduce the next one.

### Join by a registered app ID

Use an L1 node's 64-character hexadecimal RPC key, printed at its startup.
An app ID needs a registry entry; the independent starter above does not
create one.

```sh
pnpm mordecai app connect \
  --dir ./registered-app \
  --app com.example.world \
  --settlement-node '<l1-rpc-key-hex>'
```

## Send a payment {#payments}

For a browser-only walkthrough, see [Account → Test CAI → Hex](examples/hex-web.md).
On the node demo, open **Account** to create or load an account, save its private
key, view balances, and send transactions. New accounts automatically receive
1,000,000 test CAI and app-chain fees. Registration is limited to one new account
per minute per visitor IP, and each account receives one grant. These records
survive restarts. Public faucet requests are disabled on the node demo.

The account page uses in-memory keys and unencrypted test backups, distinct from
the CLI keystore. Other gateways expose `/account.html` for loading an existing
key and sending transactions; `/wallet.html` remains a compatible address.

### Operator-enabled test faucet API {#faucet}

Other gateways can explicitly enable the legacy `POST /api/faucet` endpoint,
which accepts `{"address":"<public-address>"}`. It never needs a private key or
passphrase. Its default grant is 10,000 CAI base units, with a one-minute
address/IP cooldown and 100 claims per hour. Check the returned transaction
receipt before spending or requesting again if confirmation is uncertain.
This API is separate from node-demo account registration.

**Node operators:** create a separate wallet with the wallet CLI, fund its address
on your network, set `MORDECAI_FAUCET_PASSPHRASE` to that wallet's passphrase, then
add `--faucet-keystore ./faucet-wallet.json` when starting the node or standalone
gateway. For a new chain, `l1 init --alloc '<faucet-address>=1000000000'` can
fund it at genesis. An existing chain needs an ordinary transfer; editing its
genesis would create a different network. Keep this wallet separate from validator
keys and other spending wallets. Never place its secret in the public node config.

For this MVP, limits reset on restart and one faucet gateway must own the wallet.
The IP limit uses the socket address, so users behind the same reverse proxy
share a cooldown. Run `node apps/devnet/devnet.mjs` for a temporary funded faucet
on the first printed node gateway.

### Send from your wallet

Use your funded wallet and the intended L1 gateway. Run these steps in the
same terminal, from the checkout root. Replace values in angle brackets
before signing.

### Read the chain and your account

```sh
GATEWAY=http://localhost:8787
ADDRESS=$(node packages/wallet/dist/cli.js address --keystore ./wallet.json)
curl -fsS "$GATEWAY/api/head"
curl -fsS "$GATEWAY/api/account/$ADDRESS"
```

Use `chainId` from the head and `nonce` exactly as returned by your account.
Amounts and fees are integers in base units. This example sends 1,000 units
and sets a fee limit of 1,000; your balance must cover the amount and the
actual fee.

### Sign locally

```sh
node packages/wallet/dist/cli.js transfer \
  --keystore ./wallet.json \
  --to '<recipient-address>' \
  --amount 1000 \
  --nonce '<nonce>' \
  --chain-id '<chain-id>' \
  --max-fee 1000 > transfer.json
```

Enter your passphrase when prompted. Continue only if signing succeeds.
`transfer.json` contains the signed transaction and hash; no payment has
been submitted yet.

### Submit, then check the receipt

```sh
curl -fsS "$GATEWAY/api/tx" \
  -H 'content-type: application/json' \
  --data-binary @transfer.json
```

```sh
TX_HASH=$(node -p "require('./transfer.json').hash")
curl -sS "$GATEWAY/api/tx/$TX_HASH"
```

A returned hash means the node accepted your submission. The payment is
complete when its receipt reports `success: true`.

A 404 means this node has no receipt yet; wait and check again. If the
receipt says `success: false`, inspect `error`. Wait for the receipt and
re-read your nonce before the next payment. Only the signed transaction
goes to the gateway; your keystore and recovery phrase stay with you.
