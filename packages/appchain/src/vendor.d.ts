declare module '@hyperswarm/rpc' {
  interface HyperswarmRpcServer {
    listen(): Promise<void>;
    respond(method: string, handler: (request: Buffer) => Buffer | Promise<Buffer>): void;
    close(): Promise<void>;
    publicKey: Uint8Array | null;
  }

  interface HyperswarmRpcClient {
    request(method: string, data: Buffer): Promise<Buffer>;
    destroy(): Promise<void>;
  }

  interface RpcOptions {
    bootstrap?: { host: string; port: number }[];
    keyPair?: { publicKey: Uint8Array; secretKey: Uint8Array };
  }

  class RPC {
    constructor(options?: RpcOptions);
    createServer(): HyperswarmRpcServer;
    connect(publicKey: Uint8Array): HyperswarmRpcClient;
    destroy(): Promise<void>;
  }

  export = RPC;
}
