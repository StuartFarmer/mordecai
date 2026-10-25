# Web wallet → faucet → Hex

Hex is the example for bringing your own browser wallet. One operator runs the
demo network; players only need a browser and their own test-wallet keys.

## Run Hex inside the node site

```sh
pnpm build
node scripts/node-demo.mjs
```

Open `http://127.0.0.1:8790`. Create/load a wallet, use the **Faucet** tab,
then choose **Demos → Hex**. The same in-memory wallet signs game actions and
L1 stakes; no second key import is needed. Closing it in Wallet disconnects Hex.
Create a room and use **Copy room link** to invite another player with a different
wallet. A fresh visitor can join from that link. The same Demos menu also opens
[Frontier](frontier-web.md), [Outpost](outpost.md), and [Chess](chess.md), using
the loaded wallet. Frontier and Outpost each have one persistent shared world;
Chess uses invitation rooms.

The node-demo L1 faucet grants 10,000,000 base units, enough for the default
1,000,000-unit stake plus fees. Hex requests app-chain fee tokens separately.
The existing address/IP cooldown applies, so two browsers sharing an IP must
wait a minute between faucet claims. Public users reach one HTTP origin; the
app API is mounted at `/api/demos/hex/api/`.

The launcher stores identities, chain data and signed deployment records in
`.mordecai-demo/` (git-ignored). Restart with that directory to resume balances,
rooms and contracts. Back up the directory privately: it contains unencrypted
operator test keys with restrictive file permissions. Do not run two hosts on
one data directory. Keep the same contract binaries and timeout configuration;
changed bootstrap payloads fail explicitly rather than redeploying silently.

Use `PORT=8805 DEMO_DIR=/path/to/demo node scripts/node-demo.mjs` to choose the
HTTP port and data directory. This starts a persistent local test network; it
does not attach to a different running preview chain. For public HTTPS, terminate
TLS in front of this HTTP origin and keep the process/data directory persistent.
No domain or public deployment is configured by this command.

## Start the standalone demo

From the repository root:

```sh
pnpm build
pnpm --filter @mordecai/example-hex-web build
node scripts/hex-demo.mjs
```

The script starts a fresh three-validator L1, a two-validator Hex app chain,
contracts, faucets, and settlement. It prints these default URLs:

| Service                     | URL                                 |
| --------------------------- | ----------------------------------- |
| Hex game                    | `http://127.0.0.1:8787`             |
| Web wallet on Hex's L1      | `http://127.0.0.1:8787/wallet.html` |
| App-chain API               | `http://127.0.0.1:8788`             |
| Demo faucet for both chains | `http://127.0.0.1:8789`             |

To choose different ports, use `PORT=8800 node scripts/hex-demo.mjs`; the app API
and demo faucet use the next two ports. Leave the terminal running. Ctrl-C stops
the demo. Each restart creates a new network with fresh balances and games.

## 1. Create and back up a wallet

Open the **web wallet on the Hex gateway** and click **Create wallet**. The
browser generates an Ed25519 key and displays its public address. Click
**Download private key** before leaving the page.

The JSON backup contains an **unencrypted private key**. Keep it private and use
this wallet only for test tokens. The page holds the key in memory; reloading or
closing it clears the loaded wallet. Neither the gateway nor the faucet receives
your key. The explicit Show private key button reveals its 64 hexadecimal
characters when needed.

To return to an existing wallet, load its JSON backup or paste the private key.
Both a 32-byte Ed25519 seed (64 hex characters) and a 64-byte libsodium secret key
(128 hex characters) are accepted. The latter's public-key half is verified.
This web backup is distinct from the CLI's encrypted keystore; mnemonic and
encrypted CLI-keystore import are not implemented.

## 2. Claim test CAI

Open the **Faucet** tab; it is pre-filled with your loaded wallet’s public address. Click **Get test CAI**,
wait for **Transfer confirmed**, and check that the balance increased by 10,000
base units. View transaction opens the receipt.

This generic faucet has a one-minute address/IP cooldown and a 100-claim hourly
limit. Its funds are on **Hex's L1 network** because you opened the wallet from
that gateway. A wallet opened on another node reads and funds that node's network.

## Send tokens or submit a transaction

On the standard node site, choose **Wallet** in the top navigation (`/#/wallet`).
Home/Wallet/Faucet navigation keeps the loaded key in memory. Wallet shows the create/load controls until a wallet is open. **Close wallet** clears its draft and returns to those controls. Documentation, API, and
GitHub open separately. Custom demo sites expose the same wallet at `/wallet.html`.

After funding, enter a recipient address and a whole number of CAI base units
under **Send CAI**. Choose **Review transfer**, check the network, recipient,
amount, and maximum fee, then **Confirm and send**. The 1,000-unit fee ceiling
must fit in your balance alongside the amount; the receipt shows the actual fee.

To sign another transaction with the loaded wallet, expand **Sign and submit a
transaction**. Paste an unsigned hexadecimal payload and set its maximum fee.
The wallet supplies the network, sender, nonce, and signature; review the decoded
details and choose **Confirm and send**. The payload supports every protocol
transaction type. This field takes payload bytes, not a complete signed transaction.

For example, prepare a contract-call payload in a script using the protocol package:

```js
import { encodePayload } from '@mordecai/protocol';

const payload = encodePayload({
  kind: 'execute_contract',
  contract: Buffer.from(contractAddressHex, 'hex'),
  action: 'play',
  args: encodedActionArguments, // Uint8Array in the contract's expected format
  value: 0n,
});
console.log(Buffer.from(payload).toString('hex'));
```

Use the actual contract address, action, and encoded arguments from your dapp.
The wallet checks the payload format and funds; the node validates the contract
call. Failed execution may still charge a transaction fee.

The session list tracks submissions until a receipt reports confirmation or
failure. If the response is lost, keep the tab open and use **Retry the same
transaction**: it sends identical bytes. Do not create another payment merely
because confirmation is delayed. History and pending state clear on reload.

## 3. Load the same wallet into Hex

Click **Back to node or game**, then load the downloaded JSON file in Hex's
wallet chooser. You can also paste the same private key. Check that the address
matches your web wallet. Existing Hex users can choose **Use saved Hex wallet**;
their legacy saved key is preserved. New imported or generated keys are kept in
memory, so load them again after refreshing.

Hex's separate demo faucet automatically supplies the larger test amounts needed
for this game: 10,000,000 L1 units and 1,000,000,000 app-chain fee units when either
balance is low. Wait for the funding message before creating or joining a game.
The two faucets use separate funded wallets, so they do not share transaction
nonces. The old demo faucet is a local demonstration service, not a hardened
public faucet.

## 4. Play with a second wallet

1. Player A enters a new game code, such as `my-first-hex`, and clicks **create
   game**. The default stake is 1,000,000 test CAI units on L1.
2. Player B opens the same site in another browser/profile or on another machine,
   creates a **different** wallet, and enters the same code. Click **join game**
   to match the stake. Two copies of the same private key are the same player.
3. Red moves first. Click an empty hexagon on your turn. Red connects top to
   bottom; blue connects left to right.
4. When a player connects their edges, the browser submits the winning path.
   Alternatively, resign to test settlement quickly. A player who takes more
   than three minutes forfeits when the opponent's browser claims the timeout.
5. Wait for **pot paid out on L1**. The anchor daemon carries the game outcome
   to L1, which pays the winner's address. Refresh that wallet's L1 balance.

For another player on a different machine, replace `127.0.0.1` with the host's
reachable address. This demo uses HTTP and adjacent ports; expose it only on a
trusted test network. Public HTTPS hosting needs matching routes for the app API
and demo faucet as well.

## What carries between networks?

Your private key determines one public address, usable on multiple chains.
**Balances, transaction nonces, and game state belong to each chain separately.**
Funding `mordecai-preview` does not fund `mordecai-hex-devnet`, even with the same
address. There is no token bridge in this walkthrough. The Hex app chain's fee
float is separate from the L1 CAI escrow and is valueless by design.

The integrated Frontier and Outpost demos share this wallet and settlement L1.
Their standalone scripts retain the separate Alice/Bob development-account mode.
Outpost has its own app-chain fee faucet; use **Fund app fees** inside Outpost
before claiming land or delivering goods.
