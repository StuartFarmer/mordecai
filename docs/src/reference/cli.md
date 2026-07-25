# CLI Tools

All CLIs live in package `dist/` directories after `pnpm build` (or via the
package `bin` entries). Examples below use `node <path>` form.

## `mordecai-node` (`packages/node/dist/cli.js`)

```sh
mordecai-node init  --dir <path> [--chain-id <id>] \
                [--alloc <address>=<amount>]... [--validator <address>]...
mordecai-node join  --dir <path> --genesis <file>
mordecai-node start --dir <path> [--block-interval <ms>] [--bootstrap host:port,...]
```

`init` generates a node key (plaintext seed in `node.key` — an operational
validator key, not a user wallet) and writes `genesis.json`; with no
`--validator` flags the node itself is the sole validator (single-sequencer
mode). With **more than one genesis validator, `start` runs BFT consensus
automatically**; with one, the M3 sequencer loop. `start` prints the RPC
key that wallets/SDKs dial.

`join` is `init` for an **existing** network: it mints a node key but takes
the genesis from the network's own `genesis.json` instead of writing one.
Both commands print the `genesisHash` — that hash is the swarm topic, so
compare it against the network's before starting; a mismatch doesn't error,
it silently puts you on an empty mesh of one. `join` also reports whether
the new key landed in the validator set (`validator`) or not (`follower`),
the latter being the normal case for a replica.

## `mordecai-peer` (`packages/appchain/dist/cli.js`)

```sh
mordecai-peer keygen --dir <path>
mordecai-peer start  --dir <path> --app <appId> --l1-node <rpc-key-hex> \
                 [--bootstrap host:port,...] [--block-interval <ms>] \
                 [--anchor --l1-chain-id <id> --relayer <file> [--epoch-interval <ms>]]
```

An always-on peer on one app's chain. `keygen` writes `peer.key` and prints
the public key that belongs in the app's registered validator set — run it
**before** `register_app`, since that set is what the genesis is derived
from.

`start` reads the registry entry from L1, derives the app-chain genesis
from it, and runs the node: a key in the set produces blocks and answers
`anchor_sign`, anything else follows and serves reads. It syncs the **app
chain only** — its sole L1 contact is an RPC client. `--anchor` adds an
[`AnchorDaemon`](../architecture/app-chains.md) relaying state roots to L1
under `--relayer`'s account; outcome calls are app-specific and still need
the library's `outcome` hook.

## `mordecai-wallet` (`packages/wallet/dist/cli.js`)

```sh
mordecai-wallet create   --keystore <path> [--force]
mordecai-wallet address  --keystore <path>
mordecai-wallet transfer --keystore <path> --to <address> --amount <n> \
                     --nonce <n> --chain-id <id> [--max-fee <n>]
```

The passphrase comes from `--passphrase`, `MORDECAI_WALLET_PASSPHRASE`, or a
hidden prompt. `create` prints the address and the 24-word mnemonic (write
it down — it is the only backup). `transfer` prints the signed canonical
transaction as hex plus its hash, ready for `submit_tx`.

## `mordecai-launcher` (`packages/sdk/dist/launcher-cli.js`)

```sh
mordecai-launcher install <appId> --node <rpc-key-hex> --out <dir> \
                      [--bootstrap host:port,...]
```

Registry lookup → swarm fetch → **verify against the on-chain hash** →
write `bundle.bin` + `app.json` (the registry entry) into `--out`. Refuses
on any hash mismatch.

## `mordecaic` (`compiler/mordecaic`, Python 3)

```sh
./compiler/mordecaic check <contract.pysc>
./compiler/mordecaic build <contract.pysc> -o <dir> [--wasm] [--runtime-path <p>]
```

See the [DSL reference](../contracts/dsl-reference.md).

## Devnet launcher (`apps/devnet/devnet.mjs`)

```sh
node apps/devnet/devnet.mjs [validators=4]
```

In-process DHT testnet + N consensus validators; prints RPC keys, the DHT
bootstrap address, and a funded faucet wallet (address + mnemonic). Data
lives in a fresh temp dir per run; Ctrl-C tears everything down.

## Repo scripts

```sh
pnpm build | test | lint | format      # workspace-wide
./scripts/build-wasm.sh                # rebuild ALL wasm artifacts:
                                       #   VM runtime, Rust contracts,
                                       #   DSL examples → contracts/dist
python3 -m unittest discover compiler/tests   # DSL compiler unit tests
mdbook serve docs                      # this book, live-reloading
```
