import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAddress } from '@mordecai/crypto';
import { Chain } from '../src/chain.js';

it('reopens at genesis with allocations out of key order without changing the chain hash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mordecai-genesis-'));
  const genesis = {
    chainId: 'unsorted-allocations',
    validators: [encodeAddress(new Uint8Array(32).fill(1))],
    allocations: [2, 1].map((n) => ({
      address: encodeAddress(new Uint8Array(32).fill(n)),
      balance: 100n,
    })),
  };
  let chain = await Chain.open(dir, genesis);
  try {
    const hash = chain.headHash;
    await chain.close();
    chain = await Chain.open(dir, genesis);
    expect(chain.headHash).toEqual(hash);
    expect((await chain.getAccount(new Uint8Array(32).fill(2))).balance).toBe(100n);
  } finally {
    await chain.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
