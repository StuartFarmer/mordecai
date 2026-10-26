# Microblog: Posts and Tips

Open **Demos → Microblog** on a running node site. Anyone can read its chronological feed. Publishing a short post is free: the shared Account signs it, and this node stores it off-chain. A account address identifies the signing key, not a verified person.

## Publish and share

1. Open **Account**, create or load a test account, and save its backup. Return to Microblog through the same navigation.
2. Write up to 280 Unicode characters (maximum 2 KiB). Select **Publish post** to sign and submit that exact text.
3. Open the post's timestamp to get a permanent link. Posts display plain text, so markup is not executed.

If acknowledgement is uncertain, **Retry identical signed post** resubmits the same signed record without creating a duplicate. Accepted posts survive refresh and host restart. Text is public; do not include secrets or private information.

## Tip an author

New accounts receive 1,000,000 test CAI automatically; existing accounts can receive transfers. On another account's post, select **Tip**, enter a positive whole number of CAI base units, then **Review tip**. Check the post, complete recipient address, network, amount and separate maximum fee. **Cancel** sends nothing. **Send tip** sends a direct transfer to the verified author; there is no custody or platform commission. Self-tips are disabled.

The node first durably saves a signed association between this post and the prepared transaction hash. The browser then broadcasts through the shared Account coordinator. A tip counts only after the node verifies the signed transfer, successful receipt, and the exact transaction at the receipt's block position. Failed or unavailable receipts never increase totals. The label **Confirmed tips linked on this node** excludes ordinary unlinked transfers and other hosts' feeds.

The app shows pending links after reload or restart and never automatically sends a payment on reconnection. A pending link may never have been broadcast. For uncertain submissions, keep the account tab open and use **Account** to check the receipt or retry the same transaction bytes. Do not create another transfer merely because a receipt is unavailable. Confirmation means successful inclusion reported by this node; CAI here is a test token.

## Hide a post

The author can open **Manage your post → Sign and hide post**. The signed request removes its text from this node's feed and direct view, leaving a payment tombstone. No new tips can be linked to a hidden post; previously submitted transfers can still settle. Hiding does not refund payments or erase downloaded copies, local records or backups.

## Host operation

The demo launcher enables the service and persists its stable feed identity and signed records under `microblog/` in the node's data directory. Back up that whole directory with restricted permissions; run only one process against it. The local service exposes operator `hide(id)` and `block(address)` methods, with no unauthenticated administrative HTTP endpoint.

This small feed is intended for a local or trusted test network. It uses an in-memory index and atomically replaces its durable file after writes. Write limits per source and wallet are basic abuse controls, not Sybil prevention. Receipt checks have bounded concurrency and deadlines; node outages leave links pending while the feed remains usable. Define content-removal and backup-retention procedures before public deployment, and migrate the store when feed size requires an indexed database. Replies, following, rich media, ranking and federation are outside this demo.
