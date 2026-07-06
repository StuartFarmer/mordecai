import createTestnet from 'hyperdht/testnet';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verify } from '@hssn/crypto';
import { transactionSigningBytes } from '@hssn/protocol';
import { Wallet } from '@hssn/wallet';
import { RemoteSigner, WalletDaemon, type ApprovalRequest } from '../src/index.js';

const { wallet } = Wallet.create();
const { wallet: merchant } = Wallet.create();
const prompts: ApprovalRequest[] = [];

let testnet: Awaited<ReturnType<typeof createTestnet>>;
let daemon: WalletDaemon;
let chess: RemoteSigner;

const pay = (amount: bigint) => ({
  chainId: 'test',
  nonce: 0n,
  maxFee: 100n,
  payload: { kind: 'transfer' as const, to: merchant.publicKey, amount },
});

beforeAll(async () => {
  testnet = await createTestnet(3);
  daemon = await WalletDaemon.start({
    wallet,
    grants: {
      chess: { auth: true, spendLimit: 1_000n },
      ads: { auth: false, spendLimit: 0n },
    },
    approve: (request) => {
      prompts.push(request);
      return request.cost <= 10_000n; // the "user" approves small overages
    },
    bootstrap: testnet.bootstrap,
  });
  chess = await RemoteSigner.connect(daemon.publicKey, 'chess', {
    bootstrap: testnet.bootstrap,
  });
}, 60_000);

afterAll(async () => {
  await chess.close();
  await daemon.close();
  await testnet.destroy();
}, 60_000);

describe('wallet daemon over IPC (Pear trust boundary)', () => {
  it('hands the app its identity without the keys', () => {
    expect(chess.address).toBe(wallet.address);
    expect(chess.publicKey).toEqual(wallet.publicKey);
  });

  it('signs within the allowance across the process boundary', { timeout: 30_000 }, async () => {
    const tx = await chess.signTransaction(pay(400n));
    expect(tx.sender).toEqual(wallet.publicKey);
    expect(verify(tx.signature, transactionSigningBytes(tx), wallet.publicKey)).toBe(true);
  });

  it('escalates overages to the approval prompt', { timeout: 30_000 }, async () => {
    const ok = await chess.signTransaction(pay(5_000n)); // approved by the hook
    expect(verify(ok.signature, transactionSigningBytes(ok), wallet.publicKey)).toBe(true);
    expect(prompts.at(-1)).toMatchObject({ appId: 'chess', cost: 5_100n });

    await expect(chess.signTransaction(pay(50_000n))).rejects.toThrow(/not approved/);
  });

  it('enforces the auth grant and refuses unknown apps', { timeout: 30_000 }, async () => {
    const sig = await chess.signMessage(new TextEncoder().encode('login'));
    expect(verify(sig, new TextEncoder().encode('login'), wallet.publicKey)).toBe(true);

    const ads = await RemoteSigner.connect(daemon.publicKey, 'ads', {
      bootstrap: testnet.bootstrap,
    });
    await expect(ads.signMessage(new Uint8Array(4))).rejects.toThrow(/no auth permission/);
    await ads.close();

    await expect(
      RemoteSigner.connect(daemon.publicKey, 'malware', { bootstrap: testnet.bootstrap }),
    ).rejects.toThrow(/no wallet grant/);
  });
});
