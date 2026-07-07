import { join } from 'node:path';
import { blake2b256, sign, verify, decodeAddress, type KeyPair } from '@hssn/crypto';
import {
  MAX_TXS_PER_BLOCK,
  MAX_VOTES_PER_CERT,
  PROTOCOL_VERSION,
  Reader,
  Writer,
  blockHeaderSigningBytes,
  decodeBlock,
  decodeBlockHeader,
  decodeVote,
  encodeBlock,
  encodeBlockHeader,
  encodeVote,
  type Block,
  type BlockHeader,
  type Transaction,
  type Vote,
} from '@hssn/protocol';
import {
  LevelStore,
  Overlay,
  computeStateRoot,
  computeStateRootWith,
  merkleRoot,
  type Change,
  type StateStore,
} from '@hssn/state';
import { decodeAccount, accountKey, EMPTY_ACCOUNT, type Account } from './account.js';
import {
  anchorKey,
  appKey,
  applyTransaction,
  checkInclusion,
  contractStorageKey,
  decodeAnchorRecord,
  decodeAppEntry,
  type AnchorRecord,
  type AppEntry,
  type Receipt,
} from './execution.js';
import { buildGenesisBlock, genesisChanges, genesisHash, type Genesis } from './genesis.js';
import { transactionHash } from './tx.js';

export class ChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainError';
  }
}

export interface TxRecord {
  height: bigint;
  index: number;
  receipt: Receipt;
}

export interface ProduceResult {
  block: Block;
  receipts: Receipt[];
  /** Transactions handed in but not includable (produce mode drops them). */
  skipped: { tx: Transaction; reason: string }[];
}

/** A block validated against the current head, ready to commit. */
export interface VerifiedBlock {
  block: Block;
  changes: Change[];
  receipts: Receipt[];
}

export function blockHash(header: BlockHeader): Uint8Array {
  return blake2b256(encodeBlockHeader(header));
}

const HEAD_KEY = new TextEncoder().encode('h:head');

function blockKey(height: bigint): Uint8Array {
  const key = new Uint8Array(2 + 8);
  key.set(new TextEncoder().encode('b:'));
  new DataView(key.buffer).setBigUint64(2, height, false); // big-endian: sorted by height
  return key;
}

function txKey(txHash: Uint8Array): Uint8Array {
  const key = new Uint8Array(2 + txHash.length);
  key.set(new TextEncoder().encode('t:'));
  key.set(txHash, 2);
  return key;
}

function certKey(height: bigint): Uint8Array {
  const key = new Uint8Array(2 + 8);
  key.set(new TextEncoder().encode('c:'));
  new DataView(key.buffer).setBigUint64(2, height, false);
  return key;
}

function encodeCertificate(votes: Vote[]): Uint8Array {
  const w = new Writer();
  w.array(votes, MAX_VOTES_PER_CERT, (wr, vote) => wr.bytes(encodeVote(vote), 256));
  return w.finish();
}

function decodeCertificate(bytes: Uint8Array): Vote[] {
  const r = new Reader(bytes);
  const votes = r.array(MAX_VOTES_PER_CERT, (rr) => decodeVote(rr.bytes(256)));
  r.finish();
  return votes;
}

function encodeTxRecord(record: TxRecord): Uint8Array {
  const w = new Writer(64);
  w.u64(record.height);
  w.u32(record.index);
  w.bool(record.receipt.success);
  w.string(record.receipt.error ?? '', 1024);
  w.u64(record.receipt.fee);
  w.array(record.receipt.events, 64, (wr, event) => wr.bytes(event, 4096));
  w.bytes(record.receipt.returnData, 65536);
  return w.finish();
}

function decodeTxRecord(txHash: Uint8Array, bytes: Uint8Array): TxRecord {
  const r = new Reader(bytes);
  const height = r.u64();
  const index = r.u32();
  const success = r.bool();
  const error = r.string(1024);
  const fee = r.u64();
  const events = r.array(64, (rr) => rr.bytes(4096));
  const returnData = r.bytes(65536);
  r.finish();
  return {
    height,
    index,
    receipt: { txHash, success, fee, events, returnData, ...(error === '' ? {} : { error }) },
  };
}

interface ExecOutcome {
  overlay: Overlay;
  included: Transaction[];
  receipts: Receipt[];
  skipped: { tx: Transaction; reason: string }[];
}

/**
 * The settlement chain: executes blocks against the state store and
 * persists blocks, receipts, and the head header.
 */
export class Chain {
  private constructor(
    readonly genesis: Genesis,
    private readonly stateStore: StateStore,
    private readonly blockStore: StateStore,
    private head: BlockHeader,
    private readonly validatorKeys: Uint8Array[],
  ) {}

  static async open(dir: string, genesis: Genesis): Promise<Chain> {
    const stateStore = new LevelStore(join(dir, 'state'));
    const blockStore = new LevelStore(join(dir, 'blocks'));
    const validatorKeys = genesis.validators.map(decodeAddress);

    const headRaw = await blockStore.get(HEAD_KEY);
    if (headRaw === undefined) {
      const genesisBlock = await buildGenesisBlock(genesis, stateStore);
      await stateStore.applyChanges(genesisChanges(genesis));
      await blockStore.applyChanges([
        [blockKey(0n), encodeBlock(genesisBlock)],
        [HEAD_KEY, encodeBlockHeader(genesisBlock.header)],
      ]);
      return new Chain(genesis, stateStore, blockStore, genesisBlock.header, validatorKeys);
    }

    const head = decodeBlockHeader(headRaw);
    if (head.chainId !== genesis.chainId) {
      throw new ChainError(
        `data dir belongs to chain ${head.chainId}, expected ${genesis.chainId}`,
      );
    }
    const block0 = await blockStore.get(blockKey(0n));
    if (
      block0 === undefined ||
      Buffer.compare(decodeBlock(block0).header.prevHash, genesisHash(genesis)) !== 0
    ) {
      throw new ChainError('stored chain was created from a different genesis config');
    }
    const storedRoot = await computeStateRoot(stateStore);
    if (Buffer.compare(storedRoot, head.stateRoot) !== 0) {
      throw new ChainError('state does not match head state root (corrupt data dir)');
    }
    return new Chain(genesis, stateStore, blockStore, head, validatorKeys);
  }

  get chainId(): string {
    return this.genesis.chainId;
  }

  get height(): bigint {
    return this.head.height;
  }

  get headHeader(): BlockHeader {
    return this.head;
  }

  get headHash(): Uint8Array {
    return blockHash(this.head);
  }

  isValidator(publicKey: Uint8Array): boolean {
    if (this.validatorKeys.length === 0) return true; // open devnet
    return this.validatorKeys.some((v) => Buffer.compare(v, publicKey) === 0);
  }

  async getAccount(publicKey: Uint8Array): Promise<Account> {
    const raw = await this.stateStore.get(accountKey(publicKey));
    return raw ? decodeAccount(raw) : { ...EMPTY_ACCOUNT };
  }

  async getBlock(height: bigint): Promise<Block | undefined> {
    const raw = await this.blockStore.get(blockKey(height));
    return raw === undefined ? undefined : decodeBlock(raw);
  }

  async getTxRecord(txHash: Uint8Array): Promise<TxRecord | undefined> {
    const raw = await this.blockStore.get(txKey(txHash));
    return raw === undefined ? undefined : decodeTxRecord(txHash, raw);
  }

  async getApp(appId: string): Promise<AppEntry | undefined> {
    const raw = await this.stateStore.get(appKey(appId));
    return raw === undefined ? undefined : decodeAppEntry(raw);
  }

  /** The last accepted app-chain anchor for `appId`, if any. */
  async getAnchor(appId: string): Promise<AnchorRecord | undefined> {
    const raw = await this.stateStore.get(anchorKey(appId));
    return raw === undefined ? undefined : decodeAnchorRecord(raw);
  }

  /**
   * A contract's storage entries as [inner key, value] pairs, optionally
   * narrowed to inner keys starting with `prefix`. Full scan of the state
   * store — fine at devnet scale, same trade-off as computeStateRoot.
   */
  async getContractState(
    contractId: Uint8Array,
    prefix: Uint8Array = new Uint8Array(0),
  ): Promise<[Uint8Array, Uint8Array][]> {
    const base = contractStorageKey(contractId, prefix);
    const out: [Uint8Array, Uint8Array][] = [];
    const skip = base.length - prefix.length;
    for await (const [key, value] of this.stateStore.entries()) {
      if (key.length < base.length) continue;
      if (Buffer.compare(Buffer.from(key.subarray(0, base.length)), Buffer.from(base)) !== 0) {
        continue;
      }
      out.push([key.subarray(skip), value]);
    }
    return out;
  }

  private async executeTxs(
    txs: readonly Transaction[],
    proposer: Uint8Array,
    mode: 'produce' | 'verify',
  ): Promise<ExecOutcome> {
    const overlay = new Overlay(this.stateStore);
    const included: Transaction[] = [];
    const receipts: Receipt[] = [];
    const skipped: { tx: Transaction; reason: string }[] = [];
    for (const [i, tx] of txs.entries()) {
      const reason = await checkInclusion(overlay, tx, this.chainId);
      if (reason) {
        if (mode === 'verify') throw new ChainError(`invalid tx at index ${i}: ${reason}`);
        skipped.push({ tx, reason });
        continue;
      }
      receipts.push(await applyTransaction(overlay, tx, proposer, this.head.height + 1n));
      included.push(tx);
    }
    return { overlay, included, receipts, skipped };
  }

  /**
   * Build and sign a block without committing it — the consensus proposal
   * path. Non-includable transactions are dropped.
   */
  async draftBlock(
    txs: readonly Transaction[],
    proposer: KeyPair,
    timestampMs?: bigint,
  ): Promise<ProduceResult & { verified: VerifiedBlock }> {
    if (!this.isValidator(proposer.publicKey)) {
      throw new ChainError('proposer is not in the validator set');
    }
    const outcome = await this.executeTxs(txs, proposer.publicKey, 'produce');
    const now = timestampMs ?? BigInt(Date.now());
    const header: BlockHeader = {
      version: PROTOCOL_VERSION,
      chainId: this.chainId,
      height: this.head.height + 1n,
      prevHash: this.headHash,
      timestampMs: now > this.head.timestampMs ? now : this.head.timestampMs,
      proposer: proposer.publicKey,
      txsRoot: merkleRoot(outcome.included.map(transactionHash)),
      stateRoot: await computeStateRootWith(this.stateStore, outcome.overlay.changes()),
    };
    const block: Block = {
      header,
      txs: outcome.included,
      proposerSignature: sign(blockHeaderSigningBytes(header), proposer.secretKey),
    };
    return {
      block,
      receipts: outcome.receipts,
      skipped: outcome.skipped,
      verified: { block, changes: outcome.overlay.changes(), receipts: outcome.receipts },
    };
  }

  /** Sequencer path: executes what it can, drops the rest, signs, commits. */
  async produceBlock(
    txs: readonly Transaction[],
    proposer: KeyPair,
    timestampMs?: bigint,
  ): Promise<ProduceResult> {
    const draft = await this.draftBlock(txs, proposer, timestampMs);
    await this.commitVerified(draft.verified);
    return draft;
  }

  /**
   * Fully validate a block against the current head without committing.
   * The result can be committed later (after consensus votes arrive).
   */
  async verifyBlock(block: Block): Promise<VerifiedBlock> {
    const h = block.header;
    if (h.version !== PROTOCOL_VERSION) throw new ChainError(`bad version ${h.version}`);
    if (h.chainId !== this.chainId) throw new ChainError(`bad chain id ${h.chainId}`);
    if (h.height !== this.head.height + 1n) {
      throw new ChainError(`bad height ${h.height}, head is ${this.head.height}`);
    }
    if (Buffer.compare(h.prevHash, this.headHash) !== 0) {
      throw new ChainError('prevHash does not match head');
    }
    if (h.timestampMs < this.head.timestampMs) throw new ChainError('timestamp regressed');
    if (block.txs.length > MAX_TXS_PER_BLOCK) throw new ChainError('too many txs');
    if (!this.isValidator(h.proposer)) throw new ChainError('proposer not in validator set');
    if (!verify(block.proposerSignature, blockHeaderSigningBytes(h), h.proposer)) {
      throw new ChainError('invalid proposer signature');
    }

    const outcome = await this.executeTxs(block.txs, h.proposer, 'verify');
    const txsRoot = merkleRoot(block.txs.map(transactionHash));
    if (Buffer.compare(txsRoot, h.txsRoot) !== 0) throw new ChainError('txsRoot mismatch');
    const stateRoot = await computeStateRootWith(this.stateStore, outcome.overlay.changes());
    if (Buffer.compare(stateRoot, h.stateRoot) !== 0) throw new ChainError('stateRoot mismatch');

    return { block, changes: outcome.overlay.changes(), receipts: outcome.receipts };
  }

  /** Follower/replay path: verify + commit in one step. */
  async applyBlock(block: Block, certificate?: Vote[]): Promise<Receipt[]> {
    const verified = await this.verifyBlock(block);
    await this.commitVerified(verified, certificate);
    return verified.receipts;
  }

  /**
   * Persist a block previously validated by verifyBlock/draftBlock. The
   * verified result must be against the current head.
   */
  async commitVerified(verified: VerifiedBlock, certificate?: Vote[]): Promise<void> {
    const { block, changes, receipts } = verified;
    if (block.header.height !== this.head.height + 1n) {
      throw new ChainError('verified block is stale');
    }
    // State first, then block metadata; Chain.open detects a crash between
    // the two via the state-root consistency check.
    await this.stateStore.applyChanges(changes);
    const metaChanges: Change[] = [[blockKey(block.header.height), encodeBlock(block)]];
    receipts.forEach((receipt, index) => {
      metaChanges.push([
        txKey(receipt.txHash),
        encodeTxRecord({ height: block.header.height, index, receipt }),
      ]);
    });
    if (certificate && certificate.length > 0) {
      metaChanges.push([certKey(block.header.height), encodeCertificate(certificate)]);
    }
    metaChanges.push([HEAD_KEY, encodeBlockHeader(block.header)]);
    await this.blockStore.applyChanges(metaChanges);
    this.head = block.header;
  }

  /** Quorum votes recorded when the block finalized (absent for M3 sequencer blocks). */
  async getCertificate(height: bigint): Promise<Vote[] | undefined> {
    const raw = await this.blockStore.get(certKey(height));
    return raw === undefined ? undefined : decodeCertificate(raw);
  }

  async close(): Promise<void> {
    await this.stateStore.close();
    await this.blockStore.close();
  }
}
