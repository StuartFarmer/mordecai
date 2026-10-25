# Tipped microblog proposal

Date: 2026-10-25. Status: design for discussion; no implementation authorized by this document.

## Confirmed request and proposed scope

The user requested a microblogging site where people can tip good posts, as a fourth agent's design proposal. It belongs in the existing node site, with the shared wallet, faucet and Demos navigation. This document proposes the remaining product choices; it does not present them as agreed requirements.

Recommended MVP: **a node-hosted chronological feed of signed short posts, with direct CAI test-token transfers to their authors**. Reading needs no wallet. Publishing and tipping use the wallet already open in the node site. The operator hosts and moderates this feed; it is not a global, censorship-resistant social network. The purpose is to make wallet identity and real transaction confirmation tangible in one small demo.

Proposed exclusions: replies, following, likes, search, rich media, editable profiles, private messages, tokens, escrow, platform fees, monetization promises and paid ranking. Tips do not determine whether a post is good or truthful.

## Existing capabilities and gaps

- `packages/gateway/web/wallet.js` keeps the key in the current tab and coordinates transactions across demos. `demo-session.js` exposes address, public key and revocable transaction access, never the seed. Its only off-chain signing method today is Chess-specific; a dedicated microblog signer would be new work.
- `demos.js` lazily mounts bundled demos using node configuration. Add Microblog there and in the shared navigation/container, rather than launching a separate website or asking for another wallet.
- `transactions.js` already validates integer CAI base units, balance, nonce, network and fees, broadcasts signed transactions, and distinguishes confirmed, failed and uncertain outcomes. Shared transaction history is currently memory-only and limited to ten entries.
- The transfer payload has recipient and amount, with no post memo. `GET /api/tx/:hash` supplies a receipt, height and index, but no payment recipient or amount. `get_block` supplies encoded transactions. A receipt alone therefore cannot prove a claimed tip's destination or value.
- `packages/networking/src/feed.ts` wraps a signed Hypercore log. It is not a public microblog API, wallet-author identity system, moderation service or durable feed index.

## Experience

Select **Demos → Microblog**. A compact page shows a composer above the newest posts. Each card has plain text, full author address available behind its short label, node acceptance time, a permanent post link, **Tip**, and confirmed tips with receipt links. Show “This node's feed · test tokens” and a clear empty state. Seed examples, if used, are visibly labelled examples and cannot be tipped as real authors.

Without a wallet, reading works and composing/tipping offers a route to Wallet. Returning preserves the demo route and unsent text in memory. Wallet or Faucet remains reachable through the same navigation; no popup, separate key store or second login is introduced.

Proposed post limit: 280 Unicode code points and 2 KiB UTF-8, with a visible counter. Publish signs a specific post after an explicit button click, then waits for host acknowledgement. Publishing is free and is labelled “Signed post,” never “on-chain.” An uncertain submission retries the identical signed envelope and cannot create a duplicate. The default author label is its wallet address, with no claim about a real person.

Tip opens an inline review showing the post excerpt/ID, full recipient, network, positive whole-number amount in CAI base units, maximum network fee, and “Send tip.” Cancel sends nothing. Shared wallet locking prevents simultaneous demo transactions. After broadcast show the transaction hash and pending state; only a successful matching receipt produces “Confirmed.” A failed or unavailable receipt never increases totals. Disable self-tips in the MVP and explain why. Do not disable a post permanently after a successful tip: repeat tips require a fresh explicit review.

## Minimal architecture and signed data

Use a small bundled demo and node-hosted API backed by one durable local store. Prefer the repository's existing durable storage mechanism if suitable; do not add a database service. Host accepted signed records and receipt associations in an append-only log, with a rebuildable chronological index and an operator visibility list. Acknowledgement must follow durable append; restart must retain accepted records. Node-local ordering uses a host-assigned sequence, not client timestamps. Persist no private keys.

Proposed API under `/api/demos/microblog`: configuration/feed with bounded cursor pagination, submission of signed posts, and submission/readback of tip associations. These are new APIs, not existing capabilities. Bound body sizes and page sizes, reject unknown fields, validate all signatures server-side, and rate-limit writes by wallet and connection source. The bundled client renders all user strings with `textContent`.

A post signing payload is an ordered, versioned array containing domain `mordecai/microblog/post/v1`, configured chain ID, stable feed ID, random 32-byte post nonce, and exact text. Fix UTF-8 serialization and hash rules in one shared wallet module, following the dedicated Chess signer pattern without reusing Chess's domain. The envelope contains payload, Ed25519 public key and signature. Derive the author address from the verified public key; never accept a separate payout address. The post ID is the hash of canonical signing bytes. Validate text before signing and never normalize it afterward. Duplicate IDs are idempotent; a foreign chain/feed envelope is rejected.

The host wallet facade gains only `signMicroblogPost` and `signMicroblogTip`, validates the configured feed/network, and revokes access on wallet changes. Do not expose a general arbitrary-message signer to bundled demos. Browser and host share canonical encoding/validation. Off-chain identity proves control of the signing key, not uniqueness or reputation.

## Direct tips and trustworthy receipts

Keep money movement as an ordinary `transfer` from reader to verified post author: no custody, contract, commission or withdrawal screen. Because transfers contain no post reference, the link between transfer and post is a separate signed attribution, not a chain-enforced relationship.

To avoid a browser crash losing the association, prepare the transfer and persist a signed attribution **before broadcasting**. Attribution binds domain/version, chain ID, feed ID, post ID and transaction hash; signer must equal the transaction sender. The host validates the canonical signed transfer bytes, hash, chain, recipient, positive amount, sender and post author, then durably records an intent. It must not broadcast just because it received an intent. The browser then confirms/broadcasts through the shared transaction coordinator. This requires extending its current prepare/submit facade; the existing send method returns a confirmed hash/height/fee after submission and cannot support this pre-broadcast flow unchanged.

The host periodically resolves saved intents against its configured node. Only `success: true` for the exact hash earns confirmed status. Verify the recorded signed bytes and, where available, compare the transaction at receipt height/index from the block API. A wrong recipient, failed transaction or missing receipt earns no total. Enforce one attribution per `(chainId, transactionHash)` so one transfer cannot inflate multiple posts; repeated identical submissions are idempotent. Never trust totals supplied by clients. Rebuild totals from verified associations. Label totals “Confirmed tips linked on this node”: they exclude ordinary unlinked payments and other hosts' feeds.

An unresolved transaction remains pending, including after reload/restart; retry broadcasts the same bytes/hash and never silently makes a second payment. A consumed nonce with unavailable receipt remains unknown, not successful. Existing tab-only wallet history is insufficient for this durable intent workflow. If the host is offline, publishing and new tips are unavailable, with no automatic send on reconnection. “Confirmed” means this node reports successful inclusion, not a promise of independent finality or real-world monetary value.

## Content and moderation boundaries

MVP content is plain public text only: no HTML, Markdown, images, embeds or automatic URL fetching. Do not solicit secrets or personal data. The operator can hide a post from listing and direct rendering and block further writes from an address; authors can submit a signed hide request. Keep a minimal tombstone for payment attribution, without serving the original text. Existing transfers remain valid, and tips are not refundable through moderation.

Explain that hiding cannot erase downloaded copies, backups or chain payments. Define backup retention and content removal procedures before public deployment. The demo should initially be a local/trusted test network: source/address limits are basic abuse controls, not Sybil prevention. Tip totals are not an anti-spam mechanism. A hidden post cannot receive new tips through this UI; pending transfers may still settle. Read-only mode is preferable to losing accepted data when storage or confirmation is unavailable.

## Viable approaches

| Approach                                                             | Benefits                                                                   | Costs                                                                                    | Recommendation                                                                                 |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Signed posts in the node's local durable store; ordinary direct tips | Smallest fit with shared browser wallet; host can moderate; no posting fee | Host controls availability/order; attribution is off-chain                               | Recommended MVP                                                                                |
| Per-author Hypercore feeds, aggregated by nodes                      | Uses existing replicated-log primitive; portable signed histories          | Wallet/feed-key binding, discovery, spam, indexing and deletion are substantial new work | Later, if feed portability is the goal                                                         |
| Contract stores posts or hashes and emits post-linked tip events     | Chain-enforced post/tip relation; shared indexing basis                    | Contract, fees, deployment and permanent content/metadata considerations                 | Only if chain-enforced attribution is a user requirement; store hashes rather than public text |

## Acceptance walkthrough

1. Open the node site, visit Microblog, and read without a wallet. Open/create a shared wallet, download its backup and obtain test funds from the existing Faucet; return without a new login.
2. Publish a short signed post. Refresh and restart the host: it appears once with the same ID and author. Invalid signatures, oversized text and foreign-feed envelopes fail; markup displays literally.
3. In another browser wallet, review a tip and cancel: balance and feed totals do not change. Review again and send: recipient is the author, fee is shown separately, and the tip stays pending until a matching successful receipt.
4. Verify the recipient balance and transaction link. Double-click/retry and repeated attribution cannot duplicate payment or totals. A failed receipt, wrong recipient, another sender's attribution or reused hash cannot count.
5. Interrupt submission/receipt polling, reload and restart: stored intent is recovered and resolves without creating a new transfer. Closing/changing the wallet revokes the old facade; insufficient funds and wrong network produce useful errors.
6. Hide a post: listing and direct view stop showing its content; historic verified tip attribution remains as a tombstone. No seed examples are misrepresented as real signed posts.

## Decisions awaiting user review

The proposal chooses node-local hosting, free signed publishing, a 280-character text limit, address identity, no replies, no tip ranking and test-token transfers. None is confirmed beyond the original concept. The most consequential choice is whether this is a small social demo or a portable/federated publishing system; federation changes the scope significantly. The user should review that choice, moderation policy and whether off-chain tip attribution is sufficient before implementation planning.
