import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { transactionHash } from '@mordecai/wallet';
import { decodeTransaction } from '@mordecai/protocol';
import { loadDemoIdentity, bootstrapTransaction } from '../../../scripts/lib/demo-state.mjs';

it('persists private demo identities and refuses conflicting configuration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'demo-identity-test-'));
  try {
    const first = loadDemoIdentity(dir, 'demo', 180000n);
    const second = loadDemoIdentity(dir, 'demo', 180000n);
    expect(second.key('relayer').publicKey).toEqual(first.key('relayer').publicKey);
    expect(statSync(join(dir, 'identity.json')).mode & 0o777).toBe(0o600);
    expect(() => loadDemoIdentity(dir, 'other', 180000n)).toThrow(/mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('reuses bootstrap bytes after a lost reply and skips already confirmed deployments', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'demo-journal-test-'));
  try {
    const identity = loadDemoIdentity(dir, 'demo', 180000n);
    const who = identity.key('relayer');
    const payload = { kind: 'transfer', to: identity.key('web-faucet').publicKey, amount: 100n };
    let receipt: { success: boolean; returnData: string } | null = null;
    let lost = true;
    const rpc = {
      getAccount: async () => ({ nonce: '0' }),
      getTx: async () => receipt,
      submitTx: vi.fn(async (bytes: Uint8Array) => {
        if (lost) throw new Error('lost response');
        return Buffer.from(transactionHash(decodeTransaction(bytes))).toString('hex');
      }),
      waitForTx: async () => (receipt = { success: true, returnData: '' }),
    };
    await expect(bootstrapTransaction(dir, 'fund', rpc, 'demo', who, payload)).rejects.toThrow(
      /lost/,
    );
    lost = false;
    await bootstrapTransaction(dir, 'fund', rpc, 'demo', who, payload);
    expect(rpc.submitTx.mock.calls[0]![0]).toEqual(rpc.submitTx.mock.calls[1]![0]);
    await bootstrapTransaction(dir, 'fund', rpc, 'demo', who, payload);
    expect(rpc.submitTx).toHaveBeenCalledTimes(2);
    await expect(
      bootstrapTransaction(dir, 'fund', rpc, 'demo', who, { ...payload, amount: 200n }),
    ).rejects.toThrow(/changed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
