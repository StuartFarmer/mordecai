import {
  DOMAIN_ANCHOR,
  DOMAIN_TX,
  HASH_SIZE,
  MAX_ACTION_BYTES,
  MAX_APP_ID_BYTES,
  MAX_APP_VALIDATORS,
  MAX_CHAIN_ID_BYTES,
  MAX_CONTRACT_CODE_BYTES,
  MAX_EXECUTE_ARGS_BYTES,
  MAX_TX_BYTES,
  MAX_VERSION_BYTES,
  PAYLOAD_TAG_ANCHOR,
  PAYLOAD_TAG_DEPLOY_CONTRACT,
  PAYLOAD_TAG_EXECUTE_CONTRACT,
  PAYLOAD_TAG_REGISTER_APP,
  PAYLOAD_TAG_TRANSFER,
  PAYLOAD_TAG_UPDATE_APP,
  PUBKEY_SIZE,
  SIGNATURE_SIZE,
} from './constants.js';
import { Reader, WireError, Writer, utf8 } from './wire.js';

/** Native currency transfer. `to` is an Ed25519 public key. */
export interface TransferPayload {
  kind: 'transfer';
  to: Uint8Array;
  amount: bigint;
}

/** Deploy a WASM contract module. Contract address is derived from sender+nonce+code. */
export interface DeployContractPayload {
  kind: 'deploy_contract';
  code: Uint8Array;
}

/** Invoke an action on a deployed contract. `args` encoding is contract-defined. */
export interface ExecuteContractPayload {
  kind: 'execute_contract';
  contract: Uint8Array;
  /** Native currency attached to the call, credited to the contract before it runs. */
  value: bigint;
  action: string;
  args: Uint8Array;
}

/** Shared fields of the application-registry payloads (spec §17). */
export interface AppRecord {
  appId: string;
  pearKey: Uint8Array;
  version: string;
  /** Associated contract address, or 32 zero bytes if the app has none. */
  contractAddress: Uint8Array;
  /** BLAKE2b-256 of the off-chain metadata document. */
  metadataHash: Uint8Array;
  /**
   * The app chain's validator set (Ed25519 public keys); empty when the
   * app has no chain. This is the set whose quorum L1 accepts anchors
   * from (app-chains spec §2.4).
   */
  chainValidators: Uint8Array[];
}

export interface RegisterAppPayload extends AppRecord {
  kind: 'register_app';
}

export interface UpdateAppPayload extends AppRecord {
  kind: 'update_app';
}

/** The outcome delivered by an anchor: a contract call made as the app. */
export interface AnchorCall {
  contract: Uint8Array;
  action: string;
  args: Uint8Array;
}

/** One app-chain validator's signature over `anchorSigningBytes`. */
export interface AnchorSignature {
  validator: Uint8Array;
  signature: Uint8Array;
}

/**
 * App-chain anchor (app-chains spec §2.3): a quorum-attested statement
 * that the app chain reached `stateRoot` at `appHeight`, optionally
 * carrying one outcome call executed with the app's derived address as
 * sender. Relayed inside an ordinary transaction; the signatures — not
 * the transaction sender — are the authority.
 */
export interface AnchorPayload {
  kind: 'anchor';
  appId: string;
  /** Strictly increasing per app; replay protection on L1. */
  epoch: bigint;
  appHeight: bigint;
  stateRoot: Uint8Array;
  call?: AnchorCall;
  signatures: AnchorSignature[];
}

export type Payload =
  | TransferPayload
  | DeployContractPayload
  | ExecuteContractPayload
  | RegisterAppPayload
  | UpdateAppPayload
  | AnchorPayload;

export interface UnsignedTransaction {
  chainId: string;
  /** Per-sender sequence number, starting at 0. */
  nonce: bigint;
  /** Sender Ed25519 public key. */
  sender: Uint8Array;
  /** Fee ceiling in base currency units. */
  maxFee: bigint;
  payload: Payload;
}

export interface Transaction extends UnsignedTransaction {
  /** Ed25519 signature by `sender` over `transactionSigningBytes`. */
  signature: Uint8Array;
}

function writePayload(w: Writer, payload: Payload): void {
  switch (payload.kind) {
    case 'transfer':
      w.u8(PAYLOAD_TAG_TRANSFER);
      w.fixed(payload.to, PUBKEY_SIZE);
      w.u64(payload.amount);
      break;
    case 'deploy_contract':
      w.u8(PAYLOAD_TAG_DEPLOY_CONTRACT);
      w.bytes(payload.code, MAX_CONTRACT_CODE_BYTES);
      break;
    case 'execute_contract':
      w.u8(PAYLOAD_TAG_EXECUTE_CONTRACT);
      w.fixed(payload.contract, HASH_SIZE);
      w.u64(payload.value);
      w.string(payload.action, MAX_ACTION_BYTES);
      w.bytes(payload.args, MAX_EXECUTE_ARGS_BYTES);
      break;
    case 'register_app':
    case 'update_app':
      w.u8(payload.kind === 'register_app' ? PAYLOAD_TAG_REGISTER_APP : PAYLOAD_TAG_UPDATE_APP);
      w.string(payload.appId, MAX_APP_ID_BYTES);
      w.fixed(payload.pearKey, PUBKEY_SIZE);
      w.string(payload.version, MAX_VERSION_BYTES);
      w.fixed(payload.contractAddress, HASH_SIZE);
      w.fixed(payload.metadataHash, HASH_SIZE);
      w.array(payload.chainValidators, MAX_APP_VALIDATORS, (w, v) => w.fixed(v, PUBKEY_SIZE));
      break;
    case 'anchor':
      w.u8(PAYLOAD_TAG_ANCHOR);
      writeAnchorBody(w, payload);
      w.array(payload.signatures, MAX_APP_VALIDATORS, (w, s) => {
        w.fixed(s.validator, PUBKEY_SIZE);
        w.fixed(s.signature, SIGNATURE_SIZE);
      });
      break;
  }
}

/** The attested fields of an anchor — everything except the signatures. */
function writeAnchorBody(w: Writer, anchor: Omit<AnchorPayload, 'kind' | 'signatures'>): void {
  w.string(anchor.appId, MAX_APP_ID_BYTES);
  w.u64(anchor.epoch);
  w.u64(anchor.appHeight);
  w.fixed(anchor.stateRoot, HASH_SIZE);
  if (anchor.call) {
    w.u8(1);
    w.fixed(anchor.call.contract, HASH_SIZE);
    w.string(anchor.call.action, MAX_ACTION_BYTES);
    w.bytes(anchor.call.args, MAX_EXECUTE_ARGS_BYTES);
  } else {
    w.u8(0);
  }
}

function readAnchorBody(r: Reader): Omit<AnchorPayload, 'kind' | 'signatures'> {
  const appId = r.string(MAX_APP_ID_BYTES);
  const epoch = r.u64();
  const appHeight = r.u64();
  const stateRoot = r.fixed(HASH_SIZE);
  const hasCall = r.u8();
  if (hasCall > 1) throw new WireError(`invalid anchor call flag: ${hasCall}`);
  if (hasCall === 0) return { appId, epoch, appHeight, stateRoot };
  return {
    appId,
    epoch,
    appHeight,
    stateRoot,
    call: {
      contract: r.fixed(HASH_SIZE),
      action: r.string(MAX_ACTION_BYTES),
      args: r.bytes(MAX_EXECUTE_ARGS_BYTES),
    },
  };
}

/**
 * Domain-separated preimage each app-chain validator signs to attest an
 * anchor (app-chains spec §2.2). Binds the L1 chain id, the app, the
 * epoch, the attested head, and the outcome call — a signature is valid
 * for exactly one anchor on exactly one network.
 */
export function anchorSigningBytes(
  l1ChainId: string,
  anchor: Omit<AnchorPayload, 'kind' | 'signatures'>,
): Uint8Array {
  const w = new Writer();
  w.raw(utf8(DOMAIN_ANCHOR));
  w.string(l1ChainId, MAX_CHAIN_ID_BYTES);
  writeAnchorBody(w, anchor);
  return w.finish();
}

function readAppRecord(r: Reader): AppRecord {
  return {
    appId: r.string(MAX_APP_ID_BYTES),
    pearKey: r.fixed(PUBKEY_SIZE),
    version: r.string(MAX_VERSION_BYTES),
    contractAddress: r.fixed(HASH_SIZE),
    metadataHash: r.fixed(HASH_SIZE),
    chainValidators: r.array(MAX_APP_VALIDATORS, (r) => r.fixed(PUBKEY_SIZE)),
  };
}

function readPayload(r: Reader): Payload {
  const tag = r.u8();
  switch (tag) {
    case PAYLOAD_TAG_TRANSFER:
      return { kind: 'transfer', to: r.fixed(PUBKEY_SIZE), amount: r.u64() };
    case PAYLOAD_TAG_DEPLOY_CONTRACT:
      return { kind: 'deploy_contract', code: r.bytes(MAX_CONTRACT_CODE_BYTES) };
    case PAYLOAD_TAG_EXECUTE_CONTRACT:
      return {
        kind: 'execute_contract',
        contract: r.fixed(HASH_SIZE),
        value: r.u64(),
        action: r.string(MAX_ACTION_BYTES),
        args: r.bytes(MAX_EXECUTE_ARGS_BYTES),
      };
    case PAYLOAD_TAG_REGISTER_APP:
      return { kind: 'register_app', ...readAppRecord(r) };
    case PAYLOAD_TAG_UPDATE_APP:
      return { kind: 'update_app', ...readAppRecord(r) };
    case PAYLOAD_TAG_ANCHOR: {
      const body = readAnchorBody(r);
      const signatures = r.array(MAX_APP_VALIDATORS, (r) => ({
        validator: r.fixed(PUBKEY_SIZE),
        signature: r.fixed(SIGNATURE_SIZE),
      }));
      return { kind: 'anchor', ...body, signatures };
    }
    default:
      throw new WireError(`unknown payload tag: ${tag}`);
  }
}

/** Standalone payload codec (wallet-daemon IPC and tooling). */
export function encodePayload(payload: Payload): Uint8Array {
  const w = new Writer();
  writePayload(w, payload);
  return w.finish();
}

export function decodePayload(bytes: Uint8Array): Payload {
  const r = new Reader(bytes);
  const payload = readPayload(r);
  r.finish();
  return payload;
}

function writeUnsigned(w: Writer, tx: UnsignedTransaction): void {
  w.string(tx.chainId, MAX_CHAIN_ID_BYTES);
  w.u64(tx.nonce);
  w.fixed(tx.sender, PUBKEY_SIZE);
  w.u64(tx.maxFee);
  writePayload(w, tx.payload);
}

/**
 * Domain-separated preimage the sender signs. This is the exact byte string
 * passed to Ed25519; the crypto package hashes/signs it without re-encoding.
 */
export function transactionSigningBytes(tx: UnsignedTransaction): Uint8Array {
  const w = new Writer();
  w.raw(utf8(DOMAIN_TX));
  writeUnsigned(w, tx);
  return w.finish();
}

export function transactionSigningBytesFromEncoded(encoded: Uint8Array): Uint8Array {
  if (encoded.length < SIGNATURE_SIZE) {
    throw new WireError(`encoded transaction too short: ${encoded.length}`);
  }
  const domain = utf8(DOMAIN_TX);
  const unsignedLength = encoded.length - SIGNATURE_SIZE;
  const bytes = new Uint8Array(domain.length + unsignedLength);
  bytes.set(domain);
  bytes.set(encoded.subarray(0, unsignedLength), domain.length);
  return bytes;
}

export function encodeTransaction(tx: Transaction): Uint8Array {
  const w = new Writer();
  writeUnsigned(w, tx);
  w.fixed(tx.signature, SIGNATURE_SIZE);
  const bytes = w.finish();
  if (bytes.length > MAX_TX_BYTES) {
    throw new WireError(`transaction size ${bytes.length} exceeds limit ${MAX_TX_BYTES}`);
  }
  return bytes;
}

export function decodeTransaction(bytes: Uint8Array): Transaction {
  if (bytes.length > MAX_TX_BYTES) {
    throw new WireError(`transaction size ${bytes.length} exceeds limit ${MAX_TX_BYTES}`);
  }
  const r = new Reader(bytes);
  const tx = readTransaction(r);
  r.finish();
  return tx;
}

/** Decode a transaction embedded in a larger structure (does not check trailing bytes). */
export function readTransaction(r: Reader): Transaction {
  return {
    chainId: r.string(MAX_CHAIN_ID_BYTES),
    nonce: r.u64(),
    sender: r.fixed(PUBKEY_SIZE),
    maxFee: r.u64(),
    payload: readPayload(r),
    signature: r.fixed(SIGNATURE_SIZE),
  };
}

/** Encode a transaction into an enclosing structure. */
export function writeTransaction(w: Writer, tx: Transaction): void {
  writeUnsigned(w, tx);
  w.fixed(tx.signature, SIGNATURE_SIZE);
}
