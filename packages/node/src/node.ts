import { join } from 'node:path';
import { Chain, Mempool } from '@hssn/chain';
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
 * M3 single-sequencer node: chain + mempool + RPC + a block production
 * loop that seals a block whenever transactions are pending. M4 replaces
 * the loop with multi-validator consensus.
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
  ) {}

  static async start(options: NodeOptions): Promise<Node> {
    const chain = await Chain.open(join(options.dir, 'chain'), options.genesis);
    const mempool = new Mempool(chain);
    const rpc = await NodeRpcServer.start(
      { chain, mempool },
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
      options.log ?? (() => {}),
    );
    node.timer = setInterval(() => {
      void node.tick();
    }, options.blockIntervalMs ?? 500);
    node.timer.unref();
    return node;
  }

  get rpcPublicKey(): Uint8Array {
    return this.rpc.publicKey;
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
    await this.rpc.close();
    await this.chain.close();
  }
}
