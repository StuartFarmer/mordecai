import type { Duplex } from 'node:stream';
import Hyperswarm from 'hyperswarm';

const MAX_FRAME = 16 * 1024 * 1024;

export type MessageHandler = (payload: Uint8Array, reply: (payload: Uint8Array) => void) => void;

/**
 * Broadcast mesh for consensus gossip: a dedicated swarm on one topic
 * (the genesis hash), length-prefixed frames over every connection.
 * Transport identity is unauthenticated by design — proposals and votes
 * carry their own signatures.
 */
export class PeerHub {
  private readonly sockets = new Set<Duplex>();
  private readonly handlers = new Set<MessageHandler>();
  private readonly onPeer = new Set<() => void>();

  private constructor(private readonly swarm: Hyperswarm) {}

  static async create(options: {
    topic: Uint8Array;
    bootstrap?: { host: string; port: number }[];
  }): Promise<PeerHub> {
    const swarm = new Hyperswarm(options.bootstrap ? { bootstrap: options.bootstrap } : {});
    const hub = new PeerHub(swarm);
    swarm.on('connection', (socket) => hub.attach(socket));
    const discovery = swarm.join(options.topic, { server: true, client: true });
    await discovery.flushed();
    return hub;
  }

  private attach(socket: Duplex): void {
    this.sockets.add(socket);
    let buffered: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      for (;;) {
        if (buffered.length < 4) return;
        const size = buffered.readUInt32LE(0);
        if (size > MAX_FRAME) {
          socket.destroy();
          return;
        }
        if (buffered.length < 4 + size) return;
        const payload = new Uint8Array(buffered.subarray(4, 4 + size));
        buffered = buffered.subarray(4 + size);
        const reply = (bytes: Uint8Array) => this.write(socket, bytes);
        for (const handler of this.handlers) handler(payload, reply);
      }
    });
    const drop = () => this.sockets.delete(socket);
    socket.on('close', drop);
    socket.on('error', drop);
    for (const listener of this.onPeer) listener();
  }

  private write(socket: Duplex, payload: Uint8Array): void {
    const frame = Buffer.alloc(4 + payload.length);
    frame.writeUInt32LE(payload.length, 0);
    frame.set(payload, 4);
    socket.write(frame);
  }

  broadcast(payload: Uint8Array): void {
    for (const socket of this.sockets) this.write(socket, payload);
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  onPeerConnected(listener: () => void): () => void {
    this.onPeer.add(listener);
    return () => {
      this.onPeer.delete(listener);
    };
  }

  get peerCount(): number {
    return this.sockets.size;
  }

  async close(): Promise<void> {
    await this.swarm.destroy();
  }
}
