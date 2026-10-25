import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { KeyPair } from '@mordecai/crypto';
import { Node, readKeyFile, writeKeyFile, type NodeOptions } from '@mordecai/node';
import { NodeRpcClient } from '@mordecai/rpc';
import { genesisHash, type Chain, type Genesis } from '@mordecai/chain';
import { appChainGenesis } from './genesis.js';
import { registerCosigner } from './cosign.js';
import {
  parseConnection,
  parseSettlement,
  peerUrl,
  readConnection,
  type AppConnection,
  type SettlementConnection,
} from './connection.js';

export interface AppChainOptions {
  appId: string;
  /** Validator set supplied locally, by a peer, or by the settlement registry. */
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
  gateway?: NodeOptions['gateway'];
  feedKeys?: Uint8Array[];
  settlement?: SettlementConnection;
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
    readonly connection: AppConnection,
  ) {}

  static async start(options: AppChainOptions): Promise<AppChain> {
    const genesis = appChainGenesis(options.appId, options.chainValidators);
    mkdirSync(options.dir, { recursive: true });
    const keyPath = join(options.dir, 'peer.key');
    const keyPair =
      options.keyPair ?? (existsSync(keyPath) ? readKeyFile(keyPath) : writeKeyFile(keyPath));
    const isValidator = options.chainValidators.some(
      (v) => Buffer.compare(v, keyPair.publicKey) === 0,
    );
    const hex = (key: Uint8Array) => Buffer.from(key).toString('hex');
    const connection = parseConnection({
      version: 1,
      appId: options.appId,
      nodeKey: hex(keyPair.publicKey),
      genesisHash: hex(genesisHash(genesis)),
      chainValidators: options.chainValidators.map(hex),
      feedKeys: [...new Set((options.feedKeys ?? []).map(hex))],
      ...(options.bootstrap ? { bootstrap: options.bootstrap } : {}),
      ...(options.settlement ? { settlement: options.settlement } : {}),
    });

    const node = await Node.start({
      dir: options.dir,
      genesis,
      keyPair,
      ...(options.bootstrap ? { bootstrap: options.bootstrap } : {}),
      ...(options.blockIntervalMs !== undefined
        ? { blockIntervalMs: options.blockIntervalMs }
        : {}),
      ...(options.log ? { log: options.log } : {}),
      gateway: {
        config: { appId: options.appId, chainId: genesis.chainId },
        ...options.gateway,
        connection: { ...connection },
      },
      ...(options.feedKeys ? { feedKeys: options.feedKeys } : {}),
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

    return new AppChain(options.appId, genesis, node, isValidator, connection);
  }

  /** Direct peer discovery needs no settlement; app IDs resolve through its registry. */
  static async connect(
    target: string,
    options: Omit<AppChainOptions, 'appId' | 'chainValidators'>,
  ): Promise<AppChain> {
    const url = peerUrl(target);
    if (url) {
      const remote = await readConnection(url);
      const bootstrap = options.bootstrap ?? remote.bootstrap;
      const settlement = options.settlement ?? remote.settlement;
      return AppChain.start({
        ...options,
        appId: remote.appId,
        chainValidators: remote.chainValidators.map(
          (key) => new Uint8Array(Buffer.from(key, 'hex')),
        ),
        feedKeys: [
          ...remote.feedKeys.map((key) => new Uint8Array(Buffer.from(key, 'hex'))),
          ...(options.feedKeys ?? []),
        ],
        ...(bootstrap ? { bootstrap } : {}),
        ...(settlement ? { settlement } : {}),
      });
    }
    if (!options.settlement) {
      throw new Error(
        'Resolving an app ID requires a settlement node. Provide --settlement-node, or connect directly using a peer URL.',
      );
    }
    const settlement = parseSettlement({
      ...options.settlement,
      ...((options.settlement.bootstrap ?? options.bootstrap)
        ? { bootstrap: options.settlement.bootstrap ?? options.bootstrap }
        : {}),
    });
    const bootstrap = settlement.bootstrap;
    const rpc = NodeRpcClient.connect(new Uint8Array(Buffer.from(settlement.nodeKey, 'hex')), {
      ...(bootstrap ? { bootstrap } : {}),
    });
    try {
      const head = await rpc.getHead();
      if (settlement.chainId && settlement.chainId !== head.chainId) {
        throw new Error('settlement node belongs to a different chain');
      }
      return await AppChain.join(rpc, target, {
        ...options,
        settlement: { ...settlement, chainId: head.chainId },
      });
    } finally {
      await rpc.close();
    }
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
    return AppChain.start({
      ...options,
      appId,
      chainValidators,
      feedKeys: [new Uint8Array(Buffer.from(entry.pearKey, 'hex')), ...(options.feedKeys ?? [])],
    });
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
