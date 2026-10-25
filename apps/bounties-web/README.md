# Information bounties

An embedded public information-request board on the node's shared test chain. Open **Bounties** to browse without a wallet. Load the existing **Wallet** to fund a question, submit a response, select a winner, cancel an untouched request, or trigger a timeout refund. Amounts are whole **test CAI**, never real-value funding.

The creator reserves the full reward when publishing. Submissions close at the chosen block height; only the creator can award during the next 100 blocks. A confirmed award atomically transfers the entire reward to the response author's immutable wallet address. Cancellation is possible only before any response and before submission closure. After the award deadline anyone may trigger a refund, always to the creator. Creator discretion means **no guaranteed award**, even for useful responses. Network fees are separate and never refunded.

All titles, request text, responses, addresses and source URLs are public and permanent. Do not submit confidential sources, personal records, credentials or unpublished sensitive evidence. Text is rendered as text; URLs are not automatically fetched. No uploads, private evidence, disputes, votes, top-ups or split awards.

## Limits and recovery

- Title: 160 **UTF-8 bytes** (a deliberately stricter bound than 160 Unicode characters). Request and response: 8,192 UTF-8 bytes each, enforced by the compiled contract using `byte_len(str)`.
- Submission presets: 5 (quick demo), 100, 500 or 2,000 blocks. The contract accepts future deadlines at most 100,000 blocks away and rejects arithmetic overflow. The immutable award window is 100 blocks.
- Heights enforce deadlines; wall-clock estimates are intentionally omitted because this test chain may stall. Waiting alone may not advance blocks.
- Requests appear only from confirmed contract state. Each action requires an explicit review with network, contract, sender, attached value and fee limit. Response reviews show the immutable recipient; award reviews identify the chosen response and recipient.
- Unknown confirmation remains unknown. Check **Wallet** for the pending hash and retry its existing signed transaction; do not create a replacement payment. A successful receipt is followed by state reload and matching-state checks.
- Reload recovers every bounty by ID from contract state, including creation and settlement heights. Current-session receipt hashes link to `/api/tx/<hash>`; historical hash discovery and durable local pending history are not implemented. The board scans the full contract state, suitable for a small demo; add paginated indexing before a large public deployment.
- Public-service moderation, reporting and real-value readiness remain separate work. Removing a frontend listing cannot erase chain history.

## Build and verification

`scripts/lib/bounties-demo.mjs` deploys `contracts/dist/information_bounties.wasm` through the shared restart-safe `bounties-deploy` journal step. No configuration initializer exists, so there is no first-caller initialization race. Its public config is `{ chainId, contract, awardWindow: 100 }`.

The browser bundle exports `MordecaiBounties.mount(container, { session, config })`, uses a shadow root, and signs only through the revocable shared wallet facade. It receives no key or seed.

```sh
rtk proxy env PYTHONDONTWRITEBYTECODE=1 python3 compiler/mordecaic build compiler/examples/information_bounties.pysc -o /tmp/bounties-build --wasm
rtk proxy cp /tmp/bounties-build/information_bounties.wasm contracts/dist/information_bounties.wasm
rtk proxy node node_modules/vitest/vitest.mjs run packages/chain/test/information-bounties.test.ts apps/bounties-web/test/chain.test.ts
rtk proxy node apps/bounties-web/node_modules/vite/bin/vite.js build --config apps/bounties-web/vite.embed.config.js
```

The isolated-chain test compiles the source and measures maximum UTF-8-sized messages: creation costs 14,284 test CAI and response costs 16,811 test CAI on the current runtime, below the 500,000 fee limit. Fees can change with runtime changes. Tests verify value rollback, independent escrow balances, unauthorized calls, missing IDs, repeated settlement, exact height boundaries, multibyte limits and recipient-overflow rollback.
