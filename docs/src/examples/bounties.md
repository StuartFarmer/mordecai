# Information Bounties

Open **Bounties** in the node site to browse public questions with funded rewards. Each question reserves its full reward in an L1 contract. The creator chooses one response, and a successful award transfers the whole reward to that response's author.

This is a **test CAI demo**. It does not finance real-world work. Creator discretion means **no guaranteed award**, even if useful responses exist.

## Fund and answer a question

1. Open **Wallet**, load a test wallet, and obtain test tokens from **Faucet** if needed. Browsing does not require a wallet.
2. In **Bounties**, enter a title, the request and acceptance criteria, a whole-number reward, and a submission duration. Include any requested sources or publication terms in the original request; it cannot be edited after funding.
3. Select **Review funding**. Check the network, contract, sender, reward, fee limit, and exact submission and award deadline heights. **Cancel review** sends nothing. **Confirm and send** publishes and funds the request atomically.
4. Wait for confirmation. The board lists requests from confirmed contract state. A typed reward or pending transaction is not a funded listing.
5. Load a different test wallet to respond. Read the criteria, enter a public answer and any source URLs, then review and confirm. The response's wallet address is its immutable payout recipient. The creator cannot respond to their own bounty.

The title accepts at most **160 UTF-8 bytes**, and each request or response accepts at most **8,192 UTF-8 bytes**. Some characters use several bytes. The contract enforces these limits independently of the browser. There are no uploads or submission edits; a correction is a new response.

## Deadlines and the quick demo

The default submission duration is **5 blocks**, with 100, 500 and 2,000-block alternatives. Review shows the exact closing height before you send. Once submissions close, the creator has a fixed **100-block award window**.

This demo chain advances with network activity. Waiting five seconds does not mean five blocks have passed. Funding, a response, and other confirmed transactions advance the chain; use ordinary test-wallet transfers if you need to advance the remaining blocks for a walkthrough. Every transaction may cost a fee. Browser clocks do not enforce deadlines, and a stalled chain delays closure and refunds.

For a bounty with submission end `S` and award end `A = S + 100`:

| Chain height           | Available actions                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| Before `S`             | Other wallets may respond. The creator may cancel only while there are no confirmed responses.        |
| At `S` through `A - 1` | Submissions and cancellation are closed. Only the creator may select a response and award the reward. |
| At `A` or later        | Awards are closed. Anyone may trigger a refund, always to the creator.                                |

The contract checks the height at transaction execution. A response prepared just before the boundary can fail if it is included too late.

## Select, cancel or refund

After submissions close, load the creator's wallet, select the bounty, and use **Review award to this response**. Check the immutable response ID, author address and full reward. Confirming a successful award both records the winner and transfers the reward in one transaction. Selection is irreversible, and non-winners receive nothing.

Before any response, **Review cancellation** returns the reward to the creator if submissions are still open. Once somebody has responded, the creator cannot cancel. If the creator selects nobody before the award window ends, **Review refund to creator** becomes available to any wallet. Its caller pays the transaction fee; the reward goes only to the creator. Even a bounty with zero responses follows this final refund deadline after submissions close.

Network fees are separate from the reward and are never refunded. The contract prevents a second payout, cancellation after an award, and spending another bounty's reserved reward. It does not judge response quality, guarantee impartiality, settle disputes, or imply a copyright transfer.

## Public information and recovery

**Public and permanent. Do not include confidential sources, personal records, credentials or unpublished sensitive evidence.** Titles, requests, responses, addresses and monetary actions are public chain data. This is not a confidential whistleblower channel. Source URLs are displayed as plain text and are not fetched by the node; linked content can change or disappear. Removing a frontend listing cannot erase chain history or copies.

Each transaction shows its confirmation state. A timeout or lost response means **confirmation unknown**, not failed or paid. Open **Wallet** to inspect the pending hash and retry the same signed transaction. Do not create a new payment to resolve an unknown result. Failed execution can still consume a fee.

After a successful receipt the app reloads contract state and checks the matching request, response or settlement before showing completion. If that reload fails, it says the transaction is confirmed but bounty status is unavailable. Current-session receipt links expose the hash, inclusion height and actual fee.

After reloading the page, find a bounty using its ID. Its immutable content, phase, winner, creation height and settlement height remain recoverable from the contract. Historical transaction-hash discovery and durable local Wallet history are not implemented; this page's receipt hash and tab-local pending history can be lost on reload. Closing a browser does not schedule refunds.

For contract source, build commands, tests and measured message costs, see `compiler/examples/information_bounties.pysc` and `apps/bounties-web/README.md` in the repository. The board currently reads the whole contract state and is intended for a small demo. Public-service moderation and real-value operation require separate work.
