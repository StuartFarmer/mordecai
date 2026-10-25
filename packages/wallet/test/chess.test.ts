import { describe, expect, it } from 'vitest';
import { loadBrowserWallet } from '../src/browser.js';
import {
  signChessMessage,
  verifyChessMessage,
  replayChess,
  CHESS_ZERO_HASH,
  type ChessMessage,
  type SignedChessMessage,
} from '../src/chess.js';
const white = loadBrowserWallet('01'.repeat(32)),
  black = loadBrowserWallet('02'.repeat(32));
const binding = { chainId: 'test-chain', contract: 'ab'.repeat(32), roomId: 'cd'.repeat(32) };
const first: ChessMessage = {
  version: 1,
  ...binding,
  sequence: 0,
  previousHash: CHESS_ZERO_HASH,
  action: 'create',
  data: 'ef'.repeat(32),
};
function append(
  messages: SignedChessMessage[],
  wallet = white,
  action: ChessMessage['action'] = 'move',
  data = '',
) {
  const state = replayChess(messages, binding);
  return [
    ...messages,
    signChessMessage(wallet, {
      ...first,
      sequence: messages.length,
      previousHash: state.previousHash,
      action,
      data,
    }),
  ];
}
describe('typed Chess signatures and shared replay', () => {
  it('authenticates domain-bound messages and rejects malformed/raw requests', () => {
    const signed = signChessMessage(white, first);
    expect(verifyChessMessage(signed)).toBe(white.address);
    expect(() =>
      verifyChessMessage({ ...signed, message: { ...first, chainId: 'other' } }),
    ).toThrow();
    expect(() => signChessMessage(white, { ...first, raw: 'arbitrary' } as ChessMessage)).toThrow();
    expect(() => replayChess([signed], { ...binding, roomId: 'aa'.repeat(32) })).toThrow();
    expect(() => replayChess([signed], { ...binding, contract: 'aa'.repeat(32) })).toThrow();
  });
  it('rejects self joins, wrong turns, illegal moves and stale sequences', () => {
    let messages = [signChessMessage(white, first)];
    expect(() => replayChess(append(messages, white, 'join'), binding)).toThrow();
    messages = append(messages, black, 'join');
    expect(() => replayChess(append(messages, black, 'move', 'e7e5'), binding)).toThrow();
    expect(() => replayChess(append(messages, white, 'move', 'e2e5'), binding)).toThrow();
    messages = append(messages, white, 'move', 'e2e4');
    expect(replayChess(messages, binding).game.history()).toEqual(['e4']);
    expect(() => replayChess([...messages, messages[2]!], binding)).toThrow();
  });
  it('replays checkmate, resignation and mutually accepted draws', () => {
    const joined = append([signChessMessage(white, first)], black, 'join');
    let messages = joined;
    for (const [i, move] of ['f2f3', 'e7e5', 'g2g4', 'd8h4'].entries())
      messages = append(messages, i % 2 ? black : white, 'move', move);
    expect(replayChess(messages, binding).result).toBe(black.address);
    expect(replayChess(append(joined, white, 'resign'), binding).result).toBe(black.address);
    const offered = append(joined, white, 'draw-offer');
    expect(() => replayChess(append(offered, white, 'draw-accept'), binding)).toThrow();
    expect(replayChess(append(offered, black, 'draw-accept'), binding).result).toBe('draw');
  });
});
