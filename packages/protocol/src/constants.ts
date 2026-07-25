/** Protocol version stamped into block headers. */
export const PROTOCOL_VERSION = 2;

// Cryptographic sizes (Ed25519 / BLAKE2b-256).
export const PUBKEY_SIZE = 32;
export const SIGNATURE_SIZE = 64;
export const HASH_SIZE = 32;

// Payload type tags. Never reuse a retired tag.
export const PAYLOAD_TAG_TRANSFER = 1;
export const PAYLOAD_TAG_DEPLOY_CONTRACT = 2;
export const PAYLOAD_TAG_EXECUTE_CONTRACT = 3;
export const PAYLOAD_TAG_REGISTER_APP = 4;
export const PAYLOAD_TAG_UPDATE_APP = 5;
export const PAYLOAD_TAG_ANCHOR = 6;

// Domain-separation prefixes for signing preimages. Signing bytes for one
// message kind must never be a valid preimage for another.
export const DOMAIN_TX = 'mordecai:tx:v1';
export const DOMAIN_BLOCK = 'mordecai:block:v1';
export const DOMAIN_VOTE = 'mordecai:vote:v1';
export const DOMAIN_ANCHOR = 'mordecai:anchor:v1';
export const DOMAIN_APP_SENDER = 'mordecai:app-sender:v1';

// Protocol limits, enforced on both encode and decode.
export const MAX_CHAIN_ID_BYTES = 32;
export const MAX_ACTION_BYTES = 64;
export const MAX_APP_ID_BYTES = 64;
export const MAX_VERSION_BYTES = 32;
export const MAX_CONTRACT_CODE_BYTES = 512 * 1024;
export const MAX_EXECUTE_ARGS_BYTES = 64 * 1024;
export const MAX_TX_BYTES = 1024 * 1024;
/** Upper bound on an app chain's registered validator set. */
export const MAX_APP_VALIDATORS = 64;
export const MAX_TXS_PER_BLOCK = 10_000;
export const MAX_BLOCK_BYTES = 8 * 1024 * 1024;
