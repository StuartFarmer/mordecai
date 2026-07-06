import type { Duplex } from 'node:stream';
import Corestore from 'corestore';
import Hyperswarm from 'hyperswarm';
import { Feed } from './feed.js';

export interface NetworkOptions {
  /** Directory for feed storage. */
  storageDir: string;
  /** Override DHT bootstrap nodes (local testnets); defaults to the public DHT. */
  bootstrap?: { host: string; port: number }[];
}

/**
 * One peer's view of the Holepunch network: a Corestore for feeds and a
 * Hyperswarm for peer discovery. Every swarm connection replicates the
 * whole store, so any feed opened on both ends of a connection syncs.
 */
export class Network {
  private readonly connectionListeners = new Set<(remotePublicKey: Uint8Array) => void>();

  private constructor(
    private readonly swarm: Hyperswarm,
    private readonly store: Corestore,
  ) {
    swarm.on('connection', (socket, info) => {
      this.store.replicate(socket);
      for (const listener of this.connectionListeners) listener(info.publicKey);
    });
  }

  static create(options: NetworkOptions): Network {
    const swarm = new Hyperswarm(options.bootstrap ? { bootstrap: options.bootstrap } : {});
    return new Network(swarm, new Corestore(options.storageDir));
  }

  /** This peer's swarm identity (Ed25519 public key). */
  get publicKey(): Uint8Array {
    return this.swarm.keyPair.publicKey;
  }

  get connectionCount(): number {
    return this.swarm.connections.size;
  }

  /** Create (or reopen) a locally-writable feed, deterministic per name. */
  async createFeed(name: string): Promise<Feed> {
    const feed = new Feed(this.store.get({ name }));
    await feed.ready();
    return feed;
  }

  /** Open a remote feed by its public key (read-only, filled by replication). */
  async openFeed(key: Uint8Array): Promise<Feed> {
    const feed = new Feed(this.store.get({ key }));
    await feed.ready();
    return feed;
  }

  /** Join the swarm topic for a feed and wait until announced/connected. */
  async joinFeed(feed: Feed): Promise<void> {
    await this.join(feed.discoveryKey);
  }

  /** Join an arbitrary 32-byte topic as both server and client. */
  async join(topic: Uint8Array): Promise<void> {
    const discovery = this.swarm.join(topic, { server: true, client: true });
    await discovery.flushed();
    await this.swarm.flush();
  }

  /** Notify on every new peer connection; returns an unsubscribe function. */
  onConnection(listener: (remotePublicKey: Uint8Array) => void): () => void {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  /** Raw replication hookup for transports not managed by the swarm (tests, relays). */
  replicate(socket: Duplex): void {
    this.store.replicate(socket);
  }

  async close(): Promise<void> {
    await this.swarm.destroy();
    await this.store.close();
  }
}
