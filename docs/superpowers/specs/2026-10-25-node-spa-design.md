# Node SPA and wallet transactions

User request: split the node page into SPA pages with top navigation; the Wallet
page supports creation/import, balances, simple transfers, transactions and faucet.
The user explicitly confirmed signed-transaction submission in addition to transfers.

- Home and Wallet use hash routes; switching views preserves the wallet in memory.
  Keep the hero/content on Home, network/status at the top right and chain footer.
- Top navigation includes Home, Wallet, documentation, API and GitHub. External
  documents open separately so they do not discard the loaded wallet.
- Wallet contains existing key controls and faucet, plus a recipient/amount form
  and an advanced signed-transaction form accepting hex or CLI `{tx}` JSON.
- Transfers use integer CAI base units, current network and nonce, and a fixed
  1,000-unit fee ceiling. Validate canonical addresses, positive u64 amounts and
  sufficient balance before signing. Show a review before broadcasting.
- Verify imported transaction encoding/signature and network before submission;
  never send private keys. Display network, sender, action, nonce, fee and payment
  details in the review. Recheck simple transfers before send if account changed.
- One tracked outgoing transaction at a time. Compute its hash locally, retain
  signed bytes on uncertain submission, and offer only identical-byte retry until
  resolved. Distinguish an explicit node rejection from a lost RPC response.
- Poll receipts; never call an unconfirmed transfer paid. Show recent transaction
  results for this session. Existing standalone wallet page receives the same tools.
- Reuse existing browser wallet/protocol libraries and Vite bundle; no framework,
  router dependency, persisted keys or cross-network feature.

Verify navigation/back/deep links and wallet retention, transfer validation and
native signatures, real payouts, raw submissions, nonce changes, concurrent sends,
and uncertain/rejected/confirmed results. Check mobile and existing custom apps.
