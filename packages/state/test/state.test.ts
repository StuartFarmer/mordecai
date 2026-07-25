import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EMPTY_ROOT,
  LevelStore,
  MemoryStore,
  Overlay,
  computeStateRoot,
  computeStateRootWith,
  leafHash,
  merkleRoot,
  type StateStore,
} from '../src/index.js';

const b = (s: string) => new TextEncoder().encode(s);
const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function levelStore(): LevelStore {
  const dir = mkdtempSync(join(tmpdir(), 'mordecai-state-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return new LevelStore(dir);
}

describe('merkle', () => {
  it('empty root is 32 zero bytes', () => {
    expect(merkleRoot([])).toEqual(EMPTY_ROOT);
  });

  it('is order-sensitive and collision-safe between leaf/node domains', () => {
    const l1 = leafHash(b('a'), b('1'));
    const l2 = leafHash(b('b'), b('2'));
    expect(merkleRoot([l1, l2])).not.toEqual(merkleRoot([l2, l1]));
    expect(leafHash(b('a'), b('1'))).not.toEqual(leafHash(b('a1'), b('')));
  });

  it('handles odd leaf counts', () => {
    const leaves = [leafHash(b('a'), b('1')), leafHash(b('b'), b('2')), leafHash(b('c'), b('3'))];
    expect(merkleRoot(leaves)).toHaveLength(32);
    expect(merkleRoot(leaves)).not.toEqual(merkleRoot(leaves.slice(0, 2)));
  });
});

describe.each([
  ['MemoryStore', () => new MemoryStore() as StateStore],
  ['LevelStore', () => levelStore() as StateStore],
])('%s', (_name, make) => {
  it('applies puts and deletes atomically', async () => {
    const store = make();
    await store.applyChanges([
      [b('x'), b('1')],
      [b('y'), b('2')],
    ]);
    expect(await store.get(b('x'))).toEqual(b('1'));
    await store.applyChanges([[b('x'), null]]);
    expect(await store.get(b('x'))).toBeUndefined();
    expect(await store.get(b('y'))).toEqual(b('2'));
    await store.close();
  });

  it('iterates entries in ascending key order', async () => {
    const store = make();
    await store.applyChanges([
      [b('bb'), b('2')],
      [b('aa'), b('1')],
      [b('cc'), b('3')],
    ]);
    const keys: string[] = [];
    for await (const [key] of store.entries()) keys.push(new TextDecoder().decode(key));
    expect(keys).toEqual(['aa', 'bb', 'cc']);
    await store.close();
  });

  it('state root is insertion-order independent and mutation-sensitive', async () => {
    const s1 = make();
    const s2 = make();
    await s1.applyChanges([
      [b('a'), b('1')],
      [b('b'), b('2')],
    ]);
    await s2.applyChanges([[b('b'), b('2')]]);
    await s2.applyChanges([[b('a'), b('1')]]);
    const root = await computeStateRoot(s1);
    expect(await computeStateRoot(s2)).toEqual(root);
    await s1.applyChanges([[b('a'), b('9')]]);
    expect(await computeStateRoot(s1)).not.toEqual(root);
    await s1.close();
    await s2.close();
  });
});

it('memory and level stores commit to identical roots', async () => {
  const mem = new MemoryStore();
  const lvl = levelStore();
  const changes: [Uint8Array, Uint8Array][] = [
    [b('acct/alice'), b('100')],
    [b('acct/bob'), b('50')],
    [b('ctr/1/items'), b('sword')],
  ];
  await mem.applyChanges(changes);
  await lvl.applyChanges(changes);
  expect(await computeStateRoot(mem)).toEqual(await computeStateRoot(lvl));
  await lvl.close();
});

describe('computeStateRootWith', () => {
  it('matches the root after actually applying the changes', async () => {
    const store = new MemoryStore();
    await store.applyChanges([
      [b('a'), b('1')],
      [b('c'), b('3')],
      [b('e'), b('5')],
    ]);
    const changes: [Uint8Array, Uint8Array | null][] = [
      [b('b'), b('2')], // insert between
      [b('c'), b('30')], // overwrite
      [b('e'), null], // delete
      [b('f'), b('6')], // append past end
    ];
    const predicted = await computeStateRootWith(store, changes);
    await store.applyChanges(changes);
    expect(predicted).toEqual(await computeStateRoot(store));
  });

  it('handles an empty store and empty changes', async () => {
    const store = new MemoryStore();
    expect(await computeStateRootWith(store, [])).toEqual(EMPTY_ROOT);
    const predicted = await computeStateRootWith(store, [[b('x'), b('1')]]);
    await store.applyChanges([[b('x'), b('1')]]);
    expect(predicted).toEqual(await computeStateRoot(store));
  });
});

describe('Overlay', () => {
  it('reads through to base and shadows with writes/deletes', async () => {
    const store = new MemoryStore();
    await store.applyChanges([[b('k'), b('base')]]);
    const overlay = new Overlay(store);
    expect(await overlay.get(b('k'))).toEqual(b('base'));
    overlay.set(b('k'), b('new'));
    expect(await overlay.get(b('k'))).toEqual(b('new'));
    overlay.delete(b('k'));
    expect(await overlay.get(b('k'))).toBeUndefined();
    expect(await store.get(b('k'))).toEqual(b('base'));
  });

  it('produces sorted changes and merges into a parent', async () => {
    const store = new MemoryStore();
    const block = new Overlay(store);
    const tx = new Overlay(block);
    tx.set(b('z'), b('26'));
    tx.set(b('a'), b('1'));
    expect(tx.changes().map(([k]) => new TextDecoder().decode(k))).toEqual(['a', 'z']);
    tx.commitInto(block);
    expect(await block.get(b('z'))).toEqual(b('26'));
    await store.applyChanges(block.changes());
    expect(await store.get(b('a'))).toEqual(b('1'));
  });

  it('discarding a child overlay reverts a failed transaction', async () => {
    const store = new MemoryStore();
    await store.applyChanges([[b('balance'), b('100')]]);
    const block = new Overlay(store);
    const failedTx = new Overlay(block);
    failedTx.set(b('balance'), b('0'));
    // failedTx is simply dropped
    expect(await block.get(b('balance'))).toEqual(b('100'));
    expect(block.size).toBe(0);
  });
});
