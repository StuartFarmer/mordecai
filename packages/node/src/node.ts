import { join } from 'node:path';
import { Chain, Mempool, genesisHash } from '@mordecai/chain';
import { ConsensusEngine, PeerHub } from '@mordecai/consensus';
import type { KeyPair } from '@mordecai/crypto';
import type { Genesis } from '@mordecai/chain';
import { NodeRpcServer } from '@mordecai/rpc';
import { Gateway, type GatewayOptions } from '@mordecai/gateway';
import { Network } from '@mordecai/networking';

export interface NodeOptions {
  dir: string;
  genesis: Genesis;
  keyPair: KeyPair;
  blockIntervalMs?: number;
  maxTxsPerBlock?: number;
  bootstrap?: { host: string; port: number }[];
  log?: (message: string) => void;
  gateway?: Omit<GatewayOptions, 'nodeKey' | 'bootstrap'>;
  /** App-selected feeds to download continuously and serve to other peers. */
  feedKeys?: Uint8Array[];
}

/**
 * Every node verifies, stores and serves chain state, seeds selected feeds,
 * and provides HTTP access. Only keys in genesis participate in voting.
 */
export class Node {
  private constructor(
    readonly chain: Chain,
    readonly mempool: Mempool,
    private readonly rpc: NodeRpcServer,
    private readonly hub: PeerHub,
    private readonly engine: ConsensusEngine,
    readonly network: Network,
    readonly gateway: Gateway,
  ) {}

  static async start(options: NodeOptions): Promise<Node> {
    const chain = await Chain.open(join(options.dir, 'chain'), options.genesis);
    const mempool = new Mempool(chain);
    const log = options.log ?? (() => {});
    let hub: PeerHub | undefined;
    let engine: ConsensusEngine | undefined;
    let rpc: NodeRpcServer | undefined;
    let gateway: Gateway | undefined;
    const network = Network.create({
      storageDir: join(options.dir, 'feeds'),
      ...(options.bootstrap ? { bootstrap: options.bootstrap } : {}),
    });
    try {
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
      rpc = await NodeRpcServer.start(
        {
          chain,
          mempool,
          onTxAccepted: (tx) => engine!.broadcastTx(tx),
        },
        {
          ...(options.bootstrap ? { bootstrap: options.bootstrap } : {}),
          keyPair: options.keyPair,
        },
      );
      gateway = await Gateway.start({
        config: { chainId: chain.chainId },
        ...options.gateway,
        nodeKey: rpc.publicKey,
        ...(options.bootstrap ? { bootstrap: options.bootstrap } : {}),
      });
      for (const key of options.feedKeys ?? []) await network.seedFeed(key);
      return new Node(chain, mempool, rpc, hub, engine, network, gateway);
    } catch (err) {
      await gateway?.close();
      await engine?.stop();
      await hub?.close();
      await rpc?.close();
      await network.close();
      await chain.close();
      throw err;
    }
  }

  get rpcPublicKey(): Uint8Array {
    return this.rpc.publicKey;
  }

  /** The node's RPC server, for registering additional methods on its endpoint. */
  get rpcServer(): NodeRpcServer {
    return this.rpc;
  }

  get isValidator(): boolean {
    return this.engine.isValidatorNode;
  }

  /** Connected validators and ordinary peers on this chain. */
  get peerCount(): number {
    return this.hub.peerCount;
  }

  async stop(): Promise<void> {
    await this.gateway.close();
    await this.engine.stop();
    await this.hub.close();
    await this.rpc.close();
    await this.network.close();
    await this.chain.close();
  }
}
