import { Chain, Mempool, blockHash, type VerifiedBlock } from '@hssn/chain';
import { decodeAddress, sign, verify, type KeyPair } from '@hssn/crypto';
import {
  MAX_BLOCKS_PER_RESPONSE,
  decodeBlock,
  decodeGossip,
  decodeTransaction,
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
  /** One vote per validator per height (equivocation guard + own lock). */
  private readonly votedBy = new Map<string, string>();
  private myVote: string | null = null;
  private tickTimer: NodeJS.Timeout | undefined;
  private roundDeadline: number | null = null;
  private syncInFlight = false;
  private bestRemoteHeight = 0n;
  private queue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private readonly unsubscribe: (() => void)[] = [];

  constructor(private readonly options: EngineOptions) {
    this.validators = options.chain.genesis.validators.map(decodeAddress);
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
        void this.task(() => this.onGossip(payload, reply));
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
    for (const un of this.unsubscribe) un();
    await this.queue;
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
    this.options.hub.broadcast(encodeGossip({ kind: 'tx', tx: encodeTransaction(tx) }));
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();

    // Round rotation on stall.
    if (this.roundDeadline !== null && now > this.roundDeadline) {
      this.round += 1;
      this.roundDeadline = now + (this.options.roundTimeoutMs ?? 3_000);
      this.log(`height ${this.nextHeight}: round ${this.round} (proposer stalled)`);
    }

    const pendingWork = this.mempool.size > 0 || this.proposals.size > 0;
    if (this.roundDeadline === null && pendingWork) {
      this.roundDeadline = now + (this.options.roundTimeoutMs ?? 3_000);
    }
    if (!pendingWork) this.roundDeadline = null;

    // Propose if it's our turn and there is something to seal.
    const amProposer =
      this.isValidatorNode &&
      Buffer.compare(
        this.proposerFor(this.nextHeight, this.round),
        this.options.keyPair.publicKey,
      ) === 0;
    if (amProposer && this.mempool.size > 0 && !this.myVote) {
      const txs = await this.mempool.takeForBlock(this.options.maxTxsPerBlock ?? 1_000);
      if (txs.length === 0) return;
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

  private async onGossip(payload: Uint8Array, reply: (payload: Uint8Array) => void): Promise<void> {
    if (this.stopped) return;
    let message: GossipMessage;
    try {
      message = decodeGossip(payload);
    } catch {
      return; // malformed peer traffic
    }
    switch (message.kind) {
      case 'hello':
        if (message.height > this.chain.height) {
          this.bestRemoteHeight =
            message.height > this.bestRemoteHeight ? message.height : this.bestRemoteHeight;
          this.requestBlocks(reply);
        }
        return;
      case 'tx': {
        try {
          await this.mempool.add(decodeTransaction(message.tx));
        } catch {
          // duplicate/invalid gossip is expected noise
        }
        return;
      }
      case 'proposal':
        return this.onProposal(message.round, message.block);
      case 'vote':
        return this.onVote(message.vote, reply);
      case 'block_request':
        return this.onBlockRequest(message.from, message.count, reply);
      case 'block_response':
        return this.onBlockResponse(message.items);
    }
  }

  private async onProposal(round: number, blockBytes: Uint8Array): Promise<void> {
    let block;
    try {
      block = decodeBlock(blockBytes);
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
    if (this.recordVote(vote)) await this.checkQuorum();
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
    this.proposals.clear();
    this.votes.clear();
    this.votedBy.clear();
    this.myVote = null;
    this.options.hub.broadcast(encodeGossip({ kind: 'hello', height: this.chain.height }));
  }

  private requestBlocks(reply: (payload: Uint8Array) => void): void {
    if (this.syncInFlight) return;
    this.syncInFlight = true;
    reply(
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
        block = decodeBlock(item.block);
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
      this.syncInFlight = true;
      this.options.hub.broadcast(
        encodeGossip({
          kind: 'block_request',
          from: this.chain.height + 1n,
          count: MAX_BLOCKS_PER_RESPONSE,
        }),
      );
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
