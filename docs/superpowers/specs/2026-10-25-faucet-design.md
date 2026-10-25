# Opt-in node faucet

The user approved a reusable faucet that any node operator can enable and fund,
rather than a faucet restricted to the local devnet. This is an MVP feature.

## Behavior

Add a compact homepage form for a recipient wallet address and a Get test CAI
button. Submit a real signed transfer from a dedicated operator wallet; show
the transaction hash and distinguish submitted from confirmed transfers.
Never ask visitors for a mnemonic or private key. Preserve the page's status
bar, footer, documentation, image, and one-second polling.

## Implementation choices

- Disabled by default. Both node and standalone gateway CLIs accept
  `--faucet-keystore <file>` with `MORDECAI_FAUCET_PASSPHRASE` in the environment.
  Reuse encrypted wallet files and existing signing, encoding, and RPC code.
- GET `/api/faucet` exposes enabled state, wallet address, amount, and cooldown.
  POST `/api/faucet` accepts only a recipient address, not an amount or signing key.
- Each claim sends 10,000 CAI base units. Fees come from the faucet wallet.
- One claim per canonical recipient address and socket IP per 60 seconds;
  at most 100 claims per hour per gateway. Do not trust forwarded IP headers.
- Limit request bodies, validate addresses, and reject self-transfers. One
  outstanding transfer at a time avoids nonce races. Preserve its signed bytes
  if submission is ambiguous; do not sign another transfer until its nonce is
  consumed. Return submitted status until the chain confirms it.
- Limits are in memory for this MVP and reset on restart. Use one gateway per
  dedicated faucet wallet. Behind a reverse proxy, the socket IP cooldown is
  shared by visitors. Document these limits rather than adding infrastructure.
- Operators fund the wallet by genesis allocation or ordinary transfers; no
  minting or changes to consensus. Enable one faucet in the local devnet and
  restart only the disposable preview with a newly funded genesis wallet.

## Approaches

1. Reusable opt-in gateway faucet: selected; works on any operator-funded node.
2. Devnet-only faucet: smaller deployment scope, but does not meet the selected
   goal of letting operators provide tokens to network visitors.

## Scope and verification

Touch gateway signing/API code, gateway and node CLI setup, landing assets,
devnet setup, package dependencies, and operator/field-guide documentation.
Use existing libraries; no external service or new third-party dependency.
Test actual funded transfers, disabled/empty faucets, invalid requests, limits,
concurrent claims, and uncertain submission recovery. Verify the form, mobile
layout, build, lint, and documentation build. Do not publish or push this work.
