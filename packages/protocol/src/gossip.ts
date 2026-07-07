import {
  HASH_SIZE,
  MAX_BLOCK_BYTES,
  MAX_TX_BYTES,
  MAX_TXS_PER_BLOCK,
  PUBKEY_SIZE,
} from './constants.js';
import { decodeVote, encodeVote, type Vote } from './block.js';
import { Reader, WireError, Writer } from './wire.js';

/**
 * Validator-to-validator gossip (M4 consensus). Blocks and transactions
 * travel as their canonical encoded bytes so relaying never re-encodes
 * signed material.
 */
export type GossipMessage =
  | { kind: 'hello'; height: bigint }
  | { kind: 'tx'; tx: Uint8Array }
  | { kind: 'tx_batch'; txs: Uint8Array[] }
  | { kind: 'tx_request'; items: { sender: Uint8Array; nonce: bigint }[] }
  | { kind: 'tx_response'; txs: Uint8Array[] }
  | { kind: 'proposal'; round: number; block: Uint8Array }
  | { kind: 'vote'; vote: Vote }
  | { kind: 'proposal_request'; height: bigint; blockHash: Uint8Array }
  | { kind: 'proposal_response'; round: number; block: Uint8Array }
  | { kind: 'block_request'; from: bigint; count: number }
  | { kind: 'block_response'; items: { block: Uint8Array; votes: Vote[] }[] };

const TAG_HELLO = 1;
const TAG_TX = 2;
const TAG_PROPOSAL = 3;
const TAG_VOTE = 4;
const TAG_BLOCK_REQUEST = 5;
const TAG_BLOCK_RESPONSE = 6;
const TAG_PROPOSAL_REQUEST = 7;
const TAG_PROPOSAL_RESPONSE = 8;
const TAG_TX_BATCH = 9;
const TAG_TX_REQUEST = 10;
const TAG_TX_RESPONSE = 11;

export const MAX_VOTES_PER_CERT = 1024;
export const MAX_BLOCKS_PER_RESPONSE = 256;
export const MAX_TX_REPAIR_REQUESTS = 1024;
const MAX_VOTE_BYTES = 256;

export function encodeGossip(message: GossipMessage): Uint8Array {
  const w = new Writer();
  switch (message.kind) {
    case 'hello':
      w.u8(TAG_HELLO);
      w.u64(message.height);
      break;
    case 'tx':
      w.u8(TAG_TX);
      w.bytes(message.tx, MAX_TX_BYTES);
      break;
    case 'tx_batch':
      w.u8(TAG_TX_BATCH);
      w.array(message.txs, MAX_TXS_PER_BLOCK, (wr, tx) => wr.bytes(tx, MAX_TX_BYTES));
      break;
    case 'tx_request':
      w.u8(TAG_TX_REQUEST);
      w.array(message.items, MAX_TX_REPAIR_REQUESTS, (wr, item) => {
        wr.fixed(item.sender, PUBKEY_SIZE);
        wr.u64(item.nonce);
      });
      break;
    case 'tx_response':
      w.u8(TAG_TX_RESPONSE);
      w.array(message.txs, MAX_TX_REPAIR_REQUESTS, (wr, tx) => wr.bytes(tx, MAX_TX_BYTES));
      break;
    case 'proposal':
      w.u8(TAG_PROPOSAL);
      w.u32(message.round);
      w.bytes(message.block, MAX_BLOCK_BYTES);
      break;
    case 'vote':
      w.u8(TAG_VOTE);
      w.bytes(encodeVote(message.vote), MAX_VOTE_BYTES);
      break;
    case 'proposal_request':
      w.u8(TAG_PROPOSAL_REQUEST);
      w.u64(message.height);
      w.fixed(message.blockHash, HASH_SIZE);
      break;
    case 'proposal_response':
      w.u8(TAG_PROPOSAL_RESPONSE);
      w.u32(message.round);
      w.bytes(message.block, MAX_BLOCK_BYTES);
      break;
    case 'block_request':
      w.u8(TAG_BLOCK_REQUEST);
      w.u64(message.from);
      w.u32(message.count);
      break;
    case 'block_response':
      w.u8(TAG_BLOCK_RESPONSE);
      w.array(message.items, MAX_BLOCKS_PER_RESPONSE, (wr, item) => {
        wr.bytes(item.block, MAX_BLOCK_BYTES);
        wr.array(item.votes, MAX_VOTES_PER_CERT, (wv, vote) => {
          wv.bytes(encodeVote(vote), MAX_VOTE_BYTES);
        });
      });
      break;
  }
  return w.finish();
}

export function decodeGossip(bytes: Uint8Array): GossipMessage {
  const r = new Reader(bytes);
  const tag = r.u8();
  let message: GossipMessage;
  switch (tag) {
    case TAG_HELLO:
      message = { kind: 'hello', height: r.u64() };
      break;
    case TAG_TX:
      message = { kind: 'tx', tx: r.bytes(MAX_TX_BYTES) };
      break;
    case TAG_TX_BATCH:
      message = {
        kind: 'tx_batch',
        txs: r.array(MAX_TXS_PER_BLOCK, (rr) => rr.bytes(MAX_TX_BYTES)),
      };
      break;
    case TAG_TX_REQUEST:
      message = {
        kind: 'tx_request',
        items: r.array(MAX_TX_REPAIR_REQUESTS, (rr) => ({
          sender: rr.fixed(PUBKEY_SIZE),
          nonce: rr.u64(),
        })),
      };
      break;
    case TAG_TX_RESPONSE:
      message = {
        kind: 'tx_response',
        txs: r.array(MAX_TX_REPAIR_REQUESTS, (rr) => rr.bytes(MAX_TX_BYTES)),
      };
      break;
    case TAG_PROPOSAL:
      message = { kind: 'proposal', round: r.u32(), block: r.bytes(MAX_BLOCK_BYTES) };
      break;
    case TAG_VOTE:
      message = { kind: 'vote', vote: decodeVote(r.bytes(MAX_VOTE_BYTES)) };
      break;
    case TAG_PROPOSAL_REQUEST:
      message = { kind: 'proposal_request', height: r.u64(), blockHash: r.fixed(HASH_SIZE) };
      break;
    case TAG_PROPOSAL_RESPONSE:
      message = { kind: 'proposal_response', round: r.u32(), block: r.bytes(MAX_BLOCK_BYTES) };
      break;
    case TAG_BLOCK_REQUEST: {
      const from = r.u64();
      const count = r.u32();
      if (count > MAX_BLOCKS_PER_RESPONSE) {
        throw new WireError(`block_request count ${count} exceeds ${MAX_BLOCKS_PER_RESPONSE}`);
      }
      message = { kind: 'block_request', from, count };
      break;
    }
    case TAG_BLOCK_RESPONSE:
      message = {
        kind: 'block_response',
        items: r.array(MAX_BLOCKS_PER_RESPONSE, (rr) => ({
          block: rr.bytes(MAX_BLOCK_BYTES),
          votes: rr.array(MAX_VOTES_PER_CERT, (rv) => decodeVote(rv.bytes(MAX_VOTE_BYTES))),
        })),
      };
      break;
    default:
      throw new WireError(`unknown gossip tag: ${tag}`);
  }
  r.finish();
  return message;
}
