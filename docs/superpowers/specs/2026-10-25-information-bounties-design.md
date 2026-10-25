# Information bounties — design proposal

Date: 2026-10-25. Status: proposal for discussion; no product implementation approved by this document.

## Intent and requirement boundary

People post questions or requests for data, research or information, attach a monetary reward, receive responses, and award the reward to the best response. Investigation and journalism are motivating use cases.

Those are the confirmed requirements in the task brief. The following are proposed MVP choices, not user decisions: a public board within the node site; one creator funding the entire reward; one winning response; creator judgment rather than votes or arbitration; public text submissions; CAI on this node's L1; fixed deadlines and a refund when no winner is chosen. In a demo network, label every amount **test CAI**, not real money. Do not imply that a test-token demo finances actual journalism.

## Approaches

| Approach                                                        | What users get                                                                | Tradeoff                                                                                                             |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Pledge board with ordinary wallet transfers                     | A question, an advertised amount and voluntary payment after selection        | Cheapest, but the pinned amount is a promise; the creator can spend it elsewhere. Must say “pledged, unfunded.”      |
| Funded bounty contract, public submissions                      | A locked reward, verifiable submissions and an atomic creator-selected payout | Requires a new small contract and transaction fees. Funds are reserved, but quality and selection remain subjective. |
| Crowdfunding with private evidence and independent adjudication | Multiple sponsors, restricted disclosure and dispute decisions                | Adds identity, key management, contribution refunds, moderation and governance; far beyond this request.             |

Recommend the second approach. Fund the bounty when publishing, so the main board never confuses an advertised promise with spendable escrow. Skip pledges, sponsor top-ups, split prizes, voting, reputation and disputes in the MVP. Escrow guarantees custody and the stated payout rules, not a satisfactory response or a fair creator.

## Existing capabilities and gaps

- `packages/gateway/web/demo-session.js` exposes a revocable wallet facade with address and `sendTransaction`, without giving bundled demos the seed. Reuse it; no second bounty wallet or automatic faucet request.
- `packages/gateway/web/wallet.js` serializes wallet/demo sends and waits for receipts. `transactions.js` verifies network, nonce, balance and receipt hash, keeps uncertain transactions and retries the same signed bytes. Reuse this path and its Wallet history.
- `compiler/examples/hex_escrow.pysc` demonstrates attached-value custody, sender checks, one-time phase transitions and transfers. Its player/game settlement policy does not fit subjective information requests; do not reuse that contract unchanged.
- The DSL supports address/string/integer state and block height (`compiler/mordecaidsl/typecheck.py`). A bounty can therefore use deterministic height deadlines rather than a server clock.
- The gateway already reads contract state and transaction receipts. `packages/networking/src/feed.ts` offers signed append-only replicated feeds, but is not a ready-made board, authenticated HTTP write endpoint, private mailbox or search index. A feed key alone also does not establish ownership of a payout wallet.

The smallest architecture uses one L1 bounty contract as the authoritative registry and stores bounded public question/response text directly in its state. This avoids a new feed-to-wallet authentication scheme, off-chain availability promises and a trusted content server. Public on-chain text has fees and size limits, so this is a deliberately small text-and-links MVP, not a dataset hosting service. Before implementation, verify gas and storage cost with the proposed limits; move bulk material off-chain only if measured limits require it.

## User flow

1. **Browse:** open Bounties without a wallet. Cards show title, reward and unit/network, escrow status, creator, response count, submission deadline and phase. Detail shows immutable request, acceptance criteria, sources requested, exact closing heights and approximate date estimates. Only confirmed funded requests appear in the open list.
2. **Create:** open the existing Wallet, enter title, request/criteria, reward and submission duration. Show the policy before publication: public forever, one winner, creator selection, no guaranteed award, refund after the award window. Review network, contract, reward, fee limit and both deadline heights, then confirm. A local draft is not a listed funded bounty.
3. **Fund and publish:** one `create` transaction attaches exactly the reward and writes the request atomically. Show “funding pending” with hash until a successful receipt and matching contract state establish the escrow. Failure leaves no advertised funded reward. Fees are separate from the reward.
4. **Respond:** open Wallet and submit bounded public text plus optional source URLs. The connected address is the immutable payout recipient. Show it and the public disclosure notice before sending. A response appears eligible only after successful confirmation before the contract's submission boundary. There are no submission edits or replacement identities in the MVP; a correction is another response.
5. **Review and select:** after submissions close, the creator reviews responses and selects one. A confirmation displays its immutable ID, author address, full reward and irreversible selection. Successful `award` both records the winner and transfers the entire escrow to that address. There is no intermediate winner announcement that looks paid while a separate transfer remains optional.
6. **Finish:** show “Award paid” only after receipt and contract state agree, with winner, amount, payout transaction and height. Non-winners receive no payment. If no award occurs by the final deadline, show “No award — refund available,” followed by “Refunded” only after confirmation.

Read-only browsing and response text can remain visible when Wallet closes; actions become unavailable and stale wallet facades are revoked. Loading a different key cannot silently change a prepared recipient or creator.

## Contract and deadline policy

One deployed contract holds separate records keyed by an incrementing bounty ID. Proposed state:

- Bounty: creator, positive reward, title, request text, submission end height, award end height, response count, phase and optional winning response ID.
- Response: bounty ID, sequential response ID, author address, immutable text and inclusion height. No caller-supplied payout address.
- Closed records remain readable. Never delete a request to hide its financial history.

Proposed limits are a 160-character title, 8 KiB request and 8 KiB response, with the equivalent UTF-8 byte limits enforced in the contract/codec, not only HTML. Builder must verify the DSL's byte-length validation path; if absent, provide contract-level enforcement before launch. This is a proposed constraint, not an existing feature claim. Accept plain text and ordinary HTTPS source links; render text safely and never fetch arbitrary URLs from the node.

| Action    | Authorization and conditions                                                                           | Atomic effect                                                          |
| --------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `create`  | Any wallet; positive attached reward; valid bounded fields; submission end in future; award end later  | Allocate ID, lock attached value, publish immutable request            |
| `respond` | Any wallet except creator; open phase; `height < submitEnd`; zero attached value                       | Record sender/text, increment response count                           |
| `cancel`  | Creator; open phase; zero responses; `height < submitEnd`; zero attached value                         | Close as cancelled, return reward to creator                           |
| `award`   | Creator; open phase; `submitEnd <= height < awardEnd`; response belongs to bounty; zero attached value | Close as awarded, store winning ID, transfer reward to recorded author |
| `refund`  | Any caller; open phase; `height >= awardEnd`; zero attached value                                      | Close as expired/refunded, return reward only to creator               |

Use a fixed award window configured for the deployment and displayed before funding; a proposed demo default is 100 blocks. The creator chooses a submission end height using duration presets, with the exact height always visible. Block intervals are estimates: a stalled chain delays closure and refunds. Browser timers do not enforce policy. Reject deadline overflow and invalid durations in the contract. No deadline extensions or request/reward edits after funding.

Cancellation is allowed only before the first confirmed response. That prevents withdrawal while people have already submitted work, while allowing an untouched mistaken request to be unwound. The creator may decline every response by taking no award action. Funds stay locked until `awardEnd`; then anyone can trigger a refund to the creator. This is an explicit **no guaranteed award** policy, even if useful responses exist. There is no quality oracle, appeal or administrator payout override. A creator can also collude with a separate address; the system does not certify impartiality.

Even zero-response bounties follow the same final refund deadline after submissions close, keeping one simple timeout rule. Permissionless refund execution means no privileged scheduler is required; the creator may need fee funds to trigger it if nobody else does. Fees already paid are never part of a reward refund.

Close phase before transfer within the same atomic contract execution. A failed transfer must roll back closure. Award/refund/cancel are mutually exclusive; an action cannot spend another bounty's reserved reward. The builder must validate those invariants against the runtime, including contract balance accounting and transaction failure rollback. Display no speculative receipt as settlement.

## Public content, privacy and funding transparency

Request text, responses, source links, addresses, amounts and winner selection are public chain data. Removing content from this site's index cannot erase chain history or copies. Do not accept file uploads or secret submissions. Before creation and response submission say: “Public and permanent. Do not include confidential sources, personal records, credentials or unpublished sensitive evidence.” This MVP is unsuitable as a confidential whistleblower channel; no claim of anonymity, source protection, encryption or secure document handling is supported.

People can provide a public summary and a link to material they are entitled to publish. An external link may disappear or change; it is not proof of the original content. A future hash/attachment scheme would be a separate feature. The creator judges the public response available at selection time. Payment buys no implied copyright assignment or exclusive publication right; any requested terms must be visible in the original request, and the app does not adjudicate them.

The page distinguishes reward reserved by the contract, network fees, payout, and refund. Show chain ID, contract address, confirmed creation hash, current phase and reward amount read from chain state. Do not label a wallet balance, typed amount, frontend badge or feed entry “escrow.” MVP monetary state comes exclusively from confirmed contract state. Hide/report controls and abuse policy need a separate decision before a public service launch; neither promises chain erasure.

## Receipt, recovery and failure behavior

Use the shared transaction facade and same-node L1 routes. Each financial action shows its relevant details before wallet confirmation. A timeout or missing receipt means **confirmation unknown**, not failed or paid; retain the hash and retry identical signed bytes through Wallet. Do not manufacture a second create/award with a new nonce to resolve uncertainty.

After success, reload bounty state and balances before showing final settlement. If state cannot be loaded, report “transaction confirmed; bounty status unavailable” with the receipt link. An included failed transaction may consume a fee but must not show a response, funded bounty or payout. Concurrent deadline/selection races are resolved by contract height and phase checks; show the resulting state and rejection plainly.

Current Wallet pending/history is tab memory. A reload can lose that local history, so the board must be recoverable from contract state and offer lookup by bounty ID/transaction hash. Durable cross-device pending recovery is not an existing promise. A closed browser is not a refund scheduler.

## Proposed acceptance walkthrough

Use two imported test wallets and one observer in the same node site:

1. Browse without Wallet; verify public records and explicit test CAI/network labeling. Create a bounty with wallet A, cancel the wallet review, and verify no reward/record appears.
2. Confirm funding with A. Verify A pays reward plus actual fee, contract balance increases by reward, and “funded” appears only after receipt/state confirmation. Insufficient balance or rejected execution creates no funded card.
3. Submit a response with B. Confirm author/recipient are B, input renders as text, and no wallet key reaches the bounty module. A cannot respond as creator. A cannot cancel after B's confirmed response.
4. At `submitEnd - 1`, a confirmed submission is eligible; at `submitEnd`, submissions fail and awards become eligible. Browser clock changes have no effect.
5. With A, choose B after submission closure. Check the review names B and exact reward. Confirm once; B receives reward, A pays only the award fee, winner/receipt persist. A non-creator award, another bounty's response ID, second award and refund after award all fail without changing escrow.
6. Create another bounty. Confirm cancel before any response returns its reward once. For another bounty with a response, choose nobody; at `awardEnd - 1` refund fails, at `awardEnd` an observer can trigger refund to A, never the observer. Late awards and repeat refunds fail. Verify zero-response expiry follows the same rule.
7. Simulate a dropped submission response and receipt timeout for funding/award. Show uncertainty; retry the same hash, never duplicate payout. Reload, find the bounty again and derive its final status from state. Failed actions may charge fees, but never report paid/refunded.
8. Close/change Wallet while a bounty is open. Public browsing works, old signing callbacks reject, and reopening the original key restores authorized actions. Check keyboard review/confirmation and understandable pending/error states.

Future implementation needs meaningful contract tests for authorization, height boundaries, one-time spend/rollback and value isolation, plus a small integration check for receipt-backed labels. This design-only change adds no product tests or dependencies.

## Product choices to resolve before implementation

1. Is creator discretion with eventual refund acceptable, including when respondents believe they earned payment? Recommendation: yes, stated prominently; otherwise a separate adjudication design is necessary.
2. Must submissions be confidential? Recommendation: public-only MVP. Confidential investigative material requires another security and storage design.
3. Is this a test CAI demo or a real-value service? Recommendation: test CAI first, with exact network/unit labels. Real-value operation is a separate readiness decision.
4. Confirm the submission duration presets, award-window length, text limits and cancellation policy. The proposed rules above are complete defaults for evaluation, not previously approved user choices.

No product code, deployment, contract compilation, cost measurement or production policy review is included in this proposal.
