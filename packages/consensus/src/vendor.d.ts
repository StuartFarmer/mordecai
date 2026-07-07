declare module 'hyperswarm' {
  import type { Duplex } from 'node:stream';

  interface PeerInfo {
    publicKey: Uint8Array;
  }

  interface PeerDiscovery {
    flushed(): Promise<void>;
    refresh(options?: { client?: boolean; server?: boolean }): Promise<void>;
    destroy(): Promise<void>;
  }

  interface HyperswarmOptions {
    bootstrap?: { host: string; port: number }[];
    keyPair?: { publicKey: Uint8Array; secretKey: Uint8Array };
  }

  class Hyperswarm {
    constructor(options?: HyperswarmOptions);
    keyPair: { publicKey: Uint8Array; secretKey: Uint8Array };
    connections: Set<Duplex>;
    on(event: 'connection', listener: (socket: Duplex, info: PeerInfo) => void): this;
    join(topic: Uint8Array, options?: { server?: boolean; client?: boolean }): PeerDiscovery;
    flush(): Promise<void>;
    destroy(): Promise<void>;
  }

  export = Hyperswarm;
}

declare module 'hyperdht/testnet' {
  interface Testnet {
    bootstrap: { host: string; port: number }[];
    destroy(): Promise<void>;
  }

  function createTestnet(size?: number): Promise<Testnet>;

  export = createTestnet;
}
