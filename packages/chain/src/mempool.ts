import { decodeTransaction, encodeTransaction, type Transaction } from '@hssn/protocol';
import { VALIDATE_OK, VmRuntime, validationError } from '@hssn/vm';
import type { Chain } from './chain.js';
import { checkStateless, requiredBalance } from './execution.js';
import { rememberEncodedTransaction, transactionHash, type TransactionFacts } from './tx.js';

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
  encoded: Uint8Array;
}

export interface MissingNonceRequest {
  sender: Uint8Array;
  nonce: bigint;
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
    return this.addEncoded(encodeTransaction(tx));
  }

  /** Validate and admit a canonical encoded transaction; returns its hash. */
  async addEncoded(encoded: Uint8Array): Promise<Uint8Array> {
    const tx = decodeTransaction(encoded);
    const facts = rememberEncodedTransaction(tx, encoded);
    return this.addDecoded(tx, facts, encoded);
  }

  private async addDecoded(
    tx: Transaction,
    facts: TransactionFacts,
    encoded: Uint8Array,
  ): Promise<Uint8Array> {
    const stateless = checkStateless(tx, this.chain.chainId, facts);
    if (stateless) throw new MempoolError(stateless);
    switch (tx.payload.kind) {
      case 'transfer':
      case 'execute_contract':
      case 'register_app':
      case 'update_app':
        break;
      case 'deploy_contract': {
        const status = VmRuntime.validate(tx.payload.code);
        if (status !== VALIDATE_OK) {
          throw new MempoolError(`invalid contract: ${validationError(status)}`);
        }
        break;
      }
    }

    const account = await this.chain.getAccount(tx.sender);
    if (tx.nonce < account.nonce) {
      throw new MempoolError(`nonce too low: tx ${tx.nonce}, account ${account.nonce}`);
    }
    if (account.balance < requiredBalance(tx, facts)) {
      throw new MempoolError('balance cannot cover fee reserve');
    }

    const senderHex = hex(tx.sender);
    let pending = this.bySender.get(senderHex);
    if (!pending) {
      pending = new Map();
      this.bySender.set(senderHex, pending);
    } else {
      this.pruneSender(pending, account.nonce);
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
    pending.set(tx.nonce, { tx, hashHex: hex(hash), encoded });
    this.count += 1;
    return hash;
  }

  private pruneSender(pending: Map<bigint, PendingTx>, nonce: bigint): void {
    for (const pendingNonce of [...pending.keys()]) {
      if (pendingNonce < nonce) {
        pending.delete(pendingNonce);
        this.count -= 1;
      }
    }
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

  hasPending(sender: Uint8Array, nonce: bigint): boolean {
    return this.bySender.get(hex(sender))?.has(nonce) ?? false;
  }

  getEncoded(sender: Uint8Array, nonce: bigint): Uint8Array | undefined {
    return this.bySender.get(hex(sender))?.get(nonce)?.encoded;
  }

  /**
   * Find nonce gaps that are blocking locally known future transactions.
   * These are cheap, high-confidence repair requests because a higher nonce
   * proves this node is missing an earlier transaction from the same sender.
   */
  async missingNonceRequests(maxCount: number): Promise<MissingNonceRequest[]> {
    const requests: MissingNonceRequest[] = [];
    for (const senderHex of [...this.bySender.keys()].sort()) {
      const pending = this.bySender.get(senderHex)!;
      const first = pending.values().next().value;
      if (!first) continue;
      const account = await this.chain.getAccount(first.tx.sender);
      this.pruneSender(pending, account.nonce);
      if (pending.size === 0) {
        this.bySender.delete(senderHex);
        continue;
      }

      let nonce = account.nonce;
      while (pending.has(nonce)) nonce += 1n;
      if ([...pending.keys()].some((pendingNonce) => pendingNonce > nonce)) {
        requests.push({ sender: first.tx.sender, nonce });
        if (requests.length >= maxCount) return requests;
      }
    }
    return requests;
  }

  /** Drop everything the chain has moved past (call after each block). */
  async prune(): Promise<void> {
    for (const [senderHex, pending] of this.bySender) {
      const account = await this.chain.getAccount(pending.values().next().value!.tx.sender);
      this.pruneSender(pending, account.nonce);
      if (pending.size === 0) this.bySender.delete(senderHex);
    }
  }
}
