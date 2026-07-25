import { join } from 'node:path';
import { Chain, Mempool, genesisHash } from '@hssn/chain';
import { ConsensusEngine, PeerHub } from '@hssn/consensus';
import type { KeyPair } from '@hssn/crypto';
import type { Genesis } from '@hssn/chain';
import { NodeRpcServer } from '@hssn/rpc';

export interface NodeOptions {
  dir: string;
  genesis: Genesis;
  keyPair: KeyPair;
  blockIntervalMs?: number;
  maxTxsPerBlock?: number;
  bootstrap?: { host: string; port: number }[];
  log?: (message: string) => void;
}

/**
 * A chain node. With a single genesis validator it runs the M3 sequencer
 * loop; with more it runs M4 BFT consensus over the peer mesh (topic =
 * genesis hash). Non-validator nodes in consensus mode follow and serve RPC.
 */
export class Node {
  private timer: NodeJS.Timeout | undefined;
  private producing = false;

  private constructor(
    readonly chain: Chain,
    readonly mempool: Mempool,
    private readonly rpc: NodeRpcServer,
    private readonly keyPair: KeyPair,
    private readonly maxTxsPerBlock: number,
    private readonly log: (message: string) => void,
    private readonly hub: PeerHub | undefined,
    private readonly engine: ConsensusEngine | undefined,
  ) {}

  static async start(options: NodeOptions): Promise<Node> {
    const chain = await Chain.open(join(options.dir, 'chain'), options.genesis);
    const mempool = new Mempool(chain);
    const log = options.log ?? (() => {});
    const consensusMode = options.genesis.validators.length > 1;

    let hub: PeerHub | undefined;
    let engine: ConsensusEngine | undefined;
    if (consensusMode) {
      hub = await PeerHub.create({
        topic: genesisHash(options.genesis),
        ...(options.bootstrap ? { bootstrap: options.bootstrap } : {}),
      });
      engine = new ConsensusEngine({
        chain,
        mempool,
        keyPair: options.keyPair,
        hub,
        ...(options.blockIntervalMs !== undefined ? { blockTimeMs: options.blockIntervalMs } : {}),
        maxTxsPerBlock: options.maxTxsPerBlock ?? 1_000,
        log,
      });
      engine.start();
    }

    const rpc = await NodeRpcServer.start(
      {
        chain,
        mempool,
        ...(engine ? { onTxAccepted: (tx) => engine!.broadcastTx(tx) } : {}),
      },
      {
        ...(options.bootstrap ? { bootstrap: options.bootstrap } : {}),
        keyPair: options.keyPair,
      },
    );
    const node = new Node(
      chain,
      mempool,
      rpc,
      options.keyPair,
      options.maxTxsPerBlock ?? 1_000,
      log,
      hub,
      engine,
    );
    if (!consensusMode) {
      node.timer = setInterval(() => {
        void node.tick();
      }, options.blockIntervalMs ?? 500);
      node.timer.unref();
    }
    return node;
  }

  get rpcPublicKey(): Uint8Array {
    return this.rpc.publicKey;
  }

  /** The node's RPC server, for registering additional methods on its endpoint. */
  get rpcServer(): NodeRpcServer {
    return this.rpc;
  }

  /** Connected consensus peers (0 in single-sequencer mode). */
  get peerCount(): number {
    return this.hub?.peerCount ?? 0;
  }

  private async tick(): Promise<void> {
    if (this.producing || this.mempool.size === 0) return;
    this.producing = true;
    try {
      const txs = await this.mempool.takeForBlock(this.maxTxsPerBlock);
      if (txs.length > 0) {
        const { block, skipped } = await this.chain.produceBlock(txs, this.keyPair);
        await this.mempool.prune();
        this.log(
          `block ${block.header.height}: ${block.txs.length} tx(s)` +
            (skipped.length > 0 ? `, ${skipped.length} skipped` : ''),
        );
      }
    } catch (err) {
      this.log(`block production error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.producing = false;
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.engine?.stop();
    await this.hub?.close();
    await this.rpc.close();
    await this.chain.close();
  }
}
