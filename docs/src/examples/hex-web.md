# Account → Test CAI → Hex

One operator runs the demo network; players need only a browser and their own
account keys. The node site shares one account across all its demos.

## Run Hex inside the node site

```sh
pnpm build
node scripts/node-demo.mjs
```

Open `http://127.0.0.1:8790`. Choose **Account**, create an account and download
its private key, then wait for the automatic 1,000,000 test CAI grant. Choose
**Demos → Hex**. The same in-memory key signs game actions and L1 stakes;
no second key import is needed. Closing the account disconnects the demos.
Create a room and use **Copy room link** to invite a different account.

The Demos menu also opens [Frontier](frontier-web.md), [Outpost](outpost.md),
[Chess](chess.md), [Microblog](microblog.md), and [Bounties](bounties.md).
Frontier and Outpost each have one persistent shared world; Hex and Chess use
invitation rooms. Public users reach one HTTP origin; the Hex app API is mounted
at `/api/demos/hex/api/`.

The launcher stores identities, chain data, signed deployment records and account
registration records in `.mordecai-demo/` (git-ignored). Restart with that directory
to resume balances, rooms, contracts and registration limits. Back it up privately:
it contains unencrypted operator test keys with restrictive permissions. Run only
one host per data directory. Keep the same contract binaries and timeout settings;
changed bootstrap payloads fail explicitly rather than redeploying silently.

Use `PORT=8805 DEMO_DIR=/path/to/demo node scripts/node-demo.mjs` to choose the
HTTP port and data directory. This starts a persistent local test network; it
does not attach to a different running preview chain. For public HTTPS, terminate
TLS in front of this HTTP origin and keep the process/data directory persistent.

## Create and back up an account

Click **Create account**. The browser generates an Ed25519 key locally and displays
its public address. Click **Download private key** before leaving the page.

The JSON backup contains an **unencrypted private key**. Keep it private and use
this account only for test tokens. Reloading or closing the page clears its
in-memory key. Registration sends only a public key and signed proof; the server
never receives your private key. **Show private key** reveals its 64 hexadecimal
characters when needed.

To return, load the JSON backup or paste the private key. Both a 32-byte Ed25519
seed (64 hex characters) and a 64-byte libsodium secret key (128 hex characters)
are accepted; the latter's public-key half is verified. Existing web-wallet
backups still work. This backup is distinct from the CLI's encrypted keystore;
mnemonic and encrypted CLI-keystore import are not implemented.

## Automatic test funding

Each new account receives **1,000,000 test CAI** on L1, plus separate Hex and
Outpost app-chain fee balances. The grant is one-time per address. Loading an
account does not issue more tokens, and there is no public faucet tab or claim
endpoint on the node demo.

New registrations are limited to **one per minute per visitor IP**. Two browsers
sharing an IP must wait a minute between registrations. The server enforces the
limit and persists it across restarts. Private keys can still be generated offline;
the limit applies to registering and funding a new account on this demo.

If funding is interrupted, keep the same private key and use **Retry account
registration**. The server reuses its recorded transfers so retries cannot issue
a second grant. Loading an account with pending funding restores this retry action.
Funding reserves are finite; the operator must replenish them when depleted.

## Send tokens or submit a transaction

On the standard node site, choose **Account** in the top navigation (`/#/account`).
Navigation keeps the loaded key in memory. Account shows the create/load controls
until an account is open. **Close account** clears its draft and returns to those
controls. Documentation, API, and GitHub open separately. Other gateways expose
the account page at `/account.html`; the old `/wallet.html` address still works.

After funding, enter a recipient address and a whole number of CAI base units
under **Send CAI**. Choose **Review transfer**, check the network, recipient,
amount, and maximum fee, then **Confirm and send**. The 1,000-unit fee ceiling
must fit in your balance alongside the amount; the receipt shows the actual fee.

To sign another transaction with the loaded account, expand **Sign and submit a
transaction**. Paste an unsigned hexadecimal payload and set its maximum fee.
The account page supplies the network, sender, nonce, and signature; review the decoded
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
The account page checks the payload format and funds; the node validates the contract
call. Failed execution may still charge a transaction fee.

The session list tracks submissions until a receipt reports confirmation or
failure. If the response is lost, keep the tab open and use **Retry the same
transaction**: it sends identical bytes. Do not create another payment merely
because confirmation is delayed. History and pending state clear on reload.

## Play with a second account

1. Player A enters a new game code, such as `my-first-hex`, and clicks **create
   game**. The default stake is 100,000 test CAI units on L1.
2. Player B opens the same site in another browser/profile or on another machine,
   creates a **different** account, and enters the same code. Click **join game**
   to match the stake. Two copies of the same private key are the same player.
3. Red moves first. Click an empty hexagon on your turn. Red connects top to
   bottom; blue connects left to right.
4. When a player connects their edges, the browser submits the winning path.
   Alternatively, resign to test settlement quickly. A player who takes more
   than three minutes forfeits when the opponent's browser claims the timeout.
5. Wait for **pot paid out on L1**. The anchor daemon carries the game outcome
   to L1, which pays the winner's address. Refresh that account's L1 balance.

For another player on a different machine, replace `127.0.0.1` with the host's
reachable address. The integrated node demo exposes one HTTP port, including its app APIs.
Use an HTTPS reverse proxy for public hosting; see [Render](../render.md).

## What carries between networks?

Your private key determines one public address, usable on multiple chains.
**Balances, transaction nonces, and game state belong to each chain separately.**
Funding `mordecai-preview` does not fund `mordecai-hex-devnet`, even with the same
address. There is no token bridge in this walkthrough. The Hex app chain's fee
float is separate from the L1 CAI escrow and is valueless by design.

The integrated Frontier and Outpost demos share this account and settlement L1.
Their standalone scripts retain the separate Alice/Bob development-account mode.
New account registration also funds Outpost app-chain fees automatically.

## Standalone Hex development fixture

```sh
pnpm build
pnpm --filter @mordecai/example-hex-web build
node scripts/hex-demo.mjs
```

This separate fixture runs Hex at `http://127.0.0.1:8787`, its app API at port
8788, and a legacy development faucet at port 8789. Set `PORT=8800` to move the
three adjacent ports. It persists its network in its demo data directory.

Use Hex's own account chooser to generate or import a key; **Use saved Hex
account** loads a legacy saved key. New keys remain in memory, so back them up.
This fixture's faucet automatically supplies 10,000,000 L1 units and
1,000,000,000 app-chain fee units when balances are low. It is intended for a
trusted local development network. Public deployments should use
`scripts/node-demo.mjs`, whose public faucets are disabled and whose account
registration is rate limited.
