declare module 'hyperswarm' {
  import type { Duplex } from 'node:stream';

  interface PeerInfo {
    publicKey: Uint8Array;
  }

  interface PeerDiscovery {
    flushed(): Promise<void>;
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
    leave(topic: Uint8Array): Promise<void>;
    flush(): Promise<void>;
    destroy(): Promise<void>;
  }

  export = Hyperswarm;
}

declare module 'corestore' {
  import type { Duplex } from 'node:stream';
  import type Hypercore from 'hypercore';

  class Corestore {
    constructor(storage: string);
    get(options: { name: string } | { key: Uint8Array }): Hypercore;
    replicate(streamOrInitiator: Duplex | boolean): Duplex;
    close(): Promise<void>;
  }

  export = Corestore;
}

declare module 'hypercore' {
  class Hypercore {
    ready(): Promise<void>;
    close(): Promise<void>;
    key: Uint8Array;
    discoveryKey: Uint8Array;
    length: number;
    writable: boolean;
    append(block: Uint8Array | Uint8Array[]): Promise<{ length: number }>;
    get(index: number, options?: { wait?: boolean; timeout?: number }): Promise<Uint8Array | null>;
    update(options?: { wait?: boolean }): Promise<boolean>;
    on(event: 'append', listener: () => void): this;
    off(event: 'append', listener: () => void): this;
  }

  export = Hypercore;
}

declare module 'hyperdht/testnet' {
  interface Testnet {
    bootstrap: { host: string; port: number }[];
    destroy(): Promise<void>;
  }

  function createTestnet(size?: number): Promise<Testnet>;

  export = createTestnet;
}
