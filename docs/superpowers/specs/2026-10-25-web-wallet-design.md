# Simple web wallet and Hex walkthrough

Implement the user's requested browser key generation/import wallet and an
end-to-end path through faucet funding and a demo game. Use Hex, which already
supports visitor-controlled browser identities and funding on two chains;
Frontier and Outpost still use predefined demonstration accounts.

## Scope and implementation choices

- Serve `/wallet.html` (with `/wallet` redirect) on ordinary and custom-app
  gateways. Link it from the homepage and Hex. Preserve existing app routes.
- Generate Ed25519 keys locally using browser randomness. Load a raw 32-byte
  seed or verified 64-byte libsodium secret key, or an exported wallet JSON file.
- Show public address and balance on this gateway's network, allow explicit
  private-key reveal, download and close, and prefill the existing faucet form.
- Keep newly loaded keys in memory, never in URLs, HTTP requests, or browser
  storage. Backups are explicitly labeled unencrypted test-wallet files. Warn
  before discarding an unbacked generated/imported key. Do not claim support for
  the CLI's encrypted keystore format or mnemonic import.
- Share address derivation, key parsing and signing with Hex via a browser-only
  export of the existing wallet package; reuse installed noble Ed25519 and z32.
- Hex can import the same backup/private key, or create a temporary wallet.
  Preserve existing legacy Hex identities without overwriting their saved keys.
- Enable the generic faucet on the Hex gateway with its own separately funded
  wallet. Hex's existing dual-chain faucet supplies the larger stake and app fee
  grants needed by the game. Do not share spending nonces between faucet services.
- Explain that identical addresses do not imply shared balances between networks.
  Wallet creation/funding for the walkthrough happens at the Hex gateway, not the
  unrelated preview chain. No bridging or automatic cross-origin key sharing.

## Alternatives

The smallest complete MVP is a memory-only wallet with explicit portable backups.
Encrypted persistent browser storage or an extension/dapp signing bridge adds a
different key-management product; omit those for this simple wallet request.

## Verification

Test generated/imported keys against the native wallet, malformed backups and
private keys, signature compatibility, and safe file-size limits. Build and serve
the browser bundle with the gateway. Verify a browser-generated wallet, faucet
receipt/balance, importing the same identity into Hex, a two-player game action,
and settlement. Document exact launch commands and the different network balances.
