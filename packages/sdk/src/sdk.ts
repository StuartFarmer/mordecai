import { blake2b256, decodeAddress } from '@mordecai/crypto';
import { Feed, Network } from '@mordecai/networking';
import { DOMAIN_APP_SENDER, encodeTransaction, type Payload } from '@mordecai/protocol';
import { NodeRpcClient, type AccountInfo, type AppInfo, type TxInfo } from '@mordecai/rpc';
import type { Signer } from '@mordecai/wallet';

export interface SdkOptions {
  wallet: Signer;
  /** RPC public key of any chain node. */
  nodeKey: Uint8Array;
  /** Directory for Hypercore feed storage. */
  storageDir: string;
  chainId: string;
  bootstrap?: { host: string; port: number }[];
  /** Default fee ceiling per transaction. */
  defaultMaxFee?: bigint;
}

export interface InstalledApp {
  entry: AppInfo;
  /** The verified application bundle (feed block 0). */
  bundle: Uint8Array;
}

/**
 * The L1 sender address of an app's anchored outcome calls (app-chains
 * spec §2.1). Contracts gate on it with `require(sender == config.game)`.
 * Matches `appAddress` in @mordecai/chain; kept dependency-light here so the
 * SDK stays Bare-compatible (no node/storage imports).
 */
export function appAddress(appId: string): Uint8Array {
  return blake2b256(new TextEncoder().encode(DOMAIN_APP_SENDER), new TextEncoder().encode(appId));
}

/**
 * The application-facing runtime (spec §22): every app gets identity,
 * payments, contracts, registry install, and replicated shared state,
 * without running any infrastructure of its own.
 */
export class Mordecai {
  private constructor(
    readonly wallet: Signer,
    readonly network: Network,
    private readonly rpc: NodeRpcClient,
    readonly chainId: string,
    private readonly defaultMaxFee: bigint,
  ) {}

  static connect(options: SdkOptions): Mordecai {
    const network = Network.create({
      storageDir: options.storageDir,
      ...(options.bootstrap ? { bootstrap: options.bootstrap } : {}),
    });
    const rpc = NodeRpcClient.connect(
      options.nodeKey,
      options.bootstrap ? { bootstrap: options.bootstrap } : {},
    );
    return new Mordecai(
      options.wallet,
      network,
      rpc,
      options.chainId,
      options.defaultMaxFee ?? 500_000n,
    );
  }

  get address(): string {
    return this.wallet.address;
  }

  // ------------------------------------------------------ blockchain API

  /** Sign a payload with the next nonce, submit it, wait for finality. */
  async submit(payload: Payload, maxFee?: bigint): Promise<TxInfo> {
    const account = await this.rpc.getAccount(this.address);
    const tx = await this.wallet.signTransaction({
      chainId: this.chainId,
      nonce: BigInt(account.nonce),
      maxFee: maxFee ?? this.defaultMaxFee,
      payload,
    });
    const hash = await this.rpc.submitTx(encodeTransaction(tx));
    return this.rpc.waitForTx(hash, { timeoutMs: 30_000 });
  }

  transfer(to: string | Uint8Array, amount: bigint, maxFee?: bigint): Promise<TxInfo> {
    const key = typeof to === 'string' ? decodeAddress(to) : to;
    return this.submit({ kind: 'transfer', to: key, amount }, maxFee);
  }

  async deploy(code: Uint8Array, maxFee?: bigint): Promise<{ contractId: Uint8Array; tx: TxInfo }> {
    const tx = await this.submit({ kind: 'deploy_contract', code }, maxFee);
    if (!tx.success) throw new Error(`deploy failed: ${tx.error}`);
    return { contractId: new Uint8Array(Buffer.from(tx.returnData, 'hex')), tx };
  }

  execute(
    contract: Uint8Array,
    action: string,
    args: Uint8Array = new Uint8Array(0),
    value = 0n,
    maxFee?: bigint,
  ): Promise<TxInfo> {
    return this.submit({ kind: 'execute_contract', contract, value, action, args }, maxFee);
  }

  account(address = this.address): Promise<AccountInfo> {
    return this.rpc.getAccount(address);
  }

  /**
   * Read a contract's storage (spec §22 `query`): [inner key, value] pairs,
   * optionally narrowed by inner-key prefix (e.g. the DSL's `s:Tile:`).
   */
  async query(contract: Uint8Array, prefix?: Uint8Array): Promise<[Uint8Array, Uint8Array][]> {
    const entries = await this.rpc.getContractState(contract, prefix);
    return entries.map(({ key, value }) => [
      new Uint8Array(Buffer.from(key, 'hex')),
      new Uint8Array(Buffer.from(value, 'hex')),
    ]);
  }

  // --------------------------------------------------- identity / auth

  /** App-level authentication: prove control of the wallet key. */
  async authenticate(challenge: Uint8Array): Promise<{
    address: string;
    publicKey: Uint8Array;
    signature: Uint8Array;
  }> {
    return {
      address: this.address,
      publicKey: this.wallet.publicKey,
      signature: await this.wallet.signMessage(challenge),
    };
  }

  // ------------------------------------------------- registry / install

  /** Publish a bundle feed and register the app on-chain in one step. */
  async publishApp(params: {
    appId: string;
    version: string;
    bundle: Uint8Array;
    contractAddress?: Uint8Array;
    /** App-chain validator set (app-chains spec §2.4); omit for chainless apps. */
    chainValidators?: Uint8Array[];
  }): Promise<{ pearKey: Uint8Array; tx: TxInfo }> {
    const feed = await this.network.createFeed(`bundle:${params.appId}`);
    if (feed.length === 0) await feed.append(params.bundle);
    await this.network.joinFeed(feed);
    const tx = await this.submit({
      kind: 'register_app',
      appId: params.appId,
      pearKey: feed.key,
      version: params.version,
      contractAddress: params.contractAddress ?? new Uint8Array(32),
      metadataHash: blake2b256(params.bundle),
      chainValidators: params.chainValidators ?? [],
    });
    if (!tx.success) throw new Error(`register_app failed: ${tx.error}`);
    return { pearKey: feed.key, tx };
  }

  /**
   * Deterministic install (spec §17): registry lookup → fetch bundle over
   * the swarm → verify against the on-chain hash. The serving peer is
   * untrusted; the chain entry is the authority.
   */
  async installApp(appId: string): Promise<InstalledApp> {
    const entry = await this.rpc.getApp(appId);
    if (!entry) throw new Error(`app not registered: ${appId}`);
    const feed = await this.network.openFeed(new Uint8Array(Buffer.from(entry.pearKey, 'hex')));
    await this.network.joinFeed(feed);
    const bundle = await feed.get(0);
    const digest = Buffer.from(blake2b256(bundle)).toString('hex');
    if (digest !== entry.metadataHash) {
      throw new Error(`bundle hash mismatch for ${appId}: refusing to install`);
    }
    return { entry, bundle };
  }

  // ------------------------------------------------- shared state (§22)

  createFeed(name: string): Promise<Feed> {
    return this.network.createFeed(name);
  }

  openFeed(key: Uint8Array): Promise<Feed> {
    return this.network.openFeed(key);
  }

  joinFeed(feed: Feed): Promise<void> {
    return this.network.joinFeed(feed);
  }

  async close(): Promise<void> {
    await this.rpc.close();
    await this.network.close();
  }
}
