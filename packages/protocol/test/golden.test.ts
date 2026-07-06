/**
 * Golden-vector tests pin the exact canonical byte encodings. Any change to
 * these hex strings is a consensus-breaking wire format change and must be
 * treated as such (new domain versions / protocol version bump).
 *
 * Regenerate after an intentional format change with:
 *   UPDATE_VECTORS=1 pnpm --filter @hssn/protocol test
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  blockHeaderSigningBytes,
  decodeBlock,
  decodeTransaction,
  decodeVote,
  encodeBlock,
  encodeBlockHeader,
  encodeTransaction,
  encodeVote,
  transactionSigningBytes,
  voteSigningBytes,
} from '../src/index.js';
import {
  block,
  deployTx,
  executeTx,
  header,
  registerAppTx,
  transferTx,
  updateAppTx,
  vote,
} from './fixtures.js';

const vectorsPath = join(dirname(fileURLToPath(import.meta.url)), 'vectors', 'golden.json');

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function computeVectors(): Record<string, string> {
  return {
    tx_transfer: hex(encodeTransaction(transferTx())),
    tx_transfer_signing: hex(transactionSigningBytes(transferTx())),
    tx_deploy_contract: hex(encodeTransaction(deployTx())),
    tx_execute_contract: hex(encodeTransaction(executeTx())),
    tx_register_app: hex(encodeTransaction(registerAppTx())),
    tx_update_app: hex(encodeTransaction(updateAppTx())),
    block_header: hex(encodeBlockHeader(header())),
    block_header_signing: hex(blockHeaderSigningBytes(header())),
    block: hex(encodeBlock(block())),
    vote: hex(encodeVote(vote())),
    vote_signing: hex(voteSigningBytes(vote())),
  };
}

describe('golden vectors', () => {
  const computed = computeVectors();

  if (process.env.UPDATE_VECTORS) {
    it('regenerates the vector file', () => {
      writeFileSync(vectorsPath, JSON.stringify(computed, null, 2) + '\n');
      expect(true).toBe(true);
    });
    return;
  }

  const stored: Record<string, string> = JSON.parse(readFileSync(vectorsPath, 'utf8'));

  it('covers exactly the stored vector set', () => {
    expect(Object.keys(computed).sort()).toEqual(Object.keys(stored).sort());
  });

  for (const name of Object.keys(computeVectors())) {
    it(`encodes ${name} to the pinned bytes`, () => {
      expect(computed[name]).toBe(stored[name]);
    });
  }

  it('decodes pinned bytes back to the fixtures', () => {
    const fromHex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));
    expect(decodeTransaction(fromHex(stored.tx_transfer!))).toEqual(transferTx());
    expect(decodeBlock(fromHex(stored.block!))).toEqual(block());
    expect(decodeVote(fromHex(stored.vote!))).toEqual(vote());
  });
});
