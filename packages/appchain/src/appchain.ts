import { generateSeed, keyPairFromSeed, type KeyPair } from '@mordecai/crypto';
import { Node } from '@mordecai/node';
import type { NodeRpcClient } from '@mordecai/rpc';
import type { Chain, Genesis } from '@mordecai/chain';
import { appChainGenesis } from './genesis.js';
import { registerCosigner } from './cosign.js';

export interface AppChainOptions {
  appId: string;
  /** The registered validator set (from the L1 registry entry). */
  chainValidators: Uint8Array[];
  /** Storage directory for this peer's copy of the app chain. */
  dir: string;
  /**
   * This peer's keypair. A validator (key in the set) produces blocks and
   * runs a co-signing endpoint; anyone else follows and serves reads.
   */
  keyPair?: KeyPair;
  bootstrap?: { host: string; port: number }[];
  blockIntervalMs?: number;
  log?: (message: string) => void;
}

/**
 * One peer's node on an app chain (app-chains spec §3.3): the existing
 * node stack instantiated with the genesis derived from the registry
 * entry. Nothing here is new consensus — the chain is a library feature
 * the app instantiates, like a feed.
 */
export class AppChain {
  private constructor(
    readonly appId: string,
    readonly genesis: Genesis,
    readonly node: Node,
    readonly isValidator: boolean,
  ) {}

  static async start(options: AppChainOptions): Promise<AppChain> {
    const genesis = appChainGenesis(options.appId, options.chainValidators);
    const keyPair = options.keyPair ?? keyPairFromSeed(generateSeed());
    const isValidator = options.chainValidators.some(
      (v) => Buffer.compare(v, keyPair.publicKey) === 0,
    );

    const node = await Node.start({
      dir: options.dir,
      genesis,
      keyPair,
      ...(options.bootstrap ? { bootstrap: options.bootstrap } : {}),
      ...(options.blockIntervalMs !== undefined
        ? { blockIntervalMs: options.blockIntervalMs }
        : {}),
      ...(options.log ? { log: options.log } : {}),
    });

    // Validators answer anchor_sign on their node endpoint (same keypair,
    // same DHT identity — a second server would collide).
    if (isValidator) {
      registerCosigner(node.rpcServer, {
        chain: node.chain,
        keyPair,
        appId: options.appId,
      });
    }

    return new AppChain(options.appId, genesis, node, isValidator);
  }

  /**
   * Join an app's chain from its L1 registry entry (spec §3.4): look up
   * the validator set, derive the genesis, start the node. The registry
   * is the root of trust — no other coordination is needed.
   */
  static async join(
    l1Rpc: NodeRpcClient,
    appId: string,
    options: Omit<AppChainOptions, 'appId' | 'chainValidators'>,
  ): Promise<AppChain> {
    const entry = await l1Rpc.getApp(appId);
    if (!entry) throw new Error(`app not registered: ${appId}`);
    const chainValidators = entry.chainValidators.map(
      (hex) => new Uint8Array(Buffer.from(hex, 'hex')),
    );
    return AppChain.start({ appId, chainValidators, ...options });
  }

  get chain(): Chain {
    return this.node.chain;
  }

  /** RPC key for submitting app transactions to this peer's node. */
  get rpcPublicKey(): Uint8Array {
    return this.node.rpcPublicKey;
  }

  /**
   * Wait until at least `count` consensus peers are connected. Call
   * before the first transaction: a proposal made into an empty mesh
   * costs a stall round before the re-broadcast heals it.
   */
  async waitForPeers(count: number, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.node.peerCount < count) {
      if (Date.now() > deadline) {
        throw new Error(
          `only ${this.node.peerCount} of ${count} app-chain peers connected after ${timeoutMs}ms`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async stop(): Promise<void> {
    await this.node.stop();
  }
}
