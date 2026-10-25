import { mkdir, readFile, open, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  chessMessageHash,
  replayChess,
  verifyChessMessage,
  type SignedChessMessage,
} from '@mordecai/wallet/chess';

export interface ChessWagerState {
  matchId: string;
  creator: string;
  opponent: string;
  stake: string;
  phase: number;
  creatorReported: boolean;
  opponentReported: boolean;
  creatorPick: string;
  opponentPick: string;
  creatorDraw: boolean;
  opponentDraw: boolean;
}
interface Options {
  dir: string;
  chainId: string;
  contract: string;
  getWager(roomId: string): Promise<ChessWagerState | null>;
  verifyCreate(roomId: string, envelope: SignedChessMessage): Promise<void>;
}
export class ChessRooms {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(private readonly options: Options) {}
  private binding(roomId: string) {
    if (!/^[a-f0-9]{64}$/.test(roomId)) throw new Error('Invalid room id');
    return { roomId, chainId: this.options.chainId, contract: this.options.contract };
  }
  private async history(roomId: string): Promise<SignedChessMessage[]> {
    this.binding(roomId);
    try {
      return JSON.parse(await readFile(join(this.options.dir, `${roomId}.json`), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  async read(roomId: string) {
    const messages = await this.history(roomId);
    replayChess(messages, this.binding(roomId));
    return { roomId, messages, wager: await this.options.getWager(roomId) };
  }
  append(roomId: string, envelope: SignedChessMessage) {
    if (this.closed) return Promise.reject(new Error('Chess relay is closed'));
    const work = this.tail.then(async () => {
      const actor = verifyChessMessage(envelope);
      const messages = await this.history(roomId);
      const prior = messages[envelope.message.sequence];
      if (prior && chessMessageHash(prior) === chessMessageHash(envelope)) return this.read(roomId);
      replayChess([...messages, envelope], this.binding(roomId));
      const wager = await this.options.getWager(roomId);
      if (!wager) throw new Error('Confirmed wager required');
      const action = envelope.message.action;
      if (action === 'create') {
        if (wager.creator !== actor || (wager.phase !== 0 && wager.phase !== 1))
          throw new Error('Wager creator mismatch');
        await this.options.verifyCreate(roomId, envelope);
      } else if (action === 'join') {
        if (wager.phase !== 1 || wager.opponent !== actor)
          throw new Error('Confirmed opponent stake required');
      } else if (wager.phase !== 1 || ![wager.creator, wager.opponent].includes(actor))
        throw new Error('Confirmed active wager required');
      const state = replayChess([...messages, envelope], this.binding(roomId));
      if (state.white !== wager.creator || (state.black && state.black !== wager.opponent))
        throw new Error('Wager players mismatch');
      messages.push(envelope);
      await mkdir(this.options.dir, { recursive: true, mode: 0o700 });
      const path = join(this.options.dir, `${roomId}.json`),
        temp = `${path}.tmp`;
      const file = await open(temp, 'w', 0o600);
      try {
        await file.writeFile(JSON.stringify(messages));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, path);
      const directory = await open(this.options.dir, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return { roomId, messages, wager };
    });
    this.tail = work.catch(() => {});
    return work;
  }
  async close() {
    this.closed = true;
    await this.tail;
  }
  async handleRequest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith('/api/demos/chess/rooms')) return false;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    try {
      const match = /^\/api\/demos\/chess\/rooms\/([a-f0-9]{64})$/.exec(url.pathname);
      if (!match) throw new Error('Invalid room path');
      let data;
      if (req.method === 'GET') data = await this.read(match[1]!);
      else if (req.method === 'POST') {
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)
          throw new Error('Cross-origin room writes are not allowed');
        let body = '';
        for await (const part of req) {
          body += part.toString();
          if (Buffer.byteLength(body) > 4096) throw new Error('Room message too large');
        }
        data = await this.append(match[1]!, JSON.parse(body));
      } else {
        res.statusCode = 405;
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return true;
      }
      res.end(JSON.stringify(data));
    } catch (error) {
      res.statusCode = 400;
      res.end(
        JSON.stringify({ error: error instanceof Error ? error.message : 'Invalid room request' }),
      );
    }
    return true;
  }
}
