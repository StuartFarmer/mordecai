import { expect, it, vi } from 'vitest';
import { bootFrontier } from '../../../scripts/lib/frontier-demo.mjs';

it('uses namespaced durable boot steps and publishes no identity', async () => {
  const contract = 'ab'.repeat(32);
  const bootL1 = vi.fn().mockResolvedValueOnce({ returnData: contract }).mockResolvedValueOnce({});
  const result = await bootFrontier({ repoRoot: process.cwd(), chainId: 'shared', bootL1 });
  expect(bootL1.mock.calls.map(([step]) => step)).toEqual(['frontier-deploy', 'frontier-init']);
  const init = bootL1.mock.calls[1][1];
  expect(init.action).toBe('init');
  expect(new DataView(init.args.buffer).getBigUint64(0, true)).toBe(144n);
  expect(result).toEqual({ config: { chainId: 'shared', contract } });
});
