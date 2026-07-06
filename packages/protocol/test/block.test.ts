import { describe, expect, it } from 'vitest';
import {
  DOMAIN_BLOCK,
  DOMAIN_VOTE,
  WireError,
  blockHeaderSigningBytes,
  decodeBlock,
  decodeBlockHeader,
  decodeVote,
  encodeBlock,
  encodeBlockHeader,
  encodeVote,
  voteSigningBytes,
} from '../src/index.js';
import { block, header, vote } from './fixtures.js';

describe('block encoding', () => {
  it('round-trips a header', () => {
    expect(decodeBlockHeader(encodeBlockHeader(header()))).toEqual(header());
  });

  it('round-trips a block with transactions', () => {
    expect(decodeBlock(encodeBlock(block()))).toEqual(block());
  });

  it('round-trips an empty block', () => {
    const empty = { ...block(), txs: [] };
    expect(decodeBlock(encodeBlock(empty))).toEqual(empty);
  });

  it('header signing bytes are domain-separated from the encoded header', () => {
    const signing = blockHeaderSigningBytes(header());
    const encoded = encodeBlockHeader(header());
    expect(signing.length).toBe(encoded.length + DOMAIN_BLOCK.length);
    expect(signing.subarray(DOMAIN_BLOCK.length)).toEqual(encoded);
  });

  it('rejects trailing bytes after a block', () => {
    const bytes = encodeBlock(block());
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes);
    expect(() => decodeBlock(padded)).toThrow(/trailing/);
  });

  it('rejects truncated headers', () => {
    const bytes = encodeBlockHeader(header());
    expect(() => decodeBlockHeader(bytes.subarray(0, 10))).toThrow(WireError);
  });
});

describe('vote encoding', () => {
  it('round-trips a vote', () => {
    expect(decodeVote(encodeVote(vote()))).toEqual(vote());
  });

  it('vote signing bytes are domain-separated and exclude the signature', () => {
    const signing = voteSigningBytes(vote());
    const prefix = new TextDecoder().decode(signing.subarray(0, DOMAIN_VOTE.length));
    expect(prefix).toBe(DOMAIN_VOTE);
    const encoded = encodeVote(vote());
    // encoded = unsigned vote + 64-byte signature; signing = domain + unsigned vote
    expect(signing.length).toBe(DOMAIN_VOTE.length + encoded.length - 64);
  });

  it('tx and vote domains never collide', () => {
    expect(DOMAIN_VOTE).not.toBe(DOMAIN_BLOCK);
  });
});
