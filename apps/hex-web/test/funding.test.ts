import { expect, it, vi } from 'vitest';
import { watchFunding } from '../src/funding.js';
import { fetchFundingStatus, requestFunds } from '../src/chain.js';
vi.mock('../src/chain.js', () => ({
  fetchFundingStatus: vi.fn(),
  requestFunds: vi.fn(),
  fetchStatus: async () => ({}),
}));

it('clears funding when switching wallets and ignores the old funding reply', async () => {
  const state = { funding: false, balance: null as number | null };
  let finish!: () => void;
  vi.mocked(fetchFundingStatus)
    .mockResolvedValueOnce({ balance: 0, needsFunds: true })
    .mockResolvedValue({ balance: 10000000, needsFunds: false });
  vi.mocked(requestFunds).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const update = (next: object) => Object.assign(state, next);
  const funded = vi.fn();
  const close = watchFunding({ address: 'old' }, {}, update, funded);
  await vi.waitFor(() => expect(state.funding).toBe(true));
  close();
  const closeNext = watchFunding({ address: 'new' }, {}, update, funded);
  try {
    await vi.waitFor(() => expect(state.balance).toBe(10000000));
    expect(state.funding).toBe(false);
    finish();
    await Promise.resolve();
    expect(funded).not.toHaveBeenCalled();
  } finally {
    finish();
    closeNext();
  }
});

it('never calls a public faucet when account registration funds the demo', async () => {
  vi.mocked(requestFunds).mockClear();
  vi.mocked(fetchFundingStatus).mockResolvedValue({ balance: 0, needsFunds: true });
  const update = vi.fn();
  const close = watchFunding({ address: 'new' }, { accountFunding: true }, update, vi.fn());
  try {
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith({ status: {} }));
    expect(requestFunds).not.toHaveBeenCalled();
  } finally {
    close();
  }
});
