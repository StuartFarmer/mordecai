import { beforeEach, expect, it, vi } from 'vitest';
import { createRoom, joinRoom } from '../src/rooms.js';
import { fetchGame, fetchPot, fetchL1Balance, play, stake } from '../src/chain.js';
vi.mock('../src/chain.js', () => ({
  fetchGame: vi.fn(),
  fetchPot: vi.fn(),
  fetchL1Balance: vi.fn(),
  play: vi.fn(),
  stake: vi.fn(),
  gameIdFromCode: () => 9n,
}));
const player = { address: 'bob' };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchGame).mockResolvedValue({ phase: 0, creator: 'alice' });
  vi.mocked(fetchPot).mockResolvedValue({ phase: 0, creator: 'alice', stake: 1000000 });
  vi.mocked(fetchL1Balance).mockResolvedValue(10000000n);
});
it('refuses an unfunded join before changing the game or escrow', async () => {
  vi.mocked(fetchL1Balance).mockResolvedValue(0n);
  await expect(joinRoom(player, {}, 'room')).rejects.toThrow(/fund|balance/i);
  expect(play).not.toHaveBeenCalled();
  expect(stake).not.toHaveBeenCalled();
});
it('resumes the stake after an app-chain join already completed', async () => {
  vi.mocked(fetchGame).mockResolvedValue({ phase: 1, creator: 'alice', opponent: 'bob' });
  await joinRoom(player, {}, 'room');
  expect(play).not.toHaveBeenCalled();
  expect(stake).toHaveBeenCalledWith(player, {}, { join: { game_id: 9n } }, 1000000n);
});
it('does not join a room whose creator has not escrowed a stake', async () => {
  vi.mocked(fetchPot).mockResolvedValue(null);
  await expect(joinRoom(player, {}, 'room')).rejects.toThrow(/stake/i);
  expect(play).not.toHaveBeenCalled();
});
it('checks creation funds first and resumes an existing unescrowed room', async () => {
  vi.mocked(fetchGame).mockResolvedValue(null);
  vi.mocked(fetchPot).mockResolvedValue(null);
  vi.mocked(fetchL1Balance).mockResolvedValue(1000000n);
  await expect(createRoom(player, {}, 'room', 1000000)).rejects.toThrow(/fund|balance/i);
  expect(play).not.toHaveBeenCalled();
  vi.mocked(fetchL1Balance).mockResolvedValue(10000000n);
  vi.mocked(fetchGame).mockResolvedValue({ phase: 0, creator: 'bob' });
  await createRoom(player, {}, 'room', 1000000);
  expect(play).not.toHaveBeenCalled();
  expect(stake).toHaveBeenCalledOnce();
});
