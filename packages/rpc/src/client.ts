import RPC from '@hyperswarm/rpc';
import type {
  AccountInfo,
  AnchorInfo,
  AppInfo,
  AppPage,
  BlockInfo,
  ContractStateEntry,
  HeadInfo,
  RpcEnvelope,
  SubmitTxResult,
  TxInfo,
} from './messages.js';

export class RpcError extends Error {
  constructor(
    message: string,
    readonly rejected = false,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export interface RpcClientOptions {
  bootstrap?: { host: string; port: number }[];
}

export interface RpcReadOptions {
  timeout?: number;
}

export class NodeRpcClient {
  private constructor(
    private readonly rpc: RPC,
    private readonly client: {
      request(method: string, data: Buffer, options?: RpcReadOptions): Promise<Buffer>;
    },
  ) {}

  static connect(serverPublicKey: Uint8Array, options: RpcClientOptions = {}): NodeRpcClient {
    const rpc = new RPC(options.bootstrap ? { bootstrap: options.bootstrap } : {});
    return new NodeRpcClient(rpc, rpc.connect(serverPublicKey));
  }

  private async call<T>(method: string, params: unknown, options?: RpcReadOptions): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = this.client.request(method, Buffer.from(JSON.stringify(params)), options);
      const raw =
        options?.timeout === undefined
          ? await request
          : await Promise.race([
              request,
              new Promise<Buffer>((_, reject) => {
                timer = setTimeout(
                  () => reject(new RpcError(`RPC read timeout after ${options.timeout}ms`)),
                  options.timeout,
                );
              }),
            ]);
      const envelope = JSON.parse(raw.toString('utf8')) as RpcEnvelope<T>;
      if (!envelope.ok) throw new RpcError(envelope.error, envelope.rejected === true);
      return envelope.result;
    } finally {
      clearTimeout(timer);
    }
  }

  getHead(options?: RpcReadOptions): Promise<HeadInfo> {
    return this.call('get_head', {}, options);
  }

  getAccount(address: string): Promise<AccountInfo> {
    return this.call('get_account', { address });
  }

  /** Submit a canonical encoded transaction; returns its hash (hex). */
  async submitTx(txBytes: Uint8Array): Promise<string> {
    const raw = await this.client.request('submit_tx_raw', Buffer.from(txBytes));
    if (raw.length === 32) return raw.toString('hex');
    const envelope = JSON.parse(raw.toString('utf8')) as RpcEnvelope<SubmitTxResult>;
    if (!envelope.ok) throw new RpcError(envelope.error, envelope.rejected === true);
    return envelope.result.hash;
  }

  getBlock(height: bigint, options?: RpcReadOptions): Promise<BlockInfo | null> {
    return this.call('get_block', { height: height.toString() }, options);
  }

  getApp(appId: string, options?: RpcReadOptions): Promise<AppInfo | null> {
    return this.call('get_app', { appId }, options);
  }

  getApps(
    params: { after?: string; limit?: number } = {},
    options?: RpcReadOptions,
  ): Promise<AppPage> {
    return this.call('get_apps', params, options);
  }

  /** Last accepted app-chain anchor for `appId`, or null. */
  getAppAnchor(appId: string, options?: RpcReadOptions): Promise<AnchorInfo | null> {
    return this.call('get_app_anchor', { appId }, options);
  }

  getTx(hashHex: string, options?: RpcReadOptions): Promise<TxInfo | null> {
    return this.call('get_tx', { hash: hashHex }, options);
  }

  /** A contract's storage entries, optionally narrowed by inner-key prefix. */
  getContractState(contract: Uint8Array, prefix?: Uint8Array): Promise<ContractStateEntry[]> {
    return this.call('get_contract_state', {
      contract: Buffer.from(contract).toString('hex'),
      ...(prefix ? { prefix: Buffer.from(prefix).toString('hex') } : {}),
    });
  }

  /** Poll until the transaction lands in a block (M3 stand-in for event subscriptions). */
  async waitForTx(
    hashHex: string,
    options: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<TxInfo> {
    const timeoutMs = options.timeoutMs ?? 15_000;
    const intervalMs = options.intervalMs ?? 200;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const info = await this.getTx(hashHex);
      if (info) return info;
      if (Date.now() > deadline)
        throw new RpcError(`tx ${hashHex} not found within ${timeoutMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  async close(): Promise<void> {
    await this.rpc.destroy();
  }
}
