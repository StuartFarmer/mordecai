/* global document, window, fetch, AbortSignal, Blob, URL, setTimeout, navigator */
import {
  createBrowserWallet,
  loadBrowserWallet,
  exportBrowserWallet,
} from '@mordecai/wallet/browser';
import { signChessMessage } from '@mordecai/wallet/chess';
import { signMicroblogPost, signMicroblogTip, signMicroblogHide } from '@mordecai/wallet/microblog';
import { initNavigation } from './navigation.js';
import { createDemoSession } from './demo-session.js';
import { DEMOS, createDemoLoader } from './demos.js';
import { TransactionClient, transactionSummary } from './transactions.js';

const byId = (id) => document.getElementById(id);
const message = byId('wallet-message');
const account = byId('wallet-account');
const keyInput = byId('wallet-key');
let wallet = null;
let backedUp = false;
const transactions = new TransactionClient();
let prepared = null;
let working = false;
let tipDraft = null;
const demoClients = new Map();
const clients = () => [transactions, ...demoClients.values()];
const pendingClient = () => clients().find((client) => client.pending);
const demoSession = createDemoSession(() => wallet, sendDemoTransaction, signDemoChessMessage, {
  signMicroblogPost: (current, input) => signDemoMicroblog(current, input, signMicroblogPost),
  signMicroblogHide: (current, input) => signDemoMicroblog(current, input, signMicroblogHide),
  signMicroblogTip: signDemoMicroblogTip,
  prepareMicroblogTip,
  submitMicroblogTip,
  cancelMicroblogTip,
});
const openDemo = createDemoLoader(document, window, demoSession);

function showWallet(next, saved = false) {
  wallet = next;
  backedUp = saved;
  byId('wallet-start').hidden = true;
  account.hidden = false;
  byId('wallet-address').textContent = wallet.address;
  byId('wallet-private').value = JSON.parse(exportBrowserWallet(wallet)).privateKey;
  byId('wallet-private').type = 'password';
  byId('wallet-reveal').textContent = 'Show private key';
  byId('faucet-address').value = wallet.address;
  keyInput.value = '';
  message.textContent = saved
    ? 'Wallet loaded. Keys stay in this tab.'
    : 'Download your private key before closing or reloading this tab.';
  byId('wallet-balance').textContent = 'Checking…';
  byId('tx-message').textContent = pendingClient()
    ? 'A transaction is still pending. Keep this tab open until it is confirmed.'
    : 'Review the details before sending.';
  clearReview();
  demoSession.refresh();
  void refreshBalance();
}

byId('wallet-generate').addEventListener('click', () => {
  if (working || wallet) return;
  try {
    showWallet(createBrowserWallet());
  } catch {
    message.textContent =
      'Key generation requires a browser with secure randomness. Use HTTPS or localhost.';
  }
});

byId('wallet-load').addEventListener('submit', (event) => {
  event.preventDefault();
  if (working || wallet) return;
  try {
    showWallet(loadBrowserWallet(keyInput.value));
  } catch (error) {
    message.textContent = error.message;
  }
});

byId('wallet-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 4096) throw new Error('Wallet file is too large.');
    const text = await file.text();
    if (wallet || working) return;
    showWallet(loadBrowserWallet(text), true);
  } catch (error) {
    message.textContent = error.message;
  } finally {
    event.target.value = '';
  }
});

byId('wallet-download').addEventListener('click', () => {
  if (!wallet) return;
  const url = URL.createObjectURL(
    new Blob([exportBrowserWallet(wallet)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `mordecai-${wallet.address.slice(0, 12)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  backedUp = true;
  message.textContent =
    'Keep the downloaded file private. It contains your unencrypted private key.';
});

byId('wallet-reveal').addEventListener('click', () => {
  const field = byId('wallet-private');
  field.type = field.type === 'password' ? 'text' : 'password';
  byId('wallet-reveal').textContent =
    field.type === 'password' ? 'Show private key' : 'Hide private key';
});

byId('wallet-copy').addEventListener('click', async () => {
  if (!wallet) return;
  try {
    await navigator.clipboard.writeText(wallet.address);
    message.textContent = 'Wallet address copied.';
  } catch {
    message.textContent = 'Select and copy the address above.';
  }
});

byId('wallet-close').addEventListener('click', () => {
  if (working) return;
  if (
    !backedUp &&
    !window.confirm('This key has not been downloaded. Close the wallet and discard it?')
  )
    return;
  wallet?.seed.fill(0);
  wallet = null;
  tipDraft = null;
  backedUp = false;
  byId('wallet-private').value = '';
  byId('wallet-address').textContent = '';
  byId('faucet-address').value = '';
  account.hidden = true;
  byId('wallet-start').hidden = false;
  message.textContent = 'Wallet closed. Load your backup to use it again.';
  byId('transfer-form').reset();
  byId('transaction-form').reset();
  clearReview();
  demoSession.refresh();
  byId('wallet-generate').focus();
});

window.addEventListener('beforeunload', (event) => {
  if ((wallet && !backedUp) || pendingClient() || working) {
    event.preventDefault();
    event.returnValue = '';
  }
});

function updateControls() {
  const locked = working || !!pendingClient() || !!tipDraft;
  byId('wallet-actions').hidden = !wallet;
  byId('wallet-notice').hidden = !wallet;
  byId('transfer-fields').disabled = locked || !wallet;
  byId('transaction-fields').disabled = locked || !wallet;
  byId('tx-send').disabled = locked;
  byId('tx-cancel').disabled = working;
  byId('wallet-close').disabled = working;
  byId('wallet-generate').disabled = working;
  byId('wallet-file').disabled = working;
  byId('wallet-load').querySelector('button').disabled = working;
  byId('tx-retry').hidden = !pendingClient();
  byId('tx-retry').disabled = working;
}

function clearReview() {
  prepared = null;
  byId('tx-review').hidden = true;
  byId('tx-summary').textContent = '';
  updateControls();
}

function renderHistory() {
  const history = clients()
    .flatMap((client) => client.history)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 10);
  byId('tx-history').hidden = history.length === 0;
  byId('tx-list').replaceChildren(
    ...history.map((tx) => {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = `${tx.apiBase || '.'}/api/tx/${tx.hash}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = tx.hash;
      item.append(
        `${tx.status}${tx.fee !== undefined ? ` · fee ${tx.fee} CAI base units` : ''}${tx.error ? ` · ${tx.error}` : ''} — `,
        link,
      );
      return item;
    }),
  );
  updateControls();
}

async function review(make) {
  if (!wallet || working || pendingClient() || tipDraft) return;
  working = true;
  clearReview();
  byId('tx-message').textContent = 'Preparing transaction…';
  try {
    prepared = await make();
    byId('tx-summary').textContent = `${transactionSummary(prepared)}\nHash: ${prepared.hash}`;
    byId('tx-review').hidden = false;
    byId('tx-review-title').focus();
    byId('tx-message').textContent = 'Check these details, then confirm to broadcast.';
  } catch (error) {
    byId('tx-message').textContent = error.message;
  } finally {
    working = false;
    updateControls();
  }
}

byId('transfer-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!wallet) return;
  void review(() =>
    transactions.prepareTransfer(wallet, byId('transfer-to').value, byId('transfer-amount').value),
  );
});
byId('transaction-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void review(() =>
    transactions.prepareTransaction(
      wallet,
      byId('transaction-payload').value,
      byId('transaction-fee').value,
    ),
  );
});
for (const id of ['transfer-to', 'transfer-amount', 'transaction-payload', 'transaction-fee']) {
  byId(id).addEventListener('input', clearReview);
}
byId('tx-cancel').addEventListener('click', () => {
  clearReview();
  byId('tx-message').textContent = 'Transaction cancelled. Nothing was sent.';
});

async function send(retry = false) {
  if (working || tipDraft || (!retry && !prepared)) return;
  working = true;
  updateControls();
  byId('tx-message').textContent = 'Submitting transaction…';
  try {
    if (retry) await pendingClient()?.retry();
    else await transactions.submit(prepared);
    byId('tx-message').textContent = 'Submitted. Waiting for confirmation; keep this tab open.';
  } catch (error) {
    byId('tx-message').textContent = pendingClient()
      ? `${error.message} Confirmation is uncertain. Keep this tab open; retry sends the same transaction.`
      : error.message;
  } finally {
    working = false;
    clearReview();
    renderHistory();
  }
}
byId('tx-send').addEventListener('click', () => void send());
byId('tx-retry').addEventListener('click', () => void send(true));

async function refreshBalance() {
  const current = wallet;
  if (!current) return;
  try {
    const [head, balance] = await Promise.all([
      fetch('./api/head', { cache: 'no-store', signal: AbortSignal.timeout(5000) }),
      fetch(`./api/account/${current.address}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      }),
    ]);
    if (!head.ok || !balance.ok) throw new Error();
    const [network, info] = await Promise.all([head.json(), balance.json()]);
    if (wallet !== current) return;
    byId('wallet-network').textContent = network.chainId;
    byId('wallet-balance').textContent = `${BigInt(info.balance).toLocaleString()} CAI`;
  } catch {
    if (wallet === current) byId('wallet-balance').textContent = 'Unavailable';
  }
}

async function sendDemoTransaction(expectedWallet, base, chainId, payload, maxFee) {
  if (wallet !== expectedWallet) throw new Error('Wallet changed.');
  if (working || pendingClient() || tipDraft)
    throw new Error('Another transaction is pending. Check Wallet before sending again.');
  if (base !== '' && !Object.values(DEMOS).some((demo) => demo.network === base))
    throw new Error('Unsupported demo network.');
  let client = transactions;
  if (base) {
    if (!demoClients.has(base))
      demoClients.set(
        base,
        new TransactionClient((path, init) => fetch(`${base}${path.slice(1)}`, init)),
      );
    client = demoClients.get(base);
  }
  working = true;
  clearReview();
  try {
    const draft = await client.preparePayload(expectedWallet, payload, maxFee);
    if (draft.tx.chainId !== chainId) throw new Error('The demo network does not match this node.');
    draft.apiBase = base;
    return await confirmDemoTransaction(client, draft);
  } finally {
    working = false;
    renderHistory();
    void refreshBalance();
  }
}

async function confirmDemoTransaction(client, draft) {
  await client.submit(draft);
  for (let i = 0; i < 60 && client.pending; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await client.checkPending();
  }
  const result = client.history[0];
  if (result.status !== 'confirmed')
    throw new Error(result.error || `Transaction ${result.status}. Check Wallet before retrying.`);
  return { success: true, hash: result.hash, height: Number(result.height), fee: result.fee };
}

async function microblogConfig(expectedWallet) {
  if (wallet !== expectedWallet) throw new Error('Wallet changed.');
  const response = await fetch('./api/config', {
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Microblog configuration is unavailable.');
  const config = (await response.json()).demos?.microblog;
  if (!config) throw new Error('Microblog is unavailable on this node.');
  if (wallet !== expectedWallet) throw new Error('Wallet changed.');
  return config;
}

async function signDemoMicroblog(expectedWallet, input, sign) {
  const config = await microblogConfig(expectedWallet);
  if (input.chainId !== config.chainId || input.feedId !== config.feedId)
    throw new Error('The Microblog message does not match this node.');
  return sign(expectedWallet, input);
}

async function signDemoMicroblogTip(expectedWallet, input) {
  const message = { ...input };
  if (
    !tipDraft ||
    tipDraft.wallet !== expectedWallet ||
    tipDraft.public.hash !== message.transactionHash
  )
    throw new Error('Review a tip before signing its attribution.');
  const reservation = tipDraft;
  const signed = await signDemoMicroblog(expectedWallet, message, signMicroblogTip);
  if (tipDraft !== reservation) throw new Error('The tip review was cancelled.');
  return signed;
}

async function prepareMicroblogTip(expectedWallet, recipient, amountText) {
  if (wallet !== expectedWallet) throw new Error('Wallet changed.');
  if (working || pendingClient() || tipDraft)
    throw new Error(
      'Another transaction or tip review is pending. Check Wallet or cancel the tip.',
    );
  if (recipient.trim() === expectedWallet.address) throw new Error('Choose another author to tip.');
  working = true;
  clearReview();
  try {
    const config = await microblogConfig(expectedWallet);
    const draft = await transactions.prepareTransfer(expectedWallet, recipient, amountText);
    if (draft.tx.chainId !== config.chainId)
      throw new Error('The demo network does not match this node.');
    const publicDraft = Object.freeze({
      hash: draft.hash,
      hex: draft.hex,
      chainId: draft.tx.chainId,
      recipient: recipient.trim(),
      amount: draft.tx.payload.amount.toString(),
      maxFee: draft.tx.maxFee.toString(),
    });
    tipDraft = { wallet: expectedWallet, draft, public: publicDraft };
    byId('tx-message').textContent =
      'A tip is awaiting review. Open Demos → Microblog to send or cancel it.';
    return publicDraft;
  } finally {
    working = false;
    updateControls();
  }
}

function cancelMicroblogTip(expectedWallet, preparedTip) {
  if (tipDraft?.wallet === expectedWallet && tipDraft.public === preparedTip && !working) {
    tipDraft = null;
    byId('tx-message').textContent = 'Tip review cancelled. Nothing was sent.';
    updateControls();
  }
}

async function submitMicroblogTip(expectedWallet, preparedTip) {
  if (
    wallet !== expectedWallet ||
    !tipDraft ||
    tipDraft.wallet !== expectedWallet ||
    tipDraft.public !== preparedTip
  )
    throw new Error('This tip review expired. Review the tip again.');
  if (working || pendingClient()) throw new Error('Another transaction is pending. Check Wallet.');
  const { draft } = tipDraft;
  tipDraft = null;
  working = true;
  updateControls();
  try {
    return await confirmDemoTransaction(transactions, draft);
  } finally {
    working = false;
    renderHistory();
    void refreshBalance();
  }
}

async function signDemoChessMessage(expectedWallet, input) {
  if (wallet !== expectedWallet) throw new Error('Wallet changed.');
  const response = await fetch('./api/config', {
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Chess configuration is unavailable.');
  const config = (await response.json()).demos?.chess;
  if (!config || input.chainId !== config.chainId || input.contract !== config.contract)
    throw new Error('The Chess message does not match this node.');
  if (wallet !== expectedWallet) throw new Error('Wallet changed.');
  return signChessMessage(expectedWallet, input);
}

async function poll() {
  await refreshBalance();
  if (!working) {
    for (const client of clients()) {
      if (!client.pending) continue;
      try {
        await client.checkPending();
        if (!working && !client.pending) {
          const latest = client.history[0];
          byId('tx-message').textContent =
            `Transaction ${latest.status}.${latest.error ? ` ${latest.error}` : ''}`;
        }
      } catch {
        if (!working)
          byId('tx-message').textContent =
            'Confirmation is unavailable. Keep this tab open; the transaction may still be pending.';
      }
      renderHistory();
    }
  }
  setTimeout(poll, 1000);
}
updateControls();
initNavigation(document, window, (route) => void openDemo(route));
void poll();
