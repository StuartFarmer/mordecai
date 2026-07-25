import RPC from '@hyperswarm/rpc';
import type { KeyPair } from '@mordecai/crypto';
import { decodePayload, encodeTransaction } from '@mordecai/protocol';
import type { Wallet } from '@mordecai/wallet';
import { WalletSession, type ApprovalPrompt, type SessionGrant } from './session.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const fromHex = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));

type Envelope<T> = { ok: true; result: T } | { ok: false; error: string };

export interface DaemonOptions {
  wallet: Wallet;
  /** Per-app grants; apps without one are refused at hello. */
  grants: Record<string, Omit<SessionGrant, 'appId'>>;
  /** UI hook for spends beyond an app's allowance. Default: deny. */
  approve?: ApprovalPrompt;
  bootstrap?: { host: string; port: number }[];
  keyPair?: KeyPair;
}

/**
 * The shell side of the trust boundary (threat model §26): holds the
 * unlocked Wallet, hands each app only an IPC endpoint. Sessions are
 * keyed by appId and enforced by WalletSession — the process boundary
 * makes "apps never touch keys" literal.
 */
export class WalletDaemon {
  private readonly sessions = new Map<string, WalletSession>();

  private constructor(
    private readonly rpc: RPC,
    private readonly server: { close(): Promise<void>; publicKey: Uint8Array | null },
    private readonly options: DaemonOptions,
  ) {}

  static async start(options: DaemonOptions): Promise<WalletDaemon> {
    const rpc = new RPC({
      ...(options.bootstrap ? { bootstrap: options.bootstrap } : {}),
      ...(options.keyPair ? { keyPair: options.keyPair } : {}),
    });
    const server = rpc.createServer();
    const daemon = new WalletDaemon(rpc, server, options);

    const respond = <T>(method: string, handler: (params: never) => Promise<T> | T) => {
      server.respond(method, async (raw: Buffer) => {
        let envelope: Envelope<T>;
        try {
          const params = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : {};
          envelope = { ok: true, result: await handler(params as never) };
        } catch (err) {
          envelope = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        return Buffer.from(JSON.stringify(envelope));
      });
    };

    respond('hello', (params: { appId: string }) => {
      daemon.session(params.appId); // establishes (or refuses) the session
      return { address: options.wallet.address, publicKey: hex(options.wallet.publicKey) };
    });

    respond('sign_message', async (params: { appId: string; message: string }) => {
      const signature = await daemon.session(params.appId).signMessage(fromHex(params.message));
      return { signature: hex(signature) };
    });

    respond(
      'sign_tx',
      async (params: {
        appId: string;
        chainId: string;
        nonce: string;
        maxFee: string;
        payload: string;
      }) => {
        const tx = await daemon.session(params.appId).signTransaction({
          chainId: params.chainId,
          nonce: BigInt(params.nonce),
          maxFee: BigInt(params.maxFee),
          payload: decodePayload(fromHex(params.payload)),
        });
        return { tx: hex(encodeTransaction(tx)) };
      },
    );

    await server.listen();
    return daemon;
  }

  private session(appId: string): WalletSession {
    const existing = this.sessions.get(appId);
    if (existing) return existing;
    const grant = this.options.grants[appId];
    if (!grant) throw new Error(`no wallet grant for app ${appId}`);
    const session = new WalletSession(
      this.options.wallet,
      { appId, ...grant },
      this.options.approve ?? (() => false),
    );
    this.sessions.set(appId, session);
    return session;
  }

  get publicKey(): Uint8Array {
    if (!this.server.publicKey) throw new Error('daemon not listening');
    return this.server.publicKey;
  }

  async close(): Promise<void> {
    await this.server.close();
    await this.rpc.destroy();
  }
}
