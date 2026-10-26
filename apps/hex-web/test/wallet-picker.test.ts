import { expect, it, vi } from 'vitest';
import { createBrowserWallet, exportBrowserWallet } from '@mordecai/wallet/browser';
import WalletPicker from '../src/WalletPicker.jsx';

// Exercise event ordering without a DOM renderer; browser tests cover the rendered form.
vi.mock('react', () => ({
  default: {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
      type,
      props,
      children,
    }),
  },
  useState: (value: unknown) => [value, () => {}],
  useRef: (value: unknown) => ({ current: value }),
}));

type Element = {
  type: string;
  props: Record<string, unknown>;
  children: (Element | string | null)[];
};
const click = (node: Element) => (node.props.onClick as () => void)();
function find(root: Element, matches: (node: Element) => boolean): Element {
  if (matches(root)) return root;
  for (const child of root.children) {
    if (child && typeof child === 'object') {
      try {
        return find(child, matches);
      } catch {
        /* next child */
      }
    }
  }
  throw new Error('Element not found');
}

it('offers a saved legacy wallet without preventing a different import', () => {
  const legacy = createBrowserWallet();
  const onLoad = vi.fn();
  const tree = WalletPicker({ onLoad, legacy });
  click(find(tree, (node) => node.children.includes('Use saved Hex account')));
  expect(onLoad).toHaveBeenCalledWith(legacy, true);
  expect(find(tree, (node) => node.props?.id === 'hex-wallet-file')).toBeDefined();
});

it('does not replace a newly created key when an older file read finishes', async () => {
  const fromFile = createBrowserWallet();
  let finish!: (text: string) => void;
  const pending = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const onLoad = vi.fn();
  const tree = WalletPicker({ onLoad });
  const change = find(tree, (node) => node.props?.id === 'hex-wallet-file').props.onChange as (
    event: unknown,
  ) => Promise<void>;
  const importFile = change({ target: { files: [{ size: 300, text: () => pending }] } });
  click(find(tree, (node) => node.children.includes('Create temporary account')));
  expect(onLoad).toHaveBeenCalledTimes(1);
  finish(exportBrowserWallet(fromFile));
  await importFile;
  expect(onLoad).toHaveBeenCalledTimes(1);
  expect(onLoad.mock.calls[0]![0].address).not.toBe(fromFile.address);
});
