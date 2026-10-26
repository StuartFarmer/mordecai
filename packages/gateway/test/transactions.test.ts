import { expect, it, vi } from 'vitest';
import { Wallet, verifyTransactionSignature, transactionHash } from '@mordecai/wallet';
import { createBrowserWallet } from '@mordecai/wallet/browser';
import { decodeTransaction, encodePayload } from '@mordecai/protocol';
import { TransactionClient, transactionSummary } from '../web/transactions.js';

function setup() {
  const state = {
    chainId: 'test',
    nonce: '0',
    balance: '100000',
    mode: 'ok',
    receipt: null as null | { hash: string; success: boolean; fee: string },
  };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === './api/head') return Response.json({ chainId: state.chainId });
    if (url.startsWith('./api/account/'))
      return Response.json({ nonce: state.nonce, balance: state.balance });
    if (url.startsWith('./api/tx/'))
      return state.receipt ? Response.json(state.receipt) : Response.json({}, { status: 404 });
    if (state.mode === 'lost') throw new TypeError('connection lost');
    if (state.mode === 'rejected')
      return Response.json({ error: 'rejected by node', rejected: true }, { status: 400 });
    const bytes = Buffer.from(JSON.parse(init!.body as string).tx, 'hex');
    return Response.json({
      hash: Buffer.from(transactionHash(decodeTransaction(bytes))).toString('hex'),
    });
  });
  return {
    state,
    fetch,
    client: new TransactionClient(fetch),
    wallet: createBrowserWallet(),
    to: Wallet.create().wallet.address,
  };
}

it('prepares a native-compatible transfer with exact integer amounts and fee ceiling', async () => {
  const { client, wallet, to } = setup();
  const prepared = await client.prepareTransfer(wallet, to, '123');
  const tx = decodeTransaction(Buffer.from(prepared.hex, 'hex'));
  expect(tx.nonce).toBe(0n);
  expect(tx.maxFee).toBe(1000n);
  expect(tx.payload).toMatchObject({ kind: 'transfer', amount: 123n });
  expect(verifyTransactionSignature(tx)).toBe(true);
  expect(prepared.hash).toBe(Buffer.from(transactionHash(tx)).toString('hex'));
});

it('rejects malformed amounts, addresses, and insufficient funds before submission', async () => {
  const { client, wallet, to, state, fetch } = setup();
  for (const amount of ['0', '-1', '1.5', '1e3', '18446744073709551616'])
    await expect(client.prepareTransfer(wallet, to, amount)).rejects.toThrow();
  await expect(client.prepareTransfer(wallet, 'bad', '1')).rejects.toThrow(/address/);
  state.balance = '1000';
  await expect(client.prepareTransfer(wallet, to, '1')).rejects.toThrow(/balance/);
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it('signs an unsigned payload using the loaded wallet and current network/nonce', async () => {
  const { client, wallet, state, fetch } = setup();
  state.nonce = '7';
  const payload = {
    kind: 'execute_contract' as const,
    contract: new Uint8Array(32).fill(3),
    action: 'play',
    args: new Uint8Array([4, 5]),
    value: 123n,
  };
  const prepared = await client.prepareTransaction(
    wallet,
    Buffer.from(encodePayload(payload)).toString('hex'),
    '2000',
  );
  expect(prepared.tx).toMatchObject({
    chainId: 'test',
    nonce: 7n,
    maxFee: 2000n,
    sender: wallet.publicKey,
    payload,
  });
  expect(verifyTransactionSignature(prepared.tx)).toBe(true);
  expect(transactionSummary(prepared)).toContain('0405');
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  await client.submit(prepared);
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});

it('rejects missing wallets, malformed/oversized payloads and invalid fees before signing', async () => {
  const { client, wallet, to, state } = setup();
  const prepared = await client.prepareTransfer(wallet, to, '100');
  const payload = Buffer.from(encodePayload(prepared.tx.payload)).toString('hex');
  await expect(client.prepareTransaction(null, payload, '1000')).rejects.toThrow(/account/);
  for (const input of ['xx', '0', 'ff', '01'.repeat(32), prepared.hex]) {
    await expect(client.prepareTransaction(wallet, input, '1000')).rejects.toThrow();
  }
  await expect(client.prepareTransaction(wallet, 'ff'.repeat(524288), '1000')).rejects.toThrow(
    /large/,
  );
  for (const fee of ['0', '-1', '1.5', '1e3', '18446744073709551616']) {
    await expect(client.prepareTransaction(wallet, payload, fee)).rejects.toThrow();
  }
  state.balance = '1000';
  await expect(client.prepareTransaction(wallet, payload, '1000')).rejects.toThrow(/balance/);
});

it('rechecks nonce, attached value and network for locally signed contract transactions', async () => {
  const { client, wallet, state } = setup();
  const payload = {
    kind: 'execute_contract' as const,
    contract: new Uint8Array(32),
    action: 'play',
    args: new Uint8Array(),
    value: 500n,
  };
  const prepared = await client.prepareTransaction(
    wallet,
    Buffer.from(encodePayload(payload)).toString('hex'),
    '1000',
  );
  state.nonce = '1';
  await expect(client.submit(prepared)).rejects.toThrow(/nonce/);
  state.nonce = '0';
  state.balance = '1200';
  await expect(client.submit(prepared)).rejects.toThrow(/balance/);
  state.balance = '100000';
  state.chainId = 'other';
  await expect(client.submit(prepared)).rejects.toThrow(/network/);
});

it('requires a fresh review if nonce or balance changed before sending', async () => {
  const { client, wallet, to, state, fetch } = setup();
  const prepared = await client.prepareTransfer(wallet, to, '100');
  state.nonce = '1';
  await expect(client.submit(prepared)).rejects.toThrow(/nonce/);
  state.nonce = '0';
  state.balance = '1';
  await expect(client.submit(prepared)).rejects.toThrow(/balance/);
  expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it('retains uncertain submissions and retries identical bytes without allowing another send', async () => {
  const { client, wallet, to, state, fetch } = setup();
  const prepared = await client.prepareTransfer(wallet, to, '100');
  state.mode = 'lost';
  await expect(client.submit(prepared)).rejects.toThrow();
  expect(client.pending.hash).toBe(prepared.hash);
  await expect(client.submit(prepared)).rejects.toThrow(/pending/);
  state.mode = 'ok';
  await client.retry();
  const posts = fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(posts).toHaveLength(2);
  expect(posts[0]![1]!.body).toBe(posts[1]![1]!.body);
});

it('distinguishes a rejected first submission from rejection of a previously uncertain retry', async () => {
  const { client, wallet, to, state } = setup();
  const prepared = await client.prepareTransfer(wallet, to, '100');
  state.mode = 'rejected';
  await expect(client.submit(prepared)).rejects.toThrow(/rejected/);
  expect(client.pending).toBeNull();
  state.mode = 'lost';
  await expect(client.submit(prepared)).rejects.toThrow();
  state.mode = 'rejected';
  await expect(client.retry()).rejects.toThrow();
  expect(client.pending.hash).toBe(prepared.hash);
});

it('waits for a real receipt and records success or failure', async () => {
  const { client, wallet, to, state } = setup();
  const prepared = await client.prepareTransfer(wallet, to, '100');
  await client.submit(prepared);
  await client.checkPending();
  expect(client.pending.hash).toBe(prepared.hash);
  state.receipt = { hash: prepared.hash, success: true, fee: '200' };
  await client.checkPending();
  expect(client.pending).toBeNull();
  expect(client.history[0]).toMatchObject({ hash: prepared.hash, status: 'confirmed', fee: '200' });
});

it('does not claim payment when the nonce advances without a receipt', async () => {
  const { client, wallet, to, state } = setup();
  await client.submit(await client.prepareTransfer(wallet, to, '100'));
  state.nonce = '1';
  await client.checkPending();
  expect(client.history[0].status).toBe('nonce used; receipt unavailable');
});

it('does not resolve a pending transaction from account data on another network', async () => {
  const { client, wallet, to, state } = setup();
  const prepared = await client.prepareTransfer(wallet, to, '100');
  await client.submit(prepared);
  state.chainId = 'another-chain';
  state.nonce = '10';
  await expect(client.checkPending()).rejects.toThrow(/network/);
  expect(client.pending.hash).toBe(prepared.hash);
});

it('serializes simultaneous submits and records a failed receipt', async () => {
  const { client, wallet, to, state, fetch } = setup();
  const prepared = await client.prepareTransfer(wallet, to, '100');
  const first = client.submit(prepared);
  await expect(client.submit(prepared)).rejects.toThrow(/pending/);
  await first;
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  state.receipt = { hash: prepared.hash, success: false, fee: '100' };
  await client.checkPending();
  expect(client.history[0].status).toBe('failed');
});

it('calls the default browser fetch without binding it to the transaction client', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async function (this: unknown) {
    if (this instanceof TransactionClient) throw new TypeError('Illegal invocation');
    return Response.json({ chainId: 'test' });
  } as typeof fetch;
  try {
    expect(await new TransactionClient().get('./api/head')).toEqual({ chainId: 'test' });
  } finally {
    globalThis.fetch = original;
  }
});

it('finds a receipt when the transaction lands between the first lookup and the nonce check', async () => {
  const { client, wallet, to, state, fetch } = setup();
  const prepared = await client.prepareTransfer(wallet, to, '100');
  await client.submit(prepared);
  state.nonce = '1';
  state.receipt = { hash: prepared.hash, success: true, fee: '183' };
  fetch.mockImplementationOnce(async () => Response.json({ chainId: state.chainId }));
  fetch.mockImplementationOnce(async () => Response.json({}, { status: 404 }));
  await client.checkPending();
  expect(client.history[0]).toMatchObject({ status: 'confirmed', fee: '183' });
  expect(client.pending).toBeNull();
});
