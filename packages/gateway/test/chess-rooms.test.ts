import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { loadBrowserWallet } from '@mordecai/wallet/browser';
import {
  signChessMessage,
  replayChess,
  CHESS_ZERO_HASH,
  type ChessMessage,
} from '@mordecai/wallet/chess';
import { ChessRooms, type ChessWagerState } from '../src/chess-rooms.js';
it('persists signed rooms, authenticates membership, serializes conflicts and retries exactly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chess-rooms-'));
  const white = loadBrowserWallet('01'.repeat(32)),
    black = loadBrowserWallet('02'.repeat(32));
  const binding = { chainId: 'test', contract: 'ab'.repeat(32), roomId: 'cd'.repeat(32) };
  let wager: ChessWagerState | null = null;
  const options = { dir, ...binding, getWager: async () => wager, verifyCreate: async () => {} };
  let rooms = new ChessRooms(options);
  const message: ChessMessage = {
    version: 1,
    ...binding,
    sequence: 0,
    previousHash: CHESS_ZERO_HASH,
    action: 'create',
    data: 'ef'.repeat(32),
  };
  const create = signChessMessage(white, message);
  try {
    await expect(rooms.append(binding.roomId, create)).rejects.toThrow('Confirmed wager');
    wager = {
      matchId: '0',
      creator: white.address,
      opponent: white.address,
      stake: '100',
      phase: 0,
      creatorReported: false,
      opponentReported: false,
      creatorPick: white.address,
      opponentPick: white.address,
      creatorDraw: false,
      opponentDraw: false,
    };
    const [a, b] = await Promise.all([
      rooms.append(binding.roomId, create),
      rooms.append(binding.roomId, create),
    ]);
    expect(a.messages).toEqual(b.messages);
    expect(a.messages).toHaveLength(1);
    const joined = signChessMessage(black, {
      ...message,
      sequence: 1,
      previousHash: replayChess(a.messages, binding).previousHash,
      action: 'join',
      data: '',
    });
    await expect(rooms.append(binding.roomId, joined)).rejects.toThrow('Confirmed opponent');
    wager = { ...wager, phase: 1, opponent: black.address };
    const active = await rooms.append(binding.roomId, joined);
    const m = {
      ...message,
      sequence: 2,
      previousHash: replayChess(active.messages, binding).previousHash,
      action: 'move' as const,
      data: 'e2e4',
    };
    const results = await Promise.allSettled([
      rooms.append(binding.roomId, signChessMessage(white, m)),
      rooms.append(binding.roomId, signChessMessage(white, { ...m, data: 'd2d4' })),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    await expect(rooms.append('aa'.repeat(32), create)).rejects.toThrow();
    await rooms.close();
    rooms = new ChessRooms(options);
    const recovered = await rooms.read(binding.roomId);
    expect(replayChess(recovered.messages, binding).game.history()).toEqual(['e4']);
    expect((await rooms.append(binding.roomId, signChessMessage(white, m))).messages).toHaveLength(
      3,
    );
  } finally {
    await rooms.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('registers an already active wager without bypassing creator or receipt verification', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chess-rooms-active-'));
  const white = loadBrowserWallet('01'.repeat(32)),
    black = loadBrowserWallet('02'.repeat(32));
  const binding = { chainId: 'test', contract: 'ab'.repeat(32), roomId: 'cd'.repeat(32) };
  const wager: ChessWagerState = {
    matchId: '0',
    creator: white.address,
    opponent: black.address,
    stake: '100',
    phase: 1,
    creatorReported: false,
    opponentReported: false,
    creatorPick: white.address,
    opponentPick: black.address,
    creatorDraw: false,
    opponentDraw: false,
  };
  const verifyCreate = vi.fn(async () => {});
  const rooms = new ChessRooms({ dir, ...binding, getWager: async () => wager, verifyCreate });
  const message: ChessMessage = {
    version: 1,
    ...binding,
    sequence: 0,
    previousHash: CHESS_ZERO_HASH,
    action: 'create',
    data: 'ef'.repeat(32),
  };
  const create = signChessMessage(white, message);
  try {
    await expect(rooms.append(binding.roomId, signChessMessage(black, message))).rejects.toThrow(
      'Wager creator mismatch',
    );
    for (const phase of [2, 3]) {
      wager.phase = phase;
      await expect(rooms.append(binding.roomId, create)).rejects.toThrow('Wager creator mismatch');
    }
    expect(verifyCreate).not.toHaveBeenCalled();
    wager.phase = 1;
    verifyCreate.mockRejectedValueOnce(new Error('Confirmed creation transaction required'));
    await expect(rooms.append(binding.roomId, create)).rejects.toThrow(
      'Confirmed creation transaction required',
    );
    expect((await rooms.read(binding.roomId)).messages).toHaveLength(0);
    const registered = await rooms.append(binding.roomId, create);
    expect(verifyCreate).toHaveBeenLastCalledWith(binding.roomId, create);
    const joined = await rooms.append(
      binding.roomId,
      signChessMessage(black, {
        ...message,
        sequence: 1,
        previousHash: replayChess(registered.messages, binding).previousHash,
        action: 'join',
        data: '',
      }),
    );
    const moved = await rooms.append(
      binding.roomId,
      signChessMessage(white, {
        ...message,
        sequence: 2,
        previousHash: replayChess(joined.messages, binding).previousHash,
        action: 'move',
        data: 'e2e4',
      }),
    );
    expect(replayChess(moved.messages, binding).game.history()).toEqual(['e4']);
  } finally {
    await rooms.close();
    await rm(dir, { recursive: true, force: true });
  }
});
