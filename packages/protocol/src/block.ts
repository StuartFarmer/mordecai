import {
  DOMAIN_BLOCK,
  DOMAIN_VOTE,
  HASH_SIZE,
  MAX_BLOCK_BYTES,
  MAX_CHAIN_ID_BYTES,
  MAX_TXS_PER_BLOCK,
  PUBKEY_SIZE,
  SIGNATURE_SIZE,
} from './constants.js';
import { readTransaction, writeTransaction, type Transaction } from './transaction.js';
import { Reader, WireError, Writer, utf8 } from './wire.js';

export interface BlockHeader {
  /** PROTOCOL_VERSION at the time the block was produced. */
  version: number;
  chainId: string;
  height: bigint;
  /** Hash of the previous block header; 32 zero bytes at height 0. */
  prevHash: Uint8Array;
  /** Proposer-set wall clock, validated against bounds by consensus, never used by execution. */
  timestampMs: bigint;
  /** Proposer Ed25519 public key. */
  proposer: Uint8Array;
  /** Merkle root over the transaction hashes in this block. */
  txsRoot: Uint8Array;
  /** State commitment after executing this block. */
  stateRoot: Uint8Array;
}

export interface Block {
  header: BlockHeader;
  txs: Transaction[];
  /** Proposer signature over `blockHeaderSigningBytes(header)`. */
  proposerSignature: Uint8Array;
}

/** Pre-commit for a proposed block. A block is final with votes from ≥2/3 of validators. */
export interface Vote {
  chainId: string;
  height: bigint;
  /** Consensus round at this height (0 unless proposers were skipped). */
  round: number;
  /** Hash of the block header being committed. */
  blockHash: Uint8Array;
  /** Voting validator's Ed25519 public key. */
  validator: Uint8Array;
  /** Signature over `voteSigningBytes`. */
  signature: Uint8Array;
}

function writeHeader(w: Writer, h: BlockHeader): void {
  w.u32(h.version);
  w.string(h.chainId, MAX_CHAIN_ID_BYTES);
  w.u64(h.height);
  w.fixed(h.prevHash, HASH_SIZE);
  w.u64(h.timestampMs);
  w.fixed(h.proposer, PUBKEY_SIZE);
  w.fixed(h.txsRoot, HASH_SIZE);
  w.fixed(h.stateRoot, HASH_SIZE);
}

function readHeader(r: Reader): BlockHeader {
  return {
    version: r.u32(),
    chainId: r.string(MAX_CHAIN_ID_BYTES),
    height: r.u64(),
    prevHash: r.fixed(HASH_SIZE),
    timestampMs: r.u64(),
    proposer: r.fixed(PUBKEY_SIZE),
    txsRoot: r.fixed(HASH_SIZE),
    stateRoot: r.fixed(HASH_SIZE),
  };
}

export function encodeBlockHeader(header: BlockHeader): Uint8Array {
  const w = new Writer();
  writeHeader(w, header);
  return w.finish();
}

export function decodeBlockHeader(bytes: Uint8Array): BlockHeader {
  const r = new Reader(bytes);
  const header = readHeader(r);
  r.finish();
  return header;
}

/**
 * Preimage the proposer signs. The block hash is defined as the crypto
 * package's hash of `encodeBlockHeader(header)` (not of these signing bytes).
 */
export function blockHeaderSigningBytes(header: BlockHeader): Uint8Array {
  const w = new Writer();
  w.raw(utf8(DOMAIN_BLOCK));
  writeHeader(w, header);
  return w.finish();
}

export function encodeBlock(block: Block): Uint8Array {
  const w = new Writer();
  writeHeader(w, block.header);
  w.array(block.txs, MAX_TXS_PER_BLOCK, writeTransaction);
  w.fixed(block.proposerSignature, SIGNATURE_SIZE);
  const bytes = w.finish();
  if (bytes.length > MAX_BLOCK_BYTES) {
    throw new WireError(`block size ${bytes.length} exceeds limit ${MAX_BLOCK_BYTES}`);
  }
  return bytes;
}

export function decodeBlock(bytes: Uint8Array): Block {
  if (bytes.length > MAX_BLOCK_BYTES) {
    throw new WireError(`block size ${bytes.length} exceeds limit ${MAX_BLOCK_BYTES}`);
  }
  const r = new Reader(bytes);
  const header = readHeader(r);
  const txs = r.array(MAX_TXS_PER_BLOCK, readTransaction);
  const proposerSignature = r.fixed(SIGNATURE_SIZE);
  r.finish();
  return { header, txs, proposerSignature };
}

function writeUnsignedVote(w: Writer, vote: Omit<Vote, 'signature'>): void {
  w.string(vote.chainId, MAX_CHAIN_ID_BYTES);
  w.u64(vote.height);
  w.u32(vote.round);
  w.fixed(vote.blockHash, HASH_SIZE);
  w.fixed(vote.validator, PUBKEY_SIZE);
}

export function voteSigningBytes(vote: Omit<Vote, 'signature'>): Uint8Array {
  const w = new Writer();
  w.raw(utf8(DOMAIN_VOTE));
  writeUnsignedVote(w, vote);
  return w.finish();
}

export function encodeVote(vote: Vote): Uint8Array {
  const w = new Writer();
  writeUnsignedVote(w, vote);
  w.fixed(vote.signature, SIGNATURE_SIZE);
  return w.finish();
}

export function decodeVote(bytes: Uint8Array): Vote {
  const r = new Reader(bytes);
  const vote: Vote = {
    chainId: r.string(MAX_CHAIN_ID_BYTES),
    height: r.u64(),
    round: r.u32(),
    blockHash: r.fixed(HASH_SIZE),
    validator: r.fixed(PUBKEY_SIZE),
    signature: r.fixed(SIGNATURE_SIZE),
  };
  r.finish();
  return vote;
}
