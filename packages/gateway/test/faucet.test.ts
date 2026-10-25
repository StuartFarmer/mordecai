import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { interactiveKdfLimits } from '@mordecai/crypto';
import { Wallet, transactionHash } from '@mordecai/wallet';
import { decodeTransaction } from '@mordecai/protocol';
import { Faucet, loadFaucetWallet } from '../src/faucet.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('loads only an explicitly configured keystore and requires the correct environment passphrase', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mordecai-faucet-keystore-'));
  const file = join(dir, 'wallet.json');
  const { wallet } = Wallet.create();
  try {
    writeFileSync(
      file,
      JSON.stringify(wallet.toKeystore('test-passphrase', interactiveKdfLimits())),
      { mode: 0o600 },
    );
    vi.stubEnv('MORDECAI_FAUCET_PASSPHRASE', '');
    expect(loadFaucetWallet()).toBeUndefined();
    expect(() => loadFaucetWallet(file)).toThrow(/MORDECAI_FAUCET_PASSPHRASE/);
    vi.stubEnv('MORDECAI_FAUCET_PASSPHRASE', 'wrong');
    expect(() => loadFaucetWallet(file)).toThrow();
    vi.stubEnv('MORDECAI_FAUCET_PASSPHRASE', 'test-passphrase');
    expect(loadFaucetWallet(file)?.address).toBe(wallet.address);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function setup(balance = '10000000') {
  const { wallet } = Wallet.create();
  const { wallet: recipient } = Wallet.create();
  let nonce = 0n;
  const rpc = {
    getHead: vi.fn(async () => ({ chainId: 'test' })),
    getAccount: vi.fn(async () => ({ balance, nonce: nonce.toString() })),
    submitTx: vi.fn(async (bytes: Uint8Array) =>
      Buffer.from(transactionHash(decodeTransaction(bytes))).toString('hex'),
    ),
  };
  return {
    faucet: new Faucet(rpc, wallet),
    rpc,
    wallet,
    recipient,
    confirm: () => {
      nonce += 1n;
    },
  };
}

it('signs a fixed transfer and exposes only public metadata', async () => {
  const { faucet, rpc, wallet, recipient } = setup();
  expect(faucet.info()).toEqual({
    enabled: true,
    address: wallet.address,
    amount: '10000',
    cooldownSeconds: 60,
  });
  const result = await faucet.claim(recipient.address, 'ip1');
  const tx = decodeTransaction(rpc.submitTx.mock.calls[0]![0]!);
  expect(result).toEqual({
    hash: Buffer.from(transactionHash(tx)).toString('hex'),
    amount: '10000',
    status: 'submitted',
  });
  expect(tx.payload).toEqual({ kind: 'transfer', to: recipient.publicKey, amount: 10000n });
  expect(tx.nonce).toBe(0n);
});

it('rejects invalid, noncanonical and self addresses before contacting the node', async () => {
  const { faucet, rpc, wallet } = setup();
  for (const address of [null, {}, '', 'bad', wallet.address, wallet.address.toUpperCase()]) {
    await expect(faucet.claim(address, 'ip')).rejects.toMatchObject({ status: 400 });
  }
  expect(rpc.getAccount).not.toHaveBeenCalled();
});

it('limits claims by both recipient and IP and allows them after cooldown', async () => {
  let now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const { faucet, recipient, confirm } = setup();
  await faucet.claim(recipient.address, 'ip1');
  confirm();
  await expect(faucet.claim(recipient.address, 'ip2')).rejects.toMatchObject({ status: 429 });
  await expect(faucet.claim(Wallet.create().wallet.address, 'ip1')).rejects.toMatchObject({
    status: 429,
  });
  now += 60000;
  await expect(faucet.claim(recipient.address, 'ip1')).resolves.toMatchObject({
    status: 'submitted',
  });
});

it('caps successful submissions at 100 in a rolling hour', async () => {
  let now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const { faucet, confirm } = setup();
  for (let i = 0; i < 100; i++) {
    await faucet.claim(Wallet.create().wallet.address, `ip${i}`);
    confirm();
  }
  await expect(faucet.claim(Wallet.create().wallet.address, 'next')).rejects.toMatchObject({
    status: 429,
  });
  now += 3600000;
  await expect(faucet.claim(Wallet.create().wallet.address, 'next')).resolves.toMatchObject({
    status: 'submitted',
  });
});

it('rejects an empty wallet without reserving a claim', async () => {
  const { faucet, recipient, rpc } = setup('0');
  await expect(faucet.claim(recipient.address, 'ip')).rejects.toMatchObject({ status: 503 });
  expect(rpc.submitTx).not.toHaveBeenCalled();
  rpc.getAccount.mockResolvedValue({ balance: '10000000', nonce: '0' });
  await expect(faucet.claim(recipient.address, 'ip')).resolves.toMatchObject({
    status: 'submitted',
  });
});

it('rejects concurrent claims and never signs over an outstanding transfer', async () => {
  const { faucet, recipient, rpc, confirm } = setup();
  const first = faucet.claim(recipient.address, 'ip1');
  await expect(faucet.claim(Wallet.create().wallet.address, 'ip2')).rejects.toMatchObject({
    status: 503,
  });
  await first;
  await expect(faucet.claim(Wallet.create().wallet.address, 'ip2')).rejects.toMatchObject({
    status: 503,
  });
  expect(rpc.submitTx.mock.calls[1]![0]).toEqual(rpc.submitTx.mock.calls[0]![0]);
  confirm();
  await faucet.claim(Wallet.create().wallet.address, 'ip2');
  expect(decodeTransaction(rpc.submitTx.mock.calls[2]![0]!).nonce).toBe(1n);
});

it('retains identical signed bytes when the submission result is uncertain', async () => {
  const { faucet, recipient, rpc, confirm } = setup();
  rpc.submitTx.mockRejectedValueOnce(new Error('connection lost'));
  await expect(faucet.claim(recipient.address, 'ip1')).rejects.toMatchObject({ status: 503 });
  await expect(faucet.claim(Wallet.create().wallet.address, 'ip2')).rejects.toMatchObject({
    status: 503,
  });
  expect(rpc.submitTx.mock.calls[1]![0]).toEqual(rpc.submitTx.mock.calls[0]![0]);
  confirm();
  await faucet.claim(Wallet.create().wallet.address, 'ip2');
  expect(decodeTransaction(rpc.submitTx.mock.calls[2]![0]!).nonce).toBe(1n);
});

it('uses the operator grant amount and rejects invalid grants', async () => {
  const { rpc, wallet, recipient } = setup('100000000');
  const faucet = new Faucet(rpc, wallet, 10_000_000n);
  expect(faucet.info().amount).toBe('10000000');
  await faucet.claim(recipient.address, 'test');
  expect(decodeTransaction(rpc.submitTx.mock.calls[0]![0]).payload).toMatchObject({
    amount: 10_000_000n,
  });
  for (const amount of [0n, -1n, 1n << 64n])
    expect(() => new Faucet(rpc, wallet, amount)).toThrow();
});
