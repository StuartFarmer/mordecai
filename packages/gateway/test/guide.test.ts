import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

it('copies the displayed command and selects it when clipboard access is denied', async () => {
  const pre = {
    textContent: 'node app.mjs\n',
    focus: vi.fn(),
    getAttribute: () => 'Run the app network',
  };
  const feedback = { textContent: '' };
  const selection = { removeAllRanges: vi.fn(), addRange: vi.fn() };
  const range = { selectNodeContents: vi.fn() };
  const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
  let click: () => Promise<void>;
  let reset: () => void;
  const button = {
    textContent: '',
    setAttribute: vi.fn(),
    addEventListener: (_event: string, callback: typeof click) => {
      click = callback;
    },
  };
  const label = { append: vi.fn() };
  runInNewContext(readFileSync(new URL('../public/guide.js', import.meta.url), 'utf8'), {
    document: {
      getElementById: () => feedback,
      querySelectorAll: () => [
        { querySelector: (selector: string) => (selector === 'pre' ? pre : label) },
      ],
      createElement: () => button,
      createRange: () => range,
    },
    navigator: { clipboard },
    window: { getSelection: () => selection },
    setTimeout: (callback: typeof reset) => {
      reset = callback;
    },
  });
  await click!();
  expect(clipboard.writeText).toHaveBeenCalledWith('node app.mjs\n');
  expect(button.textContent).toBe('Copied');
  reset!();
  expect(button.textContent).toBe('Copy');

  clipboard.writeText.mockRejectedValue(new Error('permission denied'));
  await click!();
  expect(range.selectNodeContents).toHaveBeenCalledWith(pre);
  expect(selection.addRange).toHaveBeenCalledWith(range);
  expect(feedback.textContent).toContain('Copy command');
});
