import { blake2b256, verify } from '@hssn/crypto';
import { encodeTransaction, transactionSigningBytes, type Transaction } from '@hssn/protocol';

/** Canonical transaction id: BLAKE2b-256 of the encoded transaction. */
export function transactionHash(tx: Transaction): Uint8Array {
  return blake2b256(encodeTransaction(tx));
}

export function verifyTransactionSignature(tx: Transaction): boolean {
  return verify(tx.signature, transactionSigningBytes(tx), tx.sender);
}
