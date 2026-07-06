import type { Transaction } from '@hssn/protocol';
import type { Chain } from './chain.js';
import { checkStateless, computeFee } from './execution.js';
import { transactionHash } from './tx.js';

export class MempoolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MempoolError';
  }
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

interface PendingTx {
  tx: Transaction;
  hashHex: string;
}

/**
 * Pending transactions, indexed per sender by nonce. Admission re-checks
 * everything a proposer would; state can still drift between admission and
 * inclusion, which produceBlock handles by dropping stale transactions.
 */
export class Mempool {
  private readonly bySender = new Map<string, Map<bigint, PendingTx>>();
  private count = 0;

  constructor(
    private readonly chain: Chain,
    private readonly maxPerSender = 64,
  ) {}

  get size(): number {
    return this.count;
  }

  /** Validate and admit a transaction; returns its hash. */
  async add(tx: Transaction): Promise<Uint8Array> {
    const stateless = checkStateless(tx, this.chain.chainId);
    if (stateless) throw new MempoolError(stateless);
    if (tx.payload.kind !== 'transfer') {
      throw new MempoolError(`unsupported payload kind: ${tx.payload.kind}`);
    }

    const account = await this.chain.getAccount(tx.sender);
    if (tx.nonce < account.nonce) {
      throw new MempoolError(`nonce too low: tx ${tx.nonce}, account ${account.nonce}`);
    }
    if (account.balance < computeFee(tx)) {
      throw new MempoolError('balance cannot cover fee');
    }

    const senderHex = hex(tx.sender);
    let pending = this.bySender.get(senderHex);
    if (!pending) {
      pending = new Map();
      this.bySender.set(senderHex, pending);
    }
    const hash = transactionHash(tx);
    const existing = pending.get(tx.nonce);
    if (existing) {
      if (existing.hashHex === hex(hash)) return hash; // idempotent resubmit
      throw new MempoolError(`nonce ${tx.nonce} already pending (replacement not supported)`);
    }
    if (pending.size >= this.maxPerSender) {
      throw new MempoolError(`sender has ${pending.size} pending txs (limit ${this.maxPerSender})`);
    }
    pending.set(tx.nonce, { tx, hashHex: hex(hash) });
    this.count += 1;
    return hash;
  }

  /**
   * Pick up to `maxCount` transactions for a block: senders in
   * deterministic order, contiguous nonces from each account's current nonce.
   */
  async takeForBlock(maxCount: number): Promise<Transaction[]> {
    const picked: Transaction[] = [];
    for (const senderHex of [...this.bySender.keys()].sort()) {
      const pending = this.bySender.get(senderHex)!;
      const account = await this.chain.getAccount(pending.values().next().value!.tx.sender);
      for (let nonce = account.nonce; pending.has(nonce); nonce += 1n) {
        picked.push(pending.get(nonce)!.tx);
        if (picked.length >= maxCount) return picked;
      }
    }
    return picked;
  }

  /** Drop everything the chain has moved past (call after each block). */
  async prune(): Promise<void> {
    for (const [senderHex, pending] of this.bySender) {
      const account = await this.chain.getAccount(pending.values().next().value!.tx.sender);
      for (const nonce of [...pending.keys()]) {
        if (nonce < account.nonce) {
          pending.delete(nonce);
          this.count -= 1;
        }
      }
      if (pending.size === 0) this.bySender.delete(senderHex);
    }
  }
}
