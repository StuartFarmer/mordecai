# Wire Format & Protocol

Everything consensus-visible — transactions, blocks, votes, gossip — is
encoded by `@hssn/protocol`, a zero-dependency canonical codec. **Canonical
bytes are what get hashed and signed**, so the format's one rule is: every
structure has exactly one valid byte representation, and decoding rejects
anything encoding could not have produced.

## Encoding rules

- Fixed-width **little-endian** integers; u64 values are JS `bigint`s end
  to end (never `number` — currency amounts must not lose precision).
- Variable-length fields carry a u32 length prefix and a hard maximum,
  enforced on both encode and decode.
- Strings are UTF-8, decoded in fatal mode.
- Decode must consume every byte (`Reader.finish()`), or it fails — no
  trailing-byte malleability.

## Domain separation

Signing preimages are prefixed with a domain tag so bytes signed for one
purpose can never validate as another:

| Domain          | Signs                               |
| --------------- | ----------------------------------- |
| `hssn:tx:v1`    | transactions (by the sender)        |
| `hssn:block:v1` | block headers (by the proposer)     |
| `hssn:vote:v1`  | consensus votes (by each validator) |

Hashing is BLAKE2b-256 throughout. A transaction id is the hash of its full
encoding; a block hash is the hash of its encoded header; a contract id is
`H("hssn:contract:v1" ‖ sender ‖ nonce ‖ code)`.

## Golden vectors

`packages/protocol/test/vectors/golden.json` pins the exact bytes of every
structure. **Any change to these vectors is a consensus-breaking protocol
change** and must be treated as one (regenerate deliberately with
`UPDATE_VECTORS=1 pnpm --filter @hssn/protocol test`). The vectors also
serve as a conformance target for future non-JS implementations.

## Gossip messages

Validator-to-validator traffic (length-prefixed frames over hyperswarm
sockets, 16 MiB cap):

| Message                                                              | Purpose                                                           |
| -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `hello {height}`                                                     | advertise head; triggers catch-up in laggards                     |
| `tx {bytes}`                                                         | relay an admitted transaction (canonical bytes, never re-encoded) |
| `proposal {round, block}`                                            | proposer's block for the next height                              |
| `vote {vote}`                                                        | signed pre-commit                                                 |
| `block_request {from, count}` / `block_response {[block, votes[]]…}` | certificate-verified sync                                         |

Transport identity is deliberately unauthenticated — proposals and votes
carry their own signatures, and sync responses are verified against
certificates, so a malicious peer can waste bandwidth but never inject
state.
