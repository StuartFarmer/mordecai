import {
  Chain,
  Mempool,
  blockHash,
  rememberEncodedTransaction,
  type VerifiedBlock,
} from '@hssn/chain';
import { decodeAddress, sign, verify, type KeyPair } from '@hssn/crypto';
import {
  MAX_BLOCKS_PER_RESPONSE,
  MAX_TX_REPAIR_REQUESTS,
  decodeBlockWithTransactionBytes,
  decodeGossip,
  encodeBlock,
  encodeGossip,
  encodeTransaction,
  voteSigningBytes,
  type GossipMessage,
  type Transaction,
  type Vote,
} from '@hssn/protocol';
import type { PeerHub } from './peer-hub.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const MAX_TX_ADMISSIONS = 32;
const MAX_TX_BROADCAST_BATCH = 512;
const MAX_TX_BROADCAST_BYTES = 1024 * 1024;
const TX_BROADCAST_FLUSH_MS = 2;
const TX_REPAIR_BROADCAST_MS = 200;
const TX_REPAIR_REQUEST_TTL_MS = 1_000;
const MAX_TX_REPAIR_CACHE = 100_000;
const SYNC_RETRY_MS = 1_000;

export interface EngineOptions {
  chain: Chain;
  mempool: Mempool;
  keyPair: KeyPair;
  hub: PeerHub;
  /** How often the proposer check runs. */
  blockTimeMs?: number;
  /** Stall window before rotating to the next proposer. */
  roundTimeoutMs?: number;
  maxTxsPerBlock?: number;
  /** Prefer waiting for this many includable txs before proposing. Defaults to 1. */
  minTxsPerBlock?: number;
  /** Maximum time to wait for a fuller block before proposing a partial one. */
  maxProposalWaitMs?: number;
  /** Experimental repair path for missing mempool nonce heads. Disabled by default. */
  txRepair?: boolean;
  log?: (message: string) => void;
}

/**
 * Fixed-validator BFT (plan D3, simplified):
 * - proposer for (height, round) = validators[(height + round) mod n]
 * - a validator votes for at most ONE block hash per height (locked once
 *   cast) — two conflicting quorums are impossible under < 1/3 Byzantine
 * - a block commits with pre-commit votes from ≥ 2/3 of validators; the
 *   votes are stored as the block's finality certificate
 * - a silent proposer is skipped by round timeout
 * - peers behind the head sync via block_request/response, verifying each
 *   certificate independently
 * Full Tendermint lock/unlock (for liveness under partial failure at the
 * vote stage) is deliberately post-v1; see docs/threat-model.md.
 */
export class ConsensusEngine {
  private readonly validators: Uint8Array[];
  private readonly quorum: number;
  private round = 0;
  /** Verified proposals for the next height, by block hash. */
  private readonly proposals = new Map<string, VerifiedBlock>();
  /** Votes for the next height: blockHash -> validator -> vote. */
  private readonly votes = new Map<string, Map<string, Vote>>();
  private readonly proposalRequestAt = new Map<string, number>();
  private readonly txRepairRequestedAt = new Map<string, number>();
  private readonly allocationSenders: Uint8Array[];
  /** One vote per validator per height (equivocation guard + own lock). */
  private readonly votedBy = new Map<string, string>();
  private myVote: string | null = null;
  private tickTimer: NodeJS.Timeout | undefined;
  private roundDeadline: number | null = null;
  private proposalWaitStartedAt: number | null = null;
  private syncInFlight = false;
  private syncRequestedAt = 0;
  private bestRemoteHeight = 0n;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly txBacklog: Uint8Array[] = [];
  private txBacklogOffset = 0;
  private txAdmissions = 0;
  private readonly txIdleWaiters = new Set<() => void>();
  private readonly txBroadcastBatch: Uint8Array[] = [];
  private txBroadcastBytes = 0;
  private txBroadcastTimer: NodeJS.Timeout | undefined;
  private txRepairLastBroadcastAt = 0;
  private txRepairScanCursor = 0;
  private stopped = false;
  private readonly unsubscribe: (() => void)[] = [];

  constructor(private readonly options: EngineOptions) {
    this.validators = options.chain.genesis.validators.map(decodeAddress);
    this.allocationSenders = options.chain.genesis.allocations.map((allocation) =>
      decodeAddress(allocation.address),
    );
    if (this.validators.length === 0) throw new Error('consensus requires a validator set');
    this.quorum = Math.floor((this.validators.length * 2) / 3) + 1;
  }

  private get chain(): Chain {
    return this.options.chain;
  }

  private get mempool(): Mempool {
    return this.options.mempool;
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  /** Serialize all state transitions; gossip arrives concurrently. */
  private task<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch((err: unknown) => {
      this.log(`consensus error: ${err instanceof Error ? err.message : String(err)}`);
    });
    return run;
  }

  start(): void {
    this.unsubscribe.push(
      this.options.hub.onMessage((payload, reply) => {
        let message: GossipMessage;
        try {
          message = decodeGossip(payload);
        } catch {
          return; // malformed peer traffic
        }
        if (message.kind === 'tx') {
          this.enqueueTx(message.tx);
          return;
        }
        if (message.kind === 'tx_batch') {
          for (const tx of message.txs) this.enqueueTx(tx);
          return;
        }
        if (message.kind === 'tx_response') {
          for (const tx of message.txs) this.enqueueTx(tx);
          return;
        }
        void this.task(() => this.onGossip(message, reply));
      }),
      this.options.hub.onPeerConnected(() => {
        this.options.hub.broadcast(encodeGossip({ kind: 'hello', height: this.chain.height }));
      }),
    );
    this.tickTimer = setInterval(() => {
      void this.task(() => this.tick());
    }, this.options.blockTimeMs ?? 300);
    this.tickTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.txBroadcastTimer) clearTimeout(this.txBroadcastTimer);
    for (const un of this.unsubscribe) un();
    this.txBacklog.length = 0;
    await this.queue;
    await this.waitForTxIdle();
  }

  get isValidatorNode(): boolean {
    return this.validators.some((v) => Buffer.compare(v, this.options.keyPair.publicKey) === 0);
  }

  private proposerFor(height: bigint, round: number): Uint8Array {
    return this.validators[Number((height + BigInt(round)) % BigInt(this.validators.length))]!;
  }

  private get nextHeight(): bigint {
    return this.chain.height + 1n;
  }

  /** Gossip a locally-submitted transaction to peers. */
  broadcastTx(tx: Transaction): void {
    this.broadcastTxBytes(encodeTransaction(tx));
  }

  /** Gossip canonical transaction bytes without re-encoding the transaction. */
  broadcastTxBytes(tx: Uint8Array): void {
    if (this.stopped) return;
    if (tx.length > MAX_TX_BROADCAST_BYTES) {
      this.flushTxBroadcast();
      this.options.hub.broadcast(encodeGossip({ kind: 'tx', tx }));
      return;
    }
    if (
      this.txBroadcastBatch.length > 0 &&
      (this.txBroadcastBatch.length >= MAX_TX_BROADCAST_BATCH ||
        this.txBroadcastBytes + tx.length > MAX_TX_BROADCAST_BYTES)
    ) {
      this.flushTxBroadcast();
    }
    this.txBroadcastBatch.push(tx);
    this.txBroadcastBytes += tx.length;
    if (
      this.txBroadcastBatch.length >= MAX_TX_BROADCAST_BATCH ||
      this.txBroadcastBytes >= MAX_TX_BROADCAST_BYTES
    ) {
      this.flushTxBroadcast();
      return;
    }
    this.txBroadcastTimer ??= setTimeout(() => this.flushTxBroadcast(), TX_BROADCAST_FLUSH_MS);
    this.txBroadcastTimer.unref();
  }

  private flushTxBroadcast(): void {
    if (this.txBroadcastTimer) {
      clearTimeout(this.txBroadcastTimer);
      this.txBroadcastTimer = undefined;
    }
    if (this.txBroadcastBatch.length === 0) return;
    const txs = this.txBroadcastBatch.splice(0);
    this.txBroadcastBytes = 0;
    this.options.hub.broadcast(
      encodeGossip(txs.length === 1 ? { kind: 'tx', tx: txs[0]! } : { kind: 'tx_batch', txs }),
    );
  }

  private enqueueTx(tx: Uint8Array): void {
    if (this.stopped) return;
    this.txBacklog.push(tx);
    this.drainTxBacklog();
  }

  private drainTxBacklog(): void {
    while (
      !this.stopped &&
      this.txAdmissions < MAX_TX_ADMISSIONS &&
      this.txBacklogOffset < this.txBacklog.length
    ) {
      const tx = this.txBacklog[this.txBacklogOffset++]!;
      this.txAdmissions += 1;
      void this.mempool
        .addEncoded(tx)
        .catch(() => {
          // duplicate/invalid gossip is expected noise
        })
        .finally(() => {
          this.txAdmissions -= 1;
          if (this.txBacklogOffset > 1024 && this.txBacklogOffset * 2 > this.txBacklog.length) {
            this.txBacklog.splice(0, this.txBacklogOffset);
            this.txBacklogOffset = 0;
          }
          this.drainTxBacklog();
          this.resolveTxIdle();
        });
    }
    this.resolveTxIdle();
  }

  private resolveTxIdle(): void {
    if (this.txAdmissions > 0 || this.txBacklogOffset < this.txBacklog.length) return;
    for (const resolve of this.txIdleWaiters) resolve();
    this.txIdleWaiters.clear();
  }

  private waitForTxIdle(): Promise<void> {
    if (this.txAdmissions === 0 && this.txBacklogOffset >= this.txBacklog.length) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.txIdleWaiters.add(resolve));
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    if (
      this.bestRemoteHeight > this.chain.height &&
      (!this.syncInFlight || now - this.syncRequestedAt > SYNC_RETRY_MS)
    ) {
      this.requestBlocksFromMesh();
      return;
    }

    // Round rotation on stall.
    if (this.roundDeadline !== null && now > this.roundDeadline) {
      this.round += 1;
      this.roundDeadline = now + (this.options.roundTimeoutMs ?? 3_000);
      this.proposalWaitStartedAt = null;
      this.log(`height ${this.nextHeight}: round ${this.round} (proposer stalled)`);
    }

    const pendingWork = this.mempool.size > 0 || this.proposals.size > 0;
    if (this.roundDeadline === null && pendingWork) {
      this.roundDeadline = now + (this.options.roundTimeoutMs ?? 3_000);
    }
    if (!pendingWork) {
      this.roundDeadline = null;
      this.proposalWaitStartedAt = null;
    }

    // Propose if it's our turn and there is something to seal.
    const amProposer =
      this.isValidatorNode &&
      Buffer.compare(
        this.proposerFor(this.nextHeight, this.round),
        this.options.keyPair.publicKey,
      ) === 0;
    if (amProposer && this.mempool.size > 0 && !this.myVote) {
      const maxTxs = this.options.maxTxsPerBlock ?? 1_000;
      const minTxs = Math.min(this.options.minTxsPerBlock ?? 1, maxTxs);
      const txs = await this.mempool.takeForBlock(maxTxs);
      if (txs.length === 0) {
        if (this.options.txRepair) await this.requestMissingTxs(minTxs, now);
        return;
      }
      const maxWaitMs = this.options.maxProposalWaitMs ?? 0;
      if (txs.length < minTxs && maxWaitMs > 0) {
        this.proposalWaitStartedAt ??= now;
        if (this.options.txRepair) await this.requestMissingTxs(minTxs - txs.length, now);
        if (now - this.proposalWaitStartedAt < maxWaitMs) return;
      }
      this.proposalWaitStartedAt = null;
      const draft = await this.chain.draftBlock(txs, this.options.keyPair);
      if (draft.block.txs.length === 0) return;
      const hashHex = hex(blockHash(draft.block.header));
      this.proposals.set(hashHex, draft.verified);
      this.options.hub.broadcast(
        encodeGossip({ kind: 'proposal', round: this.round, block: encodeBlock(draft.block) }),
      );
      this.log(`height ${this.nextHeight}: proposed ${draft.block.txs.length} tx(s)`);
      this.castVote(hashHex);
      await this.checkQuorum();
    }
  }

  private castVote(hashHex: string): void {
    if (this.myVote !== null) return; // locked for this height
    if (!this.isValidatorNode) return;
    this.myVote = hashHex;
    const unsigned = {
      chainId: this.chain.chainId,
      height: this.nextHeight,
      round: this.round,
      blockHash: new Uint8Array(Buffer.from(hashHex, 'hex')),
      validator: this.options.keyPair.publicKey,
    };
    const vote: Vote = {
      ...unsigned,
      signature: sign(voteSigningBytes(unsigned), this.options.keyPair.secretKey),
    };
    this.recordVote(vote);
    this.options.hub.broadcast(encodeGossip({ kind: 'vote', vote }));
  }

  private recordVote(vote: Vote): boolean {
    const validatorHex = hex(vote.validator);
    const hashHex = hex(vote.blockHash);
    const already = this.votedBy.get(validatorHex);
    if (already !== undefined) {
      if (already !== hashHex) this.log(`equivocation by ${validatorHex.slice(0, 12)}…`);
      return false;
    }
    this.votedBy.set(validatorHex, hashHex);
    let byValidator = this.votes.get(hashHex);
    if (!byValidator) {
      byValidator = new Map();
      this.votes.set(hashHex, byValidator);
    }
    byValidator.set(validatorHex, vote);
    return true;
  }

  private async onGossip(
    message: GossipMessage,
    reply: (payload: Uint8Array) => void,
  ): Promise<void> {
    if (this.stopped) return;
    switch (message.kind) {
      case 'hello':
        if (message.height > this.chain.height) {
          this.bestRemoteHeight =
            message.height > this.bestRemoteHeight ? message.height : this.bestRemoteHeight;
          this.requestBlocks(reply);
        }
        return;
      case 'tx':
        return;
      case 'tx_batch':
        return;
      case 'tx_request':
        return this.onTxRequest(message.items, reply);
      case 'tx_response':
        return;
      case 'proposal':
        return this.onProposal(message.round, message.block);
      case 'vote':
        return this.onVote(message.vote, reply);
      case 'proposal_request':
        return this.onProposalRequest(message.height, message.blockHash, reply);
      case 'proposal_response':
        return this.onProposal(message.round, message.block);
      case 'block_request':
        return this.onBlockRequest(message.from, message.count, reply);
      case 'block_response':
        return this.onBlockResponse(message.items);
    }
  }

  private async onProposal(round: number, blockBytes: Uint8Array): Promise<void> {
    let block;
    try {
      const decoded = decodeBlockWithTransactionBytes(blockBytes);
      block = decoded.block;
      for (const [index, tx] of block.txs.entries()) {
        rememberEncodedTransaction(tx, decoded.txBytes[index]!);
      }
    } catch {
      return;
    }
    if (block.header.height !== this.nextHeight) return;
    const expected = this.proposerFor(this.nextHeight, round);
    if (Buffer.compare(block.header.proposer, expected) !== 0) {
      this.log(`height ${this.nextHeight}: proposal from wrong proposer for round ${round}`);
      return;
    }
    const hashHex = hex(blockHash(block.header));
    if (!this.proposals.has(hashHex)) {
      try {
        this.proposals.set(hashHex, await this.chain.verifyBlock(block));
      } catch (err) {
        this.log(
          `height ${this.nextHeight}: invalid proposal: ${err instanceof Error ? err.message : err}`,
        );
        return;
      }
    }
    this.castVote(hashHex);
    await this.checkQuorum();
  }

  private async onVote(vote: Vote, reply: (payload: Uint8Array) => void): Promise<void> {
    if (vote.chainId !== this.chain.chainId) return;
    if (vote.height !== this.nextHeight) {
      if (vote.height > this.nextHeight) {
        this.bestRemoteHeight =
          vote.height > this.bestRemoteHeight ? vote.height : this.bestRemoteHeight;
        this.requestBlocks(reply);
      }
      return;
    }
    if (!this.validators.some((v) => Buffer.compare(v, vote.validator) === 0)) return;
    const { signature, ...unsigned } = vote;
    if (!verify(signature, voteSigningBytes(unsigned), vote.validator)) return;
    const recorded = this.recordVote(vote);
    const hashHex = hex(vote.blockHash);
    if (!this.proposals.has(hashHex)) {
      this.requestProposal(vote.height, vote.blockHash, reply);
    }
    if (recorded) await this.checkQuorum();
  }

  private requestProposal(
    height: bigint,
    blockHashBytes: Uint8Array,
    reply: (payload: Uint8Array) => void,
  ): void {
    const hashHex = hex(blockHashBytes);
    const now = Date.now();
    const last = this.proposalRequestAt.get(hashHex) ?? 0;
    if (now - last < 1_000) return;
    this.proposalRequestAt.set(hashHex, now);
    reply(encodeGossip({ kind: 'proposal_request', height, blockHash: blockHashBytes }));
  }

  private shouldRequestTx(sender: Uint8Array, nonce: bigint, now: number): boolean {
    const key = `${hex(sender)}:${nonce}`;
    const last = this.txRepairRequestedAt.get(key) ?? 0;
    if (now - last < TX_REPAIR_REQUEST_TTL_MS) return false;
    this.txRepairRequestedAt.set(key, now);
    if (this.txRepairRequestedAt.size > MAX_TX_REPAIR_CACHE) {
      for (const [cachedKey, requestedAt] of this.txRepairRequestedAt) {
        if (now - requestedAt > TX_REPAIR_REQUEST_TTL_MS) this.txRepairRequestedAt.delete(cachedKey);
        if (this.txRepairRequestedAt.size <= MAX_TX_REPAIR_CACHE) break;
      }
    }
    return true;
  }

  private async requestMissingTxs(desiredCount: number, now: number): Promise<void> {
    if (now - this.txRepairLastBroadcastAt < TX_REPAIR_BROADCAST_MS) return;
    const limit = Math.min(MAX_TX_REPAIR_REQUESTS, Math.max(1, desiredCount));
    const items: { sender: Uint8Array; nonce: bigint }[] = [];
    const push = (sender: Uint8Array, nonce: bigint) => {
      if (items.length >= limit) return;
      if (this.mempool.hasPending(sender, nonce)) return;
      if (!this.shouldRequestTx(sender, nonce, now)) return;
      items.push({ sender, nonce });
    };

    const gapRequests = await this.mempool.missingNonceRequests(limit);
    for (const item of gapRequests) push(item.sender, item.nonce);

    for (
      let scanned = 0;
      items.length < limit && scanned < this.allocationSenders.length;
      scanned += 1
    ) {
      const sender = this.allocationSenders[this.txRepairScanCursor]!;
      this.txRepairScanCursor = (this.txRepairScanCursor + 1) % this.allocationSenders.length;
      const account = await this.chain.getAccount(sender);
      push(sender, account.nonce);
    }

    if (items.length === 0) return;
    this.txRepairLastBroadcastAt = now;
    this.options.hub.broadcast(encodeGossip({ kind: 'tx_request', items }));
  }

  private onTxRequest(
    items: { sender: Uint8Array; nonce: bigint }[],
    reply: (payload: Uint8Array) => void,
  ): void {
    const txs: Uint8Array[] = [];
    for (const item of items) {
      const tx = this.mempool.getEncoded(item.sender, item.nonce);
      if (tx) txs.push(tx);
      if (txs.length >= MAX_TX_REPAIR_REQUESTS) break;
    }
    if (txs.length > 0) reply(encodeGossip({ kind: 'tx_response', txs }));
  }

  private onProposalRequest(
    height: bigint,
    blockHashBytes: Uint8Array,
    reply: (payload: Uint8Array) => void,
  ): void {
    if (height !== this.nextHeight) return;
    const hashHex = hex(blockHashBytes);
    const verified = this.proposals.get(hashHex);
    if (!verified) return;
    reply(
      encodeGossip({
        kind: 'proposal_response',
        round: this.roundForProposer(height, verified.block.header.proposer),
        block: encodeBlock(verified.block),
      }),
    );
  }

  private roundForProposer(height: bigint, proposer: Uint8Array): number {
    const proposerIndex = this.validators.findIndex(
      (validator) => Buffer.compare(validator, proposer) === 0,
    );
    if (proposerIndex < 0) return 0;
    const heightIndex = Number(height % BigInt(this.validators.length));
    return (proposerIndex - heightIndex + this.validators.length) % this.validators.length;
  }

  private async checkQuorum(): Promise<void> {
    for (const [hashHex, byValidator] of this.votes) {
      if (byValidator.size < this.quorum) continue;
      const verified = this.proposals.get(hashHex);
      if (!verified) continue; // votes outran the proposal; catch-up handles it
      const certificate = [...byValidator.values()];
      await this.chain.commitVerified(verified, certificate);
      await this.mempool.prune();
      this.log(
        `height ${verified.block.header.height}: committed ${verified.block.txs.length} tx(s) ` +
          `with ${certificate.length}/${this.validators.length} votes`,
      );
      this.advance();
      return;
    }
  }

  private advance(): void {
    this.round = 0;
    this.roundDeadline = null;
    this.proposalWaitStartedAt = null;
    this.proposals.clear();
    this.votes.clear();
    this.proposalRequestAt.clear();
    this.votedBy.clear();
    this.myVote = null;
    this.options.hub.broadcast(encodeGossip({ kind: 'hello', height: this.chain.height }));
  }

  private requestBlocks(reply: (payload: Uint8Array) => void): void {
    if (this.syncInFlight) return;
    this.syncInFlight = true;
    this.syncRequestedAt = Date.now();
    reply(
      encodeGossip({
        kind: 'block_request',
        from: this.chain.height + 1n,
        count: MAX_BLOCKS_PER_RESPONSE,
      }),
    );
  }

  private requestBlocksFromMesh(): void {
    this.syncInFlight = true;
    this.syncRequestedAt = Date.now();
    this.options.hub.broadcast(
      encodeGossip({
        kind: 'block_request',
        from: this.chain.height + 1n,
        count: MAX_BLOCKS_PER_RESPONSE,
      }),
    );
  }

  private async onBlockRequest(
    from: bigint,
    count: number,
    reply: (payload: Uint8Array) => void,
  ): Promise<void> {
    const items: { block: Uint8Array; votes: Vote[] }[] = [];
    const to = from + BigInt(Math.min(count, MAX_BLOCKS_PER_RESPONSE)) - 1n;
    for (let h = from; h <= to && h <= this.chain.height; h++) {
      const block = await this.chain.getBlock(h);
      if (!block) break;
      const votes = (await this.chain.getCertificate(h)) ?? [];
      items.push({ block: encodeBlock(block), votes });
    }
    if (items.length > 0) reply(encodeGossip({ kind: 'block_response', items }));
  }

  private async onBlockResponse(items: { block: Uint8Array; votes: Vote[] }[]): Promise<void> {
    this.syncInFlight = false;
    for (const item of items) {
      let block;
      try {
        const decoded = decodeBlockWithTransactionBytes(item.block);
        block = decoded.block;
        for (const [index, tx] of block.txs.entries()) {
          rememberEncodedTransaction(tx, decoded.txBytes[index]!);
        }
      } catch {
        return;
      }
      if (block.header.height !== this.nextHeight) continue;
      if (!this.verifyCertificate(block.header.height, blockHash(block.header), item.votes)) {
        this.log(`height ${block.header.height}: rejected sync block (bad certificate)`);
        return;
      }
      try {
        await this.chain.applyBlock(block, item.votes);
        this.advance();
      } catch (err) {
        this.log(
          `height ${block.header.height}: sync apply failed: ${err instanceof Error ? err.message : err}`,
        );
        return;
      }
    }
    await this.mempool.prune();
    if (this.bestRemoteHeight > this.chain.height) {
      // Still behind: ask the mesh again.
      this.requestBlocksFromMesh();
    }
  }

  private verifyCertificate(height: bigint, hash: Uint8Array, votes: Vote[]): boolean {
    const seen = new Set<string>();
    for (const vote of votes) {
      if (vote.chainId !== this.chain.chainId) continue;
      if (vote.height !== height) continue;
      if (Buffer.compare(vote.blockHash, hash) !== 0) continue;
      if (!this.validators.some((v) => Buffer.compare(v, vote.validator) === 0)) continue;
      const validatorHex = hex(vote.validator);
      if (seen.has(validatorHex)) continue;
      const { signature, ...unsigned } = vote;
      if (!verify(signature, voteSigningBytes(unsigned), vote.validator)) continue;
      seen.add(validatorHex);
    }
    return seen.size >= this.quorum;
  }
}
