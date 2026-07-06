import { describe, expect, it } from 'vitest';
import { verify } from '@hssn/crypto';
import { transactionSigningBytes } from '@hssn/protocol';
import { Wallet } from '@hssn/wallet';
import { PermissionDeniedError, WalletSession, type ApprovalRequest } from '../src/index.js';

const { wallet } = Wallet.create();
const { wallet: merchant } = Wallet.create();
const pay = (amount: bigint) => ({
  chainId: 'test',
  nonce: 0n,
  maxFee: 100n,
  payload: { kind: 'transfer' as const, to: merchant.publicKey, amount },
});

describe('WalletSession (Pear per-app permissions)', () => {
  it('signs within the granted allowance and burns it down', async () => {
    const session = new WalletSession(wallet, { appId: 'chess', auth: true, spendLimit: 1_000n });
    const tx = await session.signTransaction(pay(400n)); // cost 500
    expect(verify(tx.signature, transactionSigningBytes(tx), wallet.publicKey)).toBe(true);
    expect(session.remainingAllowance).toBe(500n);
    await session.signTransaction(pay(400n)); // another 500
    expect(session.remainingAllowance).toBe(0n);
  });

  it('escalates beyond the allowance and denies without approval', async () => {
    const session = new WalletSession(wallet, { appId: 'chess', auth: true, spendLimit: 100n });
    await expect(session.signTransaction(pay(5_000n))).rejects.toThrow(PermissionDeniedError);
    expect(session.remainingAllowance).toBe(100n); // nothing burned on denial
  });

  it('signs beyond the allowance when the user approves the prompt', async () => {
    const prompts: ApprovalRequest[] = [];
    const session = new WalletSession(
      wallet,
      { appId: 'chess', auth: true, spendLimit: 0n },
      (request) => {
        prompts.push(request);
        return true;
      },
    );
    const tx = await session.signTransaction(pay(5_000n));
    expect(verify(tx.signature, transactionSigningBytes(tx), wallet.publicKey)).toBe(true);
    expect(prompts[0]).toMatchObject({ appId: 'chess', cost: 5_100n, remaining: 0n });
  });

  it('gates auth challenges on the auth permission', async () => {
    const noAuth = new WalletSession(wallet, { appId: 'ads', auth: false, spendLimit: 0n });
    await expect(noAuth.signMessage(new Uint8Array(4))).rejects.toThrow(PermissionDeniedError);
    const withAuth = new WalletSession(wallet, { appId: 'chess', auth: true, spendLimit: 0n });
    const challenge = new TextEncoder().encode('hello');
    expect(verify(await withAuth.signMessage(challenge), challenge, wallet.publicKey)).toBe(true);
  });

  it('never exposes key material to the app', () => {
    const session = new WalletSession(wallet, { appId: 'chess', auth: true, spendLimit: 0n });
    expect(Object.keys(session)).not.toContain('secretKey');
    expect((session as unknown as { seed?: unknown }).seed).toBeUndefined();
  });
});
