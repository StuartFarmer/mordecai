import RPC from '@hyperswarm/rpc';
import { decodeTransaction, encodePayload, type Transaction } from '@hssn/protocol';
import type { SignParams, Signer } from '@hssn/wallet';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const fromHex = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));

type Envelope<T> = { ok: true; result: T } | { ok: false; error: string };

/**
 * The app side of the trust boundary: a Signer whose key lives in the
 * wallet daemon, reached over hyperswarm RPC. Drop-in for the SDK —
 * `Hssn.connect({ wallet: remoteSigner, ... })`.
 */
export class RemoteSigner implements Signer {
  private constructor(
    private readonly rpc: RPC,
    private readonly client: { request(method: string, data: Buffer): Promise<Buffer> },
    private readonly appId: string,
    readonly address: string,
    readonly publicKey: Uint8Array,
  ) {}

  static async connect(
    daemonKey: Uint8Array,
    appId: string,
    options: { bootstrap?: { host: string; port: number }[] } = {},
  ): Promise<RemoteSigner> {
    const rpc = new RPC(options.bootstrap ? { bootstrap: options.bootstrap } : {});
    const client = rpc.connect(daemonKey);
    const call = async <T>(method: string, params: unknown): Promise<T> => {
      const raw = await client.request(method, Buffer.from(JSON.stringify(params)));
      const envelope = JSON.parse(raw.toString('utf8')) as Envelope<T>;
      if (!envelope.ok) throw new Error(envelope.error);
      return envelope.result;
    };
    const identity = await call<{ address: string; publicKey: string }>('hello', { appId });
    const signer = new RemoteSigner(
      rpc,
      client,
      appId,
      identity.address,
      fromHex(identity.publicKey),
    );
    signer.call = call;
    return signer;
  }

  private call!: <T>(method: string, params: unknown) => Promise<T>;

  async signTransaction(params: SignParams): Promise<Transaction> {
    const { tx } = await this.call<{ tx: string }>('sign_tx', {
      appId: this.appId,
      chainId: params.chainId,
      nonce: params.nonce.toString(),
      maxFee: params.maxFee.toString(),
      payload: hex(encodePayload(params.payload)),
    });
    return decodeTransaction(fromHex(tx));
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    const { signature } = await this.call<{ signature: string }>('sign_message', {
      appId: this.appId,
      message: hex(message),
    });
    return fromHex(signature);
  }

  async close(): Promise<void> {
    await this.rpc.destroy();
  }
}
