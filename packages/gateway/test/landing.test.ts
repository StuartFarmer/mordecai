import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

it('updates the readout, clears stale data on failure, and recovers on the next poll', async () => {
  const elements = Object.fromEntries(
    ['status', 'chain-id', 'height', 'head-hash', 'last-checked'].map((id) => [
      id,
      { textContent: '', dataset: { state: '' } },
    ]),
  );
  let response = {
    chainId: '<img src=x onerror=alert(1)>',
    height: '9007199254740993',
    headHash: 'ab'.repeat(32),
    stateRoot: 'cd'.repeat(32),
    timestampMs: '1750000000000',
  };
  let available = true;
  let poll: () => Promise<void>;
  runInNewContext(readFileSync(new URL('../public/mordecai.js', import.meta.url), 'utf8'), {
    document: { getElementById: (id: string) => elements[id] },
    AbortSignal,
    fetch: async () => ({ ok: available, json: async () => response }),
    setTimeout: (callback: typeof poll) => {
      poll = callback;
    },
  });
  await vi.waitFor(() => expect(elements.status!.dataset.state).toBe('reachable'));
  // Untrusted labels stay plain text, and heights retain precision beyond Number.MAX_SAFE_INTEGER.
  expect(elements['chain-id']!.textContent).toBe('<img src=x onerror=alert(1)>');
  expect(elements.height!.textContent.replace(/\D/g, '')).toBe('9007199254740993');
  expect(elements['head-hash']!.textContent).toBe('ab'.repeat(32));

  available = false;
  await poll!();
  expect(elements.status!.dataset.state).toBe('unavailable');
  expect(elements['head-hash']!.textContent).toBe('—');

  available = true;
  response = { ...response, height: 'not a height' };
  await poll!();
  expect(elements.status!.dataset.state).toBe('unavailable');

  response = { ...response, chainId: 'mordecai-dev-1', height: '42' };
  await poll!();
  expect(elements.status!.dataset.state).toBe('reachable');
  expect(elements.height!.textContent).toBe('42');
});
