import RPC from '@hyperswarm/rpc';
import type {
  AccountInfo,
  AnchorInfo,
  AppInfo,
  BlockInfo,
  ContractStateEntry,
  HeadInfo,
  RpcEnvelope,
  SubmitTxResult,
  TxInfo,
} from './messages.js';

export class RpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcError';
  }
}

export interface RpcClientOptions {
  bootstrap?: { host: string; port: number }[];
}

export class NodeRpcClient {
  private constructor(
    private readonly rpc: RPC,
    private readonly client: { request(method: string, data: Buffer): Promise<Buffer> },
  ) {}

  static connect(serverPublicKey: Uint8Array, options: RpcClientOptions = {}): NodeRpcClient {
    const rpc = new RPC(options.bootstrap ? { bootstrap: options.bootstrap } : {});
    return new NodeRpcClient(rpc, rpc.connect(serverPublicKey));
  }

  private async call<T>(method: string, params: unknown): Promise<T> {
    const raw = await this.client.request(method, Buffer.from(JSON.stringify(params)));
    const envelope = JSON.parse(raw.toString('utf8')) as RpcEnvelope<T>;
    if (!envelope.ok) throw new RpcError(envelope.error);
    return envelope.result;
  }

  getHead(): Promise<HeadInfo> {
    return this.call('get_head', {});
  }

  getAccount(address: string): Promise<AccountInfo> {
    return this.call('get_account', { address });
  }

  /** Submit a canonical encoded transaction; returns its hash (hex). */
  async submitTx(txBytes: Uint8Array): Promise<string> {
    const { hash } = await this.call<SubmitTxResult>('submit_tx', {
      tx: Buffer.from(txBytes).toString('hex'),
    });
    return hash;
  }

  getBlock(height: bigint): Promise<BlockInfo | null> {
    return this.call('get_block', { height: height.toString() });
  }

  getApp(appId: string): Promise<AppInfo | null> {
    return this.call('get_app', { appId });
  }

  /** Last accepted app-chain anchor for `appId`, or null. */
  getAppAnchor(appId: string): Promise<AnchorInfo | null> {
    return this.call('get_app_anchor', { appId });
  }

  getTx(hashHex: string): Promise<TxInfo | null> {
    return this.call('get_tx', { hash: hashHex });
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
