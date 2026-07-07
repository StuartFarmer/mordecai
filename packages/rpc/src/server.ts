import RPC from '@hyperswarm/rpc';
import type { Chain, Mempool } from '@hssn/chain';
import { blockHash } from '@hssn/chain';
import { decodeAddress, encodeAddress, type KeyPair } from '@hssn/crypto';
import { decodeTransaction, encodeTransaction, type Transaction } from '@hssn/protocol';
import type {
  AccountInfo,
  AppInfo,
  BlockInfo,
  ContractStateEntry,
  HeadInfo,
  RpcEnvelope,
  SubmitTxResult,
  TxInfo,
} from './messages.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const fromHex = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));

export interface RpcServerOptions {
  bootstrap?: { host: string; port: number }[];
  /** Server identity; clients dial this public key. */
  keyPair?: KeyPair;
}

export class NodeRpcServer {
  private constructor(
    private readonly rpc: RPC,
    private readonly server: { close(): Promise<void>; publicKey: Uint8Array | null },
  ) {}

  static async start(
    deps: {
      chain: Chain;
      mempool: Mempool;
      /** Called after a tx is admitted (consensus nodes gossip it here). */
      onTxAccepted?: (tx: Transaction) => void;
    },
    options: RpcServerOptions = {},
  ): Promise<NodeRpcServer> {
    const rpc = new RPC({
      ...(options.bootstrap ? { bootstrap: options.bootstrap } : {}),
      ...(options.keyPair ? { keyPair: options.keyPair } : {}),
    });
    const server = rpc.createServer();

    const respond = <T>(method: string, handler: (params: never) => Promise<T>) => {
      server.respond(method, async (raw: Buffer) => {
        let envelope: RpcEnvelope<T>;
        try {
          const params = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : {};
          envelope = { ok: true, result: await handler(params as never) };
        } catch (err) {
          envelope = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        return Buffer.from(JSON.stringify(envelope));
      });
    };

    respond<HeadInfo>('get_head', async () => {
      const head = deps.chain.headHeader;
      return {
        chainId: deps.chain.chainId,
        height: head.height.toString(),
        headHash: hex(blockHash(head)),
        stateRoot: hex(head.stateRoot),
        timestampMs: head.timestampMs.toString(),
      };
    });

    respond<AccountInfo>('get_account', async (params: { address: string }) => {
      const account = await deps.chain.getAccount(decodeAddress(params.address));
      return {
        address: params.address,
        balance: account.balance.toString(),
        nonce: account.nonce.toString(),
      };
    });

    respond<SubmitTxResult>('submit_tx', async (params: { tx: string }) => {
      const tx = decodeTransaction(fromHex(params.tx));
      const hash = await deps.mempool.add(tx);
      deps.onTxAccepted?.(tx);
      return { hash: hex(hash) };
    });

    respond<BlockInfo | null>('get_block', async (params: { height: string }) => {
      const block = await deps.chain.getBlock(BigInt(params.height));
      if (!block) return null;
      const h = block.header;
      return {
        hash: hex(blockHash(h)),
        header: {
          version: h.version,
          chainId: h.chainId,
          height: h.height.toString(),
          prevHash: hex(h.prevHash),
          timestampMs: h.timestampMs.toString(),
          proposer: encodeAddress(h.proposer),
          txsRoot: hex(h.txsRoot),
          stateRoot: hex(h.stateRoot),
        },
        txs: block.txs.map((tx) => hex(encodeTransaction(tx))),
      };
    });

    respond<TxInfo | null>('get_tx', async (params: { hash: string }) => {
      const record = await deps.chain.getTxRecord(fromHex(params.hash));
      if (!record) return null;
      return {
        hash: params.hash,
        height: record.height.toString(),
        index: record.index,
        success: record.receipt.success,
        fee: record.receipt.fee.toString(),
        events: record.receipt.events.map(hex),
        returnData: hex(record.receipt.returnData),
        ...(record.receipt.error !== undefined ? { error: record.receipt.error } : {}),
      };
    });

    respond<ContractStateEntry[]>(
      'get_contract_state',
      async (params: { contract: string; prefix?: string }) => {
        const entries = await deps.chain.getContractState(
          fromHex(params.contract),
          params.prefix ? fromHex(params.prefix) : undefined,
        );
        return entries.map(([key, value]) => ({ key: hex(key), value: hex(value) }));
      },
    );

    respond<AppInfo | null>('get_app', async (params: { appId: string }) => {
      const entry = await deps.chain.getApp(params.appId);
      if (!entry) return null;
      return {
        appId: params.appId,
        owner: encodeAddress(entry.owner),
        pearKey: hex(entry.pearKey),
        version: entry.version,
        contractAddress: hex(entry.contractAddress),
        metadataHash: hex(entry.metadataHash),
      };
    });

    await server.listen();
    return new NodeRpcServer(rpc, server);
  }

  get publicKey(): Uint8Array {
    if (!this.server.publicKey) throw new Error('server not listening');
    return this.server.publicKey;
  }

  async close(): Promise<void> {
    await this.server.close();
    await this.rpc.destroy();
  }
}
