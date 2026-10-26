# CLI Tools

Build with `pnpm build`. The unified entry point is `mordecai`, with `l1`
for settlement and `app` for application networks. From a checkout, use
`pnpm mordecai ...` or `node bin/mordecai.mjs ...`; linking the root package
makes `mordecai` available on PATH. Other tools retain their own commands.

```sh
mordecai --help
mordecai l1 --help
mordecai app --help
```

## Connect a node

Every connection starts chain sync, verification, storage, data serving,
and an HTTP gateway. The configured validator set determines the role:
**validators** also propose and vote; **peers** do everything else.

### Settlement (`mordecai l1`)

```sh
mordecai l1 connect --dir <path> --genesis <file> [--port <port>]
```

On first connection, creates `node.key` and saves the supplied genesis.
Subsequent connections reuse them; `--genesis` is then optional. Use the
network's exact genesis: its hash determines which peers you discover.

The lower-level commands remain available:

```sh
mordecai l1 init --dir <path> [--chain-id <id>] \
                  [--alloc <address>=<amount>]... [--validator <address>]...
mordecai l1 join --dir <path> --genesis <file>
mordecai l1 start --dir <path>
```

`init` creates a new network, defaulting to this node as its sole validator.
`join` prepares a directory for an existing network without starting it.
`start` resumes an initialized directory.

`l1 start` and `l1 connect` accept `--faucet-keystore <file>` to enable the
homepage's test CAI faucet. Set `MORDECAI_FAUCET_PASSPHRASE` in the process
environment and fund the dedicated wallet on that chain. The standalone gateway
(`node packages/gateway/dist/cli.js --node <rpc-key-hex>`) accepts the same flag.
Without it, the faucet is disabled. See [the field guide](../field-guide.mdx#faucet)
for funding and claim limits.

### App network (`mordecai app`)

```sh
# Direct discovery: no settlement RPC required
mordecai app connect --dir ./game --app http://192.168.1.20:8787
mordecai app connect --dir ./game --app 192.168.1.20:8787

# Named lookup: settlement RPC required
mordecai app connect --dir ./game --app com.example.game \
                     --settlement-node <rpc-key-hex>
```

`--app` accepts an explicit HTTP(S) URL, an IP address (optionally with a
port), or a registered app ID. IPv6 ports use brackets: `[::1]:8787`.
Domain URLs need a scheme; `game.example.com` alone is treated as an app ID.
URLs may include a gateway path prefix or the full `/api/connect` endpoint.
`--l1-node` remains an alias for `--settlement-node`; conflicting values fail.

Direct lookup fetches a bounded, validated connection document from the
peer's HTTP gateway. It never requires a settlement network or falls back
to one. Named lookup requires the settlement node explicitly and reads its
app registry. Optional settlement information in a peer document is only
metadata until an action such as `--anchor` uses it.

Both paths create or reuse `peer.key`, derive the same genesis, seed the
advertised app feeds, and start all services. Every joined app peer also
serves `/api/connect`. Registry lookup automatically includes the registered
bundle. Additional app data feeds can be supplied with repeatable
`--feed <hex-key>`. `start` is an alias for `connect`.

To prepare a validator identity before connecting:

```sh
mordecai app init --dir <path>
```

Include that public key in the app's local or registered validator set. The ordinary connect
command then votes automatically and answers `anchor_sign`. No role flag
is required. Preserve the data directory across restarts.

Both CLIs accept `--bootstrap host:port,...`, `--block-interval <ms>`,
`--static <frontend-dir>` and `--config <file.json>`. HTTP uses `--port`,
then the `PORT` environment variable, otherwise an available port. Startup
prints the role, RPC key and HTTP URL. HTTP binds all interfaces.

App validators may additionally use
`--anchor --l1-chain-id <id> --relayer <file> [--epoch-interval <ms>]`.
This relays state-root anchors using the funded relayer; application outcomes
still use the library's `AnchorDaemon.outcome` hook.

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
bootstrap address, node website URLs, and a funded faucet wallet (address + mnemonic).
Node 0 enables the homepage faucet. Data
lives in a fresh temp dir per run; Ctrl-C tears everything down.

## Repo scripts

```sh
pnpm build | test | lint | format      # workspace-wide
pnpm build:docs                       # refresh the book bundled with each node
./scripts/build-wasm.sh                # rebuild ALL wasm artifacts:
                                       #   VM runtime, Rust contracts,
                                       #   DSL examples → contracts/dist
python3 -m unittest discover compiler/tests   # DSL compiler unit tests
pnpm dev:site                         # Astro site/docs, live-reloading; node demo at :8790
```
