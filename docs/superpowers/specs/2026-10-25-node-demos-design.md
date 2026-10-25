# Node demos: first integrated slice

The user approved starting shared-network/wallet Hex integration and requested
Demos (a dropdown per demo), plus incremental git commits. The existing site and
wallet work is checkpointed at c0b6d4f.

## Scope and approach

- Home, Wallet and Faucet remain. Demos contains Hex (integrated), plus Frontier,
  Outpost and Chess documentation links while those conversions remain pending.
- Mount the existing Hex React app inside a Shadow DOM on the node SPA, reusing
  its gameplay and isolating its CSS. The standalone Hex build keeps working.
- Pass a wallet facade (address/public key and a transaction method), never a
  private key, into the embedded game. Closing the node wallet disconnects Hex.
  Wallet and game sends share a lock and pending-receipt tracking.
- Serve Hex app-chain RPC/faucet under a fixed gateway API namespace; browsers
  use same-origin paths. The L1 used by wallet, faucet and Hex escrow is identical.
- A node-demo launcher persists validator/operator keys, chain storage and
  deployment transaction records in an ignored local directory. Restart resumes
  the deployment and games instead of resetting genesis.
- Node-demo faucet grants cover Hex's existing default stake; app fees are funded
  separately from a dedicated wallet. Existing faucet limits remain.

## Alternatives

External links would keep separate balances and require another key import.
An iframe signer protocol would add messaging and origin checks without helping
this trusted bundled demo. The embedded app with a narrow signer facade fits the
existing SPA and reuses its transaction tracking. These are implementation choices.

## Limits

This slice integrates Hex. Frontier/Outpost wallet and room conversion remains
next. Local persistent demo operator keys are test-only and stored with private
filesystem permissions. No public hosting, DNS or remote deployment is included.
