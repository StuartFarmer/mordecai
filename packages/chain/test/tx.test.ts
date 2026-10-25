import { describe, expect, it } from 'vitest';
import { keyPairFromSeed, sign } from '@mordecai/crypto';
import { transactionSigningBytes, type Transaction } from '@mordecai/protocol';
import { transactionHash, verifyTransactionSignature } from '../src/tx.js';

describe('transaction verification cache', () => {
  it.each(['amount', 'recipient', 'signature'] as const)(
    'invalidates cached verification after changing the %s',
    (field) => {
      const key = keyPairFromSeed(new Uint8Array(32).fill(7));
      const unsigned = {
        chainId: 'cache-test',
        nonce: 0n,
        sender: key.publicKey,
        maxFee: 1_000n,
        payload: { kind: 'transfer' as const, to: key.publicKey.slice(), amount: 1n },
      };
      const tx = {
        ...unsigned,
        signature: sign(transactionSigningBytes(unsigned), key.secretKey),
      } satisfies Transaction;
      const hash = transactionHash(tx);
      expect(verifyTransactionSignature(tx)).toBe(true);

      if (field === 'amount') tx.payload.amount = 999n;
      else if (field === 'recipient') tx.payload.to[0] = tx.payload.to[0]! ^ 1;
      else tx.signature[0] = tx.signature[0]! ^ 1;

      expect(verifyTransactionSignature(tx)).toBe(false);
      expect(transactionHash(tx)).not.toEqual(hash);
    },
  );
});
