/* global fetch, AbortSignal */
import { decodePayload, encodeTransaction } from '@mordecai/protocol';
import {
  browserAddress,
  browserTransactionHash,
  decodeBrowserAddress,
  signBrowserTransaction,
} from '@mordecai/wallet/browser';

const MAX_U64 = (1n << 64n) - 1n;
const MAX_FEE = 1000n;
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

function units(value, label = 'Amount') {
  if (!/^\d+$/.test(value) || BigInt(value) > MAX_U64)
    throw new Error(
      `${label} must be a whole number of CAI base units within the supported range.`,
    );
  return BigInt(value);
}

function preparedTransaction(tx) {
  const encoded = hex(encodeTransaction(tx));
  if (encoded.length + 9 > 1_048_576) throw new Error('Transaction is too large for this gateway.');
  return {
    tx,
    hex: encoded,
    hash: browserTransactionHash(tx),
    sender: browserAddress(tx.sender),
  };
}

export function transactionSummary(prepared) {
  const { tx, sender } = prepared;
  const summary = {
    Network: tx.chainId,
    From: sender,
    Type: tx.payload.kind,
    Nonce: tx.nonce.toString(),
    'Maximum fee (CAI base units)': tx.maxFee.toString(),
  };
  const p = tx.payload;
  if (p.kind === 'transfer') {
    summary.To = browserAddress(p.to);
    summary['Amount (CAI base units)'] = p.amount.toString();
  }
  if (p.kind === 'execute_contract') {
    summary.Contract = hex(p.contract);
    summary.Action = p.action;
    summary['Attached CAI'] = p.value.toString();
  }
  if (p.kind === 'deploy_contract') summary['Code size (bytes)'] = p.code.length;
  if ('appId' in p) summary.App = p.appId;
  if (p.kind !== 'transfer')
    summary.Payload = JSON.stringify(
      p,
      (_key, value) =>
        typeof value === 'bigint'
          ? value.toString()
          : value instanceof Uint8Array
            ? hex(value)
            : value,
      2,
    );
  return Object.entries(summary)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');
}

export class TransactionClient {
  pending = null;
  history = [];
  busy = false;

  constructor(request = (...args) => fetch(...args)) {
    this.request = request;
  }

  async get(path) {
    const response = await this.request(path, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('Could not read chain data. Please try again.');
    return response.json();
  }

  async prepareTransfer(wallet, address, amountText) {
    const to = decodeBrowserAddress(address.trim());
    const amount = units(amountText.trim());
    if (amount === 0n) throw new Error('Amount must be greater than zero.');
    return this.preparePayload(wallet, { kind: 'transfer', to, amount }, MAX_FEE);
  }

  async prepareTransaction(wallet, input, feeText) {
    if (!wallet) throw new Error('Create or load an account first.');
    if (input.length + 9 > 1_048_576) throw new Error('Transaction is too large for this gateway.');
    const text = input.trim();
    if (!/^(?:[a-f\d]{2})+$/i.test(text))
      throw new Error('Enter an unsigned payload as hexadecimal bytes.');
    const payload = decodePayload(Uint8Array.from(text.match(/../g), (b) => parseInt(b, 16)));
    const maxFee = units(feeText.trim(), 'Maximum fee');
    if (maxFee === 0n) throw new Error('Maximum fee must be greater than zero.');
    return this.preparePayload(wallet, payload, maxFee);
  }

  async preparePayload(wallet, payload, maxFee) {
    if (!wallet) throw new Error('Create or load an account first.');
    const [head, account] = await Promise.all([
      this.get('./api/head'),
      this.get(`./api/account/${wallet.address}`),
    ]);
    const spend =
      payload.kind === 'transfer'
        ? payload.amount
        : payload.kind === 'execute_contract'
          ? payload.value
          : 0n;
    if (BigInt(account.balance) < spend + maxFee)
      throw new Error('Insufficient balance for the amount and maximum fee.');
    return preparedTransaction(
      signBrowserTransaction(wallet, {
        chainId: head.chainId,
        nonce: BigInt(account.nonce),
        maxFee,
        payload,
      }),
    );
  }

  async submit(prepared) {
    if (this.busy || this.pending)
      throw new Error('A transaction is pending. Wait for its result first.');
    this.busy = true;
    try {
      const head = await this.get('./api/head');
      if (head.chainId !== prepared.tx.chainId)
        throw new Error('The network changed. Review the transaction again.');
      const account = await this.get(`./api/account/${prepared.sender}`);
      if (BigInt(account.nonce) !== prepared.tx.nonce)
        throw new Error('The account nonce changed. Review the transaction again.');
      const payload = prepared.tx.payload;
      const spend =
        payload.kind === 'transfer'
          ? payload.amount
          : payload.kind === 'execute_contract'
            ? payload.value
            : 0n;
      if (BigInt(account.balance) < spend + prepared.tx.maxFee)
        throw new Error('The balance changed. Review the transaction again.');
      this.pending = { ...prepared, status: 'submitted', createdAt: Date.now() };
      this.history.unshift(this.pending);
      this.history = this.history.slice(0, 10);
      await this.broadcast(false);
      return this.pending;
    } finally {
      this.busy = false;
    }
  }

  async broadcast(retry) {
    const pending = this.pending;
    try {
      const response = await this.request('./api/tx', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tx: pending.hex }),
        signal: AbortSignal.timeout(15000),
      });
      const result = await response.json();
      if (!response.ok) {
        if (result.rejected === true && !retry) {
          pending.status = 'rejected';
          this.pending = null;
        }
        throw new Error(result.error || 'Transaction submission failed.');
      }
      if (result.hash !== pending.hash)
        throw new Error('The node returned an unexpected transaction hash.');
      pending.status = 'submitted';
    } catch (error) {
      if (this.pending === pending) pending.status = 'unconfirmed';
      throw error;
    }
  }

  async retry() {
    if (!this.pending || this.busy) throw new Error('No transaction is ready to retry.');
    this.busy = true;
    try {
      const head = await this.get('./api/head');
      if (head.chainId !== this.pending.tx.chainId)
        throw new Error('Return to the original network before retrying.');
      await this.broadcast(true);
    } finally {
      this.busy = false;
    }
  }

  async checkPending() {
    const pending = this.pending;
    if (!pending || this.busy) return;
    const head = await this.get('./api/head');
    if (head.chainId !== pending.tx.chainId)
      throw new Error('Return to the original network to check this transaction.');
    const getReceipt = () =>
      this.request(`./api/tx/${pending.hash}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      });
    let response = await getReceipt();
    if (this.pending !== pending || this.busy) return;
    if (response.status === 404) {
      const account = await this.get(`./api/account/${pending.sender}`);
      if (this.pending !== pending || this.busy || BigInt(account.nonce) <= pending.tx.nonce)
        return;
      // The transaction may have landed between the receipt and account reads.
      response = await getReceipt();
      if (this.pending !== pending || this.busy) return;
      if (response.status === 404) {
        pending.status = 'nonce used; receipt unavailable';
        this.pending = null;
        return;
      }
    }
    if (!response.ok)
      throw new Error('Confirmation is unavailable. The transaction may still be pending.');
    const receipt = await response.json();
    if (this.pending !== pending || this.busy) return;
    if (receipt.hash !== pending.hash || typeof receipt.success !== 'boolean')
      throw new Error('Invalid transaction receipt.');
    pending.status = receipt.success ? 'confirmed' : 'failed';
    pending.fee = receipt.fee;
    pending.height = receipt.height;
    pending.error = receipt.error;
    this.pending = null;
  }
}
