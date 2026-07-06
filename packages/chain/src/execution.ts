import { encodeTransaction, type Transaction } from '@hssn/protocol';
import { Overlay, type StateReader } from '@hssn/state';
import {
  EMPTY_ACCOUNT,
  accountKey,
  decodeAccount,
  encodeAccount,
  type Account,
} from './account.js';
import { transactionHash, verifyTransactionSignature } from './tx.js';

/** Flat fee plus per-byte charge (plan D7); WASM fuel joins in M5. */
export const FLAT_FEE = 10n;
export const FEE_PER_BYTE = 1n;

export function computeFee(tx: Transaction): bigint {
  return FLAT_FEE + FEE_PER_BYTE * BigInt(encodeTransaction(tx).length);
}

export interface Receipt {
  txHash: Uint8Array;
  success: boolean;
  /** Present when success is false. */
  error?: string;
  fee: bigint;
}

/**
 * Reasons a transaction may not be *included* in a block at all. A block
 * containing such a transaction is invalid — distinct from a transaction
 * that is includable but fails during execution (recorded in its receipt,
 * fee charged, nonce consumed).
 */
export type InclusionError = string;

async function getAccount(state: StateReader, publicKey: Uint8Array): Promise<Account> {
  const raw = await state.get(accountKey(publicKey));
  return raw ? decodeAccount(raw) : { ...EMPTY_ACCOUNT };
}

function setAccount(overlay: Overlay, publicKey: Uint8Array, account: Account): void {
  overlay.set(accountKey(publicKey), encodeAccount(account));
}

/** Checks that don't depend on state: signature and chain binding. */
export function checkStateless(tx: Transaction, chainId: string): InclusionError | null {
  if (tx.chainId !== chainId) return `wrong chain id: ${tx.chainId}`;
  if (!verifyTransactionSignature(tx)) return 'invalid signature';
  if (computeFee(tx) > tx.maxFee) return 'maxFee below required fee';
  return null;
}

/** State-dependent inclusion checks at the transaction's execution point. */
export async function checkInclusion(
  state: StateReader,
  tx: Transaction,
  chainId: string,
): Promise<InclusionError | null> {
  const stateless = checkStateless(tx, chainId);
  if (stateless) return stateless;
  if (tx.payload.kind !== 'transfer') {
    return `unsupported payload kind in this protocol version: ${tx.payload.kind}`;
  }
  const sender = await getAccount(state, tx.sender);
  if (tx.nonce !== sender.nonce) {
    return `nonce mismatch: tx ${tx.nonce}, account ${sender.nonce}`;
  }
  if (sender.balance < computeFee(tx)) return 'balance cannot cover fee';
  return null;
}

/**
 * Execute one includable transaction against `blockOverlay`.
 * Fee and nonce are always applied; the payload applies only on success.
 */
export async function applyTransaction(
  blockOverlay: Overlay,
  tx: Transaction,
  proposer: Uint8Array,
): Promise<Receipt> {
  const fee = computeFee(tx);
  const txHash = transactionHash(tx);

  // Fee + nonce are unconditional once included.
  const sender = await getAccount(blockOverlay, tx.sender);
  setAccount(blockOverlay, tx.sender, {
    balance: sender.balance - fee,
    nonce: sender.nonce + 1n,
  });
  const proposerAccount = await getAccount(blockOverlay, proposer);
  setAccount(blockOverlay, proposer, {
    ...proposerAccount,
    balance: proposerAccount.balance + fee,
  });

  // Payload effects revert as a unit on failure.
  const txOverlay = new Overlay(blockOverlay);
  const error = await executePayload(txOverlay, tx);
  if (error) return { txHash, success: false, error, fee };
  txOverlay.commitInto(blockOverlay);
  return { txHash, success: true, fee };
}

async function executePayload(overlay: Overlay, tx: Transaction): Promise<string | null> {
  switch (tx.payload.kind) {
    case 'transfer': {
      const { to, amount } = tx.payload;
      const sender = await getAccount(overlay, tx.sender);
      if (sender.balance < amount) {
        return `insufficient balance: have ${sender.balance}, need ${amount}`;
      }
      setAccount(overlay, tx.sender, { ...sender, balance: sender.balance - amount });
      const recipient = await getAccount(overlay, to);
      setAccount(overlay, to, { ...recipient, balance: recipient.balance + amount });
      return null;
    }
    default:
      return `unsupported payload kind: ${tx.payload.kind}`;
  }
}
