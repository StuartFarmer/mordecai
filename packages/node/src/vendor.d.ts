declare module 'hyperdht/testnet' {
  interface Testnet {
    bootstrap: { host: string; port: number }[];
    destroy(): Promise<void>;
  }

  function createTestnet(size?: number): Promise<Testnet>;

  export = createTestnet;
}
