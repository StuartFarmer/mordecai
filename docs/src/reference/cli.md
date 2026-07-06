# CLI Tools

All CLIs live in package `dist/` directories after `pnpm build` (or via the
package `bin` entries). Examples below use `node <path>` form.

## `hssn-node` (`packages/node/dist/cli.js`)

```sh
hssn-node init  --dir <path> [--chain-id <id>] \
                [--alloc <address>=<amount>]... [--validator <address>]...
hssn-node start --dir <path> [--block-interval <ms>] [--bootstrap host:port,...]
```

`init` generates a node key (plaintext seed in `node.key` — an operational
validator key, not a user wallet) and writes `genesis.json`; with no
`--validator` flags the node itself is the sole validator (single-sequencer
mode). With **more than one genesis validator, `start` runs BFT consensus
automatically**; with one, the M3 sequencer loop. `start` prints the RPC
key that wallets/SDKs dial.

## `hssn-wallet` (`packages/wallet/dist/cli.js`)

```sh
hssn-wallet create   --keystore <path> [--force]
hssn-wallet address  --keystore <path>
hssn-wallet transfer --keystore <path> --to <address> --amount <n> \
                     --nonce <n> --chain-id <id> [--max-fee <n>]
```

The passphrase comes from `--passphrase`, `HSSN_WALLET_PASSPHRASE`, or a
hidden prompt. `create` prints the address and the 24-word mnemonic (write
it down — it is the only backup). `transfer` prints the signed canonical
transaction as hex plus its hash, ready for `submit_tx`.

## `hssn-launcher` (`packages/sdk/dist/launcher-cli.js`)

```sh
hssn-launcher install <appId> --node <rpc-key-hex> --out <dir> \
                      [--bootstrap host:port,...]
```

Registry lookup → swarm fetch → **verify against the on-chain hash** →
write `bundle.bin` + `app.json` (the registry entry) into `--out`. Refuses
on any hash mismatch.

## `hssnc` (`compiler/hssnc`, Python 3)

```sh
./compiler/hssnc check <contract.pysc>
./compiler/hssnc build <contract.pysc> -o <dir> [--wasm] [--runtime-path <p>]
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
