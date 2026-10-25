import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import App, { DISCLOSURE } from '../src/App.jsx';
import { act, encodeArgs, fetchBoard, phaseLabel } from '../src/chain.js';
import { bootBounties } from '../../../scripts/lib/bounties-demo.mjs';

const config = { chainId: 'shared', contract: 'ab'.repeat(32), awardWindow: 100 };
afterEach(() => vi.unstubAllGlobals());

it('uses only the shared wallet and attaches exactly the reward without coercing through Number', async () => {
  const receipt = { success: true, hash: 'ef'.repeat(32), height: 7, fee: '42' };
  const sendTransaction = vi.fn().mockResolvedValue(receipt);
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(
    act(
      { sendTransaction },
      config,
      'create',
      { title: 'Question', request: 'Criteria', submit_end: 100 },
      '9007199254740993',
    ),
  ).resolves.toBe(receipt);
  expect(sendTransaction).toHaveBeenCalledWith(
    '',
    'shared',
    expect.objectContaining({ action: 'create', value: 9007199254740993n }),
    500000n,
  );
  expect(fetch).not.toHaveBeenCalled();
});

it('rejects malformed amounts, invalid IDs and UTF-8 overflow before signing', async () => {
  const sendTransaction = vi.fn();
  for (const reward of ['0', '-1', '1.2', '1e3', '18446744073709551616'])
    await expect(
      act(
        { sendTransaction },
        config,
        'create',
        { title: 'Q', request: 'R', submit_end: 100 },
        reward,
      ),
    ).rejects.toThrow();
  expect(() => encodeArgs('respond', { bounty_id: 0, text: '🙂'.repeat(2049) })).toThrow(/UTF-8/);
  expect(() =>
    encodeArgs('create', { title: 'é'.repeat(81), request: 'R', submit_end: 100 }),
  ).toThrow(/UTF-8/);
  expect(() => encodeArgs('award', { bounty_id: 0, response_id: -1 })).toThrow();
  await expect(act({ sendTransaction }, config, 'refund', { bounty_id: 0 }, '1')).rejects.toThrow();
  expect(sendTransaction).not.toHaveBeenCalled();
});

it('preserves uncertain submission errors and never generates a replacement transaction', async () => {
  const unknown = new Error('Confirmation unknown. Check Wallet before retrying.');
  const sendTransaction = vi.fn().mockRejectedValue(unknown);
  await expect(
    act({ sendTransaction }, config, 'award', { bounty_id: 0, response_id: 2 }),
  ).rejects.toBe(unknown);
  expect(sendTransaction).toHaveBeenCalledTimes(1);
  await expect(act(null, config, 'refund', { bounty_id: 0 })).rejects.toThrow(/Wallet/);
});

it('keeps browsing and public policy visible with Wallet closed', () => {
  const session = { subscribe: () => () => {}, getSnapshot: () => null };
  const html = renderToStaticMarkup(React.createElement(App, { session, initialConfig: config }));
  expect(html).toContain('Information bounties');
  expect(html).toContain('Open Wallet');
  expect(html).toContain('Test CAI only');
  expect(html).toContain('no guaranteed award');
  expect(html).toContain(DISCLOSURE);
  expect(html).toContain('Review funding');
  expect(html).not.toContain('seed');
});

it('derives settlement labels from confirmed phases and rejects network mismatch', async () => {
  const bounty = { phase: 0, submit_end: 100, award_end: 200 };
  expect(phaseLabel(bounty, 99)).toBe('Open — reward reserved');
  expect(phaseLabel(bounty, 100)).toBe('Creator selecting');
  expect(phaseLabel(bounty, 200)).toBe('No award — refund available');
  expect(phaseLabel({ ...bounty, phase: 1 }, 200)).toBe('Award paid');
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (url) => ({
      ok: true,
      json: async () => (url.includes('/state') ? [] : { chainId: 'wrong', height: 1 }),
    })),
  );
  await expect(fetchBoard(config)).rejects.toThrow(/network/);
});

it('journals deployment once without identities or an initialization race', async () => {
  const bootL1 = vi.fn().mockResolvedValue({ returnData: config.contract });
  await expect(
    bootBounties({ repoRoot: process.cwd(), chainId: 'shared', bootL1 }),
  ).resolves.toEqual({ config });
  expect(bootL1).toHaveBeenCalledTimes(1);
  expect(bootL1).toHaveBeenCalledWith(
    'bounties-deploy',
    expect.objectContaining({ kind: 'deploy_contract' }),
  );
});
