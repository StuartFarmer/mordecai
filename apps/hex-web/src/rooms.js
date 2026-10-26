import { fetchGame, fetchPot, fetchL1Balance, gameIdFromCode, play, stake } from './chain.js';

const FEE_RESERVE = 500000n;
async function requireFunds(player, amount) {
  if ((await fetchL1Balance(player)) < BigInt(amount) + FEE_RESERVE)
    throw new Error('Insufficient L1 balance for the stake and fee. Check your Account balance.');
}

// Each chain commits separately; retries finish only the step not yet confirmed.
export async function createRoom(player, config, code, amount) {
  if (!Number.isSafeInteger(amount) || amount < 1)
    throw new Error('Enter a positive whole-number stake.');
  const id = gameIdFromCode(code);
  const [game, pot] = await Promise.all([fetchGame(config, id), fetchPot(config, id)]);
  if (game && (game.creator !== player.address || game.phase !== 0))
    throw new Error('That room code is already in use.');
  if (
    pot &&
    (pot.creator !== player.address || pot.phase !== 0 || BigInt(pot.stake) !== BigInt(amount))
  )
    throw new Error('That room already has a different stake.');
  if (!pot) await requireFunds(player, amount);
  if (!game) await play(player, config, { create: { game_id: id } });
  if (!pot) await stake(player, config, { create: { game_id: id } }, BigInt(amount));
}

export async function joinRoom(player, config, code) {
  const id = gameIdFromCode(code);
  const [game, pot] = await Promise.all([fetchGame(config, id), fetchPot(config, id)]);
  if (!game) throw new Error('No game with that code.');
  if (!pot) throw new Error('The creator must finish funding the room stake first.');
  if (game.creator === player.address)
    throw new Error('Use a different account to join your own room.');
  if (game.phase !== 0 && !(game.phase === 1 && game.opponent === player.address))
    throw new Error('That game has already started or finished.');
  if (pot.phase !== 0 && !(pot.phase === 1 && pot.opponent === player.address))
    throw new Error('That room stake is already matched or settled.');
  if (pot.phase === 0) await requireFunds(player, pot.stake);
  if (game.phase === 0) await play(player, config, { join: { game_id: id } });
  if (pot.phase === 0) await stake(player, config, { join: { game_id: id } }, BigInt(pot.stake));
}
