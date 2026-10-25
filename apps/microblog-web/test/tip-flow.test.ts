import { expect, test, vi } from 'vitest';
import { persistAndSubmitTip } from '../src/tip-flow.js';
test('a failed durable attribution never broadcasts and retries reuse the identical prepared payment', async () => {
  const calls: string[] = [];
  const player = {
    signMicroblogTip: async (message: unknown) => ({ message }),
    submitMicroblogTip: vi.fn(async (prepared: { hash: string }) => {
      calls.push('broadcast');
      return prepared.hash;
    }),
  };
  const prepared = { hash: 'hash', hex: 'bytes' };
  const input = {
    player,
    prepared,
    config: { chainId: 'test', feedId: 'feed', api: '/api/demos/microblog' },
    postId: 'post',
    current: () => player,
  };
  await expect(
    persistAndSubmitTip({
      ...input,
      request: async () => {
        throw new Error('offline');
      },
    }),
  ).rejects.toThrow('offline');
  expect(player.submitMicroblogTip).not.toHaveBeenCalled();
  await persistAndSubmitTip({
    ...input,
    request: async (
      _path: string,
      body: { tx: string; envelope: { message: { transactionHash: string } } },
    ) => {
      expect(body.tx).toBe(prepared.hex);
      expect(body.envelope.message.transactionHash).toBe(prepared.hash);
      calls.push('persist');
    },
  });
  expect(calls).toEqual(['persist', 'broadcast']);
  expect(player.submitMicroblogTip).toHaveBeenCalledWith(prepared);
});
test('a wallet change after persistence prevents broadcasting', async () => {
  const submitMicroblogTip = vi.fn();
  let active = true;
  const player = {
    signMicroblogTip: async (message: unknown) => ({ message }),
    submitMicroblogTip,
  };
  await expect(
    persistAndSubmitTip({
      player,
      prepared: { hash: 'hash', hex: 'bytes' },
      config: { chainId: 'test', feedId: 'feed', api: '' },
      postId: 'post',
      current: () => {
        if (!active) throw new Error('Wallet changed');
        return player;
      },
      request: async () => {
        active = false;
      },
    }),
  ).rejects.toThrow('Wallet changed');
  expect(submitMicroblogTip).not.toHaveBeenCalled();
});
