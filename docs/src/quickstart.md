# Quickstart

Requirements: Node ≥ 20 with corepack. Rust (with the
`wasm32-unknown-unknown` target) and Python 3 are only needed if you want to
rebuild WASM artifacts or compile DSL contracts — prebuilt artifacts are
committed.

```sh
git clone <repo> && cd zechariah
pnpm install
pnpm build        # typecheck + emit all packages
pnpm test         # the full suite: 150+ tests incl. multi-validator devnets
```

## 1. Run a local devnet

```sh
node apps/devnet/devnet.mjs 4
```

This spins up an in-process DHT testnet and four consensus validators, and
prints:

```text
node-0  rpc key: f414d2a9d2a1…      ← dial any of these over the DHT
faucet address:   rb6rdrgkf19z…
faucet mnemonic:  video cheese twice …   ← a funded wallet for playing
dht bootstrap:    127.0.0.1:49737
```

Leave it running. Everything below talks to it via the printed bootstrap
address and RPC keys.

## 2. Create a wallet and move money

```sh
export Mordecai_WALLET_PASSPHRASE=dev
node packages/wallet/dist/cli.js create --keystore alice.json
node packages/wallet/dist/cli.js address --keystore alice.json
```

Sign a transfer (the CLI prints the canonical signed transaction as hex):

```sh
node packages/wallet/dist/cli.js transfer \
  --keystore alice.json --to <address> --amount 1000 \
  --nonce 0 --chain-id mordecai-devnet
```

Programmatic submission goes through the SDK (next step) or the RPC client;
see [CLI Tools](reference/cli.md) for the full command reference.

## 3. Talk to the chain from code

```js
import { Mordecai } from '@mordecai/sdk';
import { Wallet } from '@mordecai/wallet';

const { wallet, mnemonic } = Wallet.create(); // or Wallet.fromMnemonic(faucet)
const app = Mordecai.connect({
  wallet,
  nodeKey: Buffer.from('<rpc key hex>', 'hex'),
  storageDir: './app-data',
  chainId: 'mordecai-devnet',
  bootstrap: [{ host: '127.0.0.1', port: 49737 }],
});

const receipt = await app.transfer('<address>', 250_000n);
console.log(receipt.success, receipt.height); // finalized, with block height
```

## 4. Deploy a contract written in Python-like DSL

```sh
./compiler/mordecaic check compiler/examples/chess_wager.pysc
./compiler/mordecaic build compiler/examples/chess_wager.pysc -o build/wager --wasm
```

```js
const { contractId } = await app.deploy(wasmBytes);
await app.execute(contractId, 'create', new Uint8Array(0), 100_000n); // 100k stake attached
```

## 5. Run the flagship example

The chess app plays a full wagered match — escrow on-chain, every move
peer-to-peer — in under two seconds:

```sh
pnpm vitest run apps/chess
```

From here: read [What a P2P App Is (and Isn't)](apps/what-is-a-p2p-app.md)
before designing your app — the on-chain/off-chain split is the one decision
that shapes everything else.
