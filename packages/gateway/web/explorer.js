/* global document, window, fetch, AbortController, URLSearchParams, TextEncoder, setTimeout, clearTimeout */
import { decodeTransaction, MAX_APP_ID_BYTES } from '@mordecai/protocol';
import { browserAddress, browserTransactionHash } from '@mordecai/wallet/browser';
import { DEMOS } from './demos.js';

const MAX_U64 = (1n << 64n) - 1n;
const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const json = (value) =>
  JSON.stringify(
    value,
    (_key, item) =>
      typeof item === 'bigint' ? item.toString() : item instanceof Uint8Array ? hex(item) : item,
    2,
  );
function height(value) {
  if (!/^\d+$/.test(value) || BigInt(value) > MAX_U64)
    throw new Error('Invalid block height: enter a decimal u64 value.');
  return BigInt(value);
}
function appId(value) {
  if (!value || new TextEncoder().encode(value).length > MAX_APP_ID_BYTES)
    throw new Error(`Invalid app ID or cursor: use 1–${MAX_APP_ID_BYTES} UTF-8 bytes.`);
  return value;
}
function txHash(value) {
  if (!/^[a-f\d]{64}$/i.test(value))
    throw new Error('Invalid transaction hash: enter exactly 64 hexadecimal characters.');
  return value.toLowerCase();
}
function bytes(value) {
  if (!/^(?:[a-f\d]{2})+$/i.test(value)) throw new Error('Invalid transaction body bytes.');
  return Uint8Array.from(value.match(/../g), (byte) => parseInt(byte, 16));
}
function linkURL(route, values = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== null && value !== undefined) query.set(key, String(value));
  return `#/${route}${query.size ? `?${query}` : ''}`;
}

export function createExplorer(doc = document, win = window, fetcher = fetch) {
  const sections = {
    explorer: doc.getElementById('explorer-content'),
    apps: doc.getElementById('apps-content'),
  };
  if (!sections.explorer && !sections.apps) return { open() {}, close() {} };
  let active = null;
  let selected = null;

  function element(tag, text) {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = String(text);
    return node;
  }
  function link(parent, label, route, query) {
    const node = element('a', label);
    node.href = linkURL(route, query);
    parent.append(node);
    return node;
  }
  function fields(parent, values) {
    const list = element('dl');
    for (const [name, value] of Object.entries(values))
      if (value !== undefined) list.append(element('dt', name), element('dd', value));
    parent.append(list);
  }
  function table(parent, names) {
    const node = element('table');
    node.setAttribute('tabindex', '0');
    const header = element('thead');
    const row = element('tr');
    for (const name of names) row.append(element('th', name));
    header.append(row);
    const body = element('tbody');
    node.append(header, body);
    parent.append(node);
    return body;
  }
  function row(parent, values) {
    const node = element('tr');
    for (const value of values) {
      const cell = element('td');
      if (typeof value === 'object') cell.append(value);
      else cell.textContent = String(value);
      node.append(cell);
    }
    parent.append(node);
  }
  function current(view) {
    return active === view && !view.controller.signal.aborted;
  }
  function close() {
    selected = null;
    if (active) {
      clearTimeout(active.timer);
      active.controller.abort();
      active = null;
    }
  }
  function error(view, message, target = view.status) {
    if (!current(view)) return;
    const status = element('p', message);
    status.setAttribute('role', 'alert');
    const retry = element('button', 'Retry');
    retry.type = 'button';
    retry.addEventListener('click', () => open(view.route));
    target.replaceChildren(status, retry);
  }
  async function get(view, url) {
    if (!current(view)) throw new Error('Read cancelled.');
    const controller = new AbortController();
    let timer;
    let cancel;
    const stopped = new Promise((_resolve, reject) => {
      cancel = () => {
        controller.abort();
        reject(new Error('Read cancelled.'));
      };
      view.controller.signal.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Chain data request timed out. Please retry.'));
      }, 10000);
    });
    try {
      return await Promise.race([
        stopped,
        (async () => {
          const response = await fetcher(url, { cache: 'no-store', signal: controller.signal });
          const result = await response.json();
          if (!response.ok)
            throw new Error(result.error || 'Chain data unavailable. Please retry.');
          return result;
        })(),
      ]);
    } finally {
      clearTimeout(timer);
      view.controller.signal.removeEventListener('abort', cancel);
    }
  }
  function lookup(view) {
    const form = element('form');
    const kindLabel = element('label', 'Lookup type ');
    const kind = element('select');
    kind.name = 'lookup-type';
    for (const [value, label] of [
      ['height', 'Block height'],
      ['tx', 'Transaction hash'],
    ]) {
      const option = element('option', label);
      option.value = value;
      kind.append(option);
    }
    kind.value = 'height';
    kindLabel.append(kind);
    const valueLabel = element('label', ' Height or hash ');
    const input = element('input');
    input.name = 'lookup';
    input.type = 'text';
    input.required = true;
    valueLabel.append(input);
    const button = element('button', 'Look up');
    button.type = 'submit';
    const message = element('p');
    message.setAttribute('role', 'alert');
    form.append(kindLabel, valueLabel, button, message);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      try {
        const value = input.value.trim();
        const query = { app: view.app };
        if (kind.value === 'height') query.height = height(value).toString();
        else if (kind.value === 'tx') query.tx = txHash(value);
        else throw new Error('Choose a lookup type.');
        win.location.hash = linkURL('explorer', query);
      } catch (failure) {
        message.textContent = failure.message;
      }
    });
    view.root.append(form);
  }
  function checkBlock(view, block, expectedHeight) {
    if (block.header.height !== String(expectedHeight))
      throw new Error('Block height does not match the request.');
    if (view.app && block.header.chainId !== `app:${view.app}`)
      throw new Error('App chain ID does not match the request.');
    return block;
  }
  function transaction(view, parent, tx, receipt) {
    const units = view.app ? 'app-chain base units' : 'CAI base units';
    fields(parent, {
      Type: tx.payload.kind,
      Sender: browserAddress(tx.sender),
      Network: tx.chainId,
      Nonce: tx.nonce.toString(),
      [`Maximum fee (${units})`]: tx.maxFee.toString(),
    });
    const payload = tx.payload;
    if (payload.kind === 'transfer')
      fields(parent, {
        To: browserAddress(payload.to),
        [`Amount (${units})`]: payload.amount.toString(),
      });
    if (payload.kind === 'execute_contract')
      fields(parent, { [`Attached value (${units})`]: payload.value.toString() });
    if (payload.appId && !view.app)
      link(parent, `App: ${payload.appId}`, 'apps', { app: payload.appId });
    if (payload.kind === 'anchor')
      parent.append(
        element(
          'p',
          receipt.success
            ? `Anchor accepted by ${view.app ? `app chain: ${view.app}` : 'settlement'}. The app quorum attests this claim; it is not independent execution verification.`
            : `Anchor was not accepted: the ${view.app ? 'app-chain' : 'settlement'} transaction failed.`,
        ),
      );
    parent.append(element('h3', 'Payload (raw bytes as hex)'), element('pre', json(payload)));
  }
  async function transactionPage(view, requestedHash) {
    const receipt = await get(view, chainURL(view, `tx/${requestedHash}`));
    if (!current(view)) return;
    if (receipt.hash !== requestedHash || typeof receipt.success !== 'boolean')
      throw new Error('Transaction receipt hash does not match the request.');
    const at = height(receipt.height).toString();
    if (!Number.isSafeInteger(receipt.index) || receipt.index < 0)
      throw new Error('Invalid receipt transaction index.');
    view.content.replaceChildren(element('h3', 'Transaction and receipt'));
    fields(view.content, {
      Hash: requestedHash,
      Height: at,
      Index: receipt.index,
      Result: receipt.success ? 'Success' : 'Failed',
      [`Actual fee (${view.app ? 'app-chain base units' : 'CAI base units'})`]: receipt.fee,
      Error: receipt.error,
      'Events (hex)': json(receipt.events),
      'Return data (hex)': receipt.returnData,
    });
    link(view.content, `Block ${at}`, 'explorer', { app: view.app, height: at });
    let body;
    try {
      body = await get(view, chainURL(view, `block/${at}`));
    } catch (failure) {
      throw new Error(
        `Transaction body unavailable. Receipt remains visible; payload and hash could not be checked. ${failure.message}`,
      );
    }
    if (!current(view)) return;
    checkBlock(view, body, at);
    if (receipt.index >= body.txs.length)
      throw new Error('Receipt transaction index does not match the block.');
    const decoded = decodeTransaction(bytes(body.txs[receipt.index]));
    if (browserTransactionHash(decoded) !== requestedHash)
      throw new Error('Decoded transaction hash does not match the requested hash.');
    if (decoded.chainId !== body.header.chainId)
      throw new Error('Transaction chain ID does not match its block.');
    transaction(view, view.content, decoded, receipt);
  }
  async function blockPage(view, at) {
    const body = checkBlock(view, await get(view, chainURL(view, `block/${at}`)), at);
    if (!current(view)) return;
    view.content.replaceChildren(element('h3', `Block ${at}`));
    fields(view.content, {
      Hash: body.hash,
      Network: body.header.chainId,
      'Timestamp (milliseconds)': body.header.timestampMs,
      Proposer: body.header.proposer,
      'Previous hash': body.header.prevHash,
      'State root': body.header.stateRoot,
      'Transaction root': body.header.txsRoot,
      Transactions: body.txs.length,
    });
    const bodyRows = table(view.content, ['Hash', 'Kind', 'Sender']);
    for (const encoded of body.txs) {
      const decoded = decodeTransaction(bytes(encoded));
      if (decoded.chainId !== body.header.chainId)
        throw new Error('Transaction chain ID does not match its block.');
      const txLink = element('a', browserTransactionHash(decoded));
      txLink.href = linkURL('explorer', { app: view.app, tx: browserTransactionHash(decoded) });
      row(bodyRows, [txLink, decoded.payload.kind, browserAddress(decoded.sender)]);
    }
    link(view.content, 'Latest blocks', 'explorer', { app: view.app });
  }
  async function recentPage(view) {
    const head = await get(view, chainURL(view, 'head'));
    if (!current(view)) return;
    if (view.app && head.chainId !== `app:${view.app}`)
      throw new Error('App chain ID does not match the request.');
    const top = height(head.height);
    if (view.chainId !== head.chainId) view.summaries.clear();
    const chainChanged = view.chainId !== head.chainId;
    view.chainId = head.chainId;
    const end =
      view.before === null
        ? top
        : view.before === 0n
          ? -1n
          : top < view.before
            ? top
            : view.before - 1n;
    const heights = [];
    for (let at = end; at >= 0n && heights.length < 10; at--) heights.push(at.toString());
    for (const at of view.summaries.keys()) if (!heights.includes(at)) view.summaries.delete(at);
    const missing = heights.filter((at) => !view.summaries.has(at));
    let next = 0;
    const reads = await Promise.allSettled(
      [0, 1].map(async () => {
        while (next < missing.length && current(view)) {
          const at = missing[next++];
          const block = checkBlock(view, await get(view, chainURL(view, `block/${at}`)), at);
          if (!current(view)) return;
          if (block.header.chainId !== head.chainId)
            throw new Error('Block chain ID does not match the head.');
          view.summaries.set(at, {
            height: at,
            hash: block.hash,
            timestamp: block.header.timestampMs,
            count: block.txs.length,
          });
        }
      }),
    );
    const failed = reads.find((read) => read.status === 'rejected');
    if (failed) throw failed.reason;
    if (!current(view)) return;
    if (view.head !== head.height || chainChanged || !view.rendered) {
      view.content.replaceChildren(
        element('h3', view.before === null ? 'Recent blocks' : 'Older blocks'),
      );
      fields(view.content, {
        Network: head.chainId,
        'Latest height': head.height,
        'Head hash': head.headHash,
      });
      const rows = table(view.content, [
        'Height',
        'Timestamp (milliseconds)',
        'Transactions',
        'Hash',
      ]);
      for (const at of heights) {
        const summary = view.summaries.get(at);
        const blockLink = element('a', at);
        blockLink.href = linkURL('explorer', { app: view.app, height: at });
        row(rows, [blockLink, summary.timestamp, summary.count, summary.hash]);
      }
      if (heights.length && heights.at(-1) !== '0')
        link(view.content, 'Older blocks', 'explorer', { app: view.app, before: heights.at(-1) });
      if (view.before !== null) link(view.content, 'Latest blocks', 'explorer', { app: view.app });
      view.head = head.height;
      view.rendered = true;
    }
  }
  function appURL(id, suffix = '') {
    // Whole dot path segments are removed by URL parsers, including encoded dots.
    return id === '.' || id === '..'
      ? `./api/app${suffix}?${new URLSearchParams({ appId: id })}`
      : `./api/app/${encodeURIComponent(id)}${suffix}`;
  }
  function chainURL(view, suffix) {
    return view.app ? appURL(view.app, `/chain/${suffix}`) : `./api/${suffix}`;
  }
  async function appsPage(view) {
    const query = new URLSearchParams({ limit: String(view.limit) });
    if (view.after !== null) query.set('after', view.after);
    const [data, config] = await Promise.all([
      get(view, view.app ? appURL(view.app) : `./api/apps?${query}`),
      get(view, './api/config').catch(() => ({})),
    ]);
    if (!current(view)) return;
    const label = (id) => {
      const name = Object.keys(DEMOS).find((key) => config.demos?.[key]?.appId === id);
      return name ? DEMOS[name].title : id;
    };
    view.content.replaceChildren();
    if (!view.app) {
      const rows = table(view.content, ['App', 'Registered ID', 'Owner', 'Version', 'App chain']);
      for (const entry of data.apps) {
        const appLink = element('a', label(entry.appId));
        appLink.href = linkURL('apps', { app: entry.appId });
        row(rows, [
          appLink,
          entry.appId,
          entry.owner,
          entry.version,
          entry.chainValidators.length
            ? `${entry.chainValidators.length} validators`
            : 'No app chain',
        ]);
      }
      if (data.nextAfter !== null)
        link(view.content, 'Next apps', 'apps', { after: data.nextAfter, limit: view.limit });
      if (view.after !== null) link(view.content, 'First apps', 'apps');
      return;
    }
    view.content.append(element('h3', label(data.appId)));
    fields(view.content, {
      'Registered ID': data.appId,
      Owner: data.owner,
      Version: data.version,
      'App chain': data.chainValidators.length
        ? `${data.chainValidators.length} validators`
        : 'No app chain',
    });
    const details = element('details');
    details.append(element('summary', 'Registration details'));
    fields(details, {
      Contract: data.contractAddress,
      'Bundle key': data.pearKey,
      'Validator keys': data.chainValidators.join('\n'),
      'Metadata hash': data.metadataHash,
    });
    view.content.append(details);
    if (data.anchor)
      fields(view.content, {
        'Last anchored height': data.anchor.appHeight,
        Epoch: data.anchor.epoch,
        'Anchored state root': data.anchor.stateRoot,
      });
    else view.content.append(element('p', 'No anchor yet'));
    link(view.content, 'Registered apps', 'apps');
    if (!data.chainValidators.length) return;
    link(view.content, 'Explore app chain', 'explorer', { app: view.app });
    const status = element('div');
    view.content.append(status);
    try {
      const head = await get(view, chainURL(view, 'head'));
      if (!current(view)) return;
      if (head.chainId !== `app:${view.app}`)
        throw new Error('App chain ID does not match the request.');
      fields(status, { 'Live app height': head.height, 'Live state root': head.stateRoot });
    } catch (failure) {
      error(view, failure.message, status);
    }
    if (current(view))
      view.content.append(
        element(
          'p',
          'App history depends on available peers. Unavailable data does not invalidate a settlement anchor.',
        ),
      );
  }
  async function run(view) {
    try {
      if (view.route === 'apps') await appsPage(view);
      else if (view.tx !== null) await transactionPage(view, view.tx);
      else if (view.height !== null) await blockPage(view, view.height);
      else await recentPage(view);
      if (current(view)) view.status.replaceChildren();
    } catch (failure) {
      error(view, failure.message);
    } finally {
      if (
        current(view) &&
        !doc.hidden &&
        view.route === 'explorer' &&
        view.tx === null &&
        view.height === null &&
        view.before === null
      ) {
        clearTimeout(view.timer);
        view.timer = setTimeout(() => run(view), 5000);
      }
    }
  }
  function open(route) {
    close();
    if (!Object.hasOwn(sections, route) || !sections[route]) return;
    selected = route;
    if (doc.hidden) return;
    const root = sections[route];
    root.replaceChildren(element('h2', route === 'apps' ? 'Registered apps' : 'Explorer'));
    const view = {
      route,
      root,
      controller: new AbortController(),
      timer: null,
      content: element('div'),
      status: element('div'),
      summaries: new Map(),
      app: null,
      before: null,
      height: null,
      tx: null,
      after: null,
      limit: 50,
    };
    active = view;
    try {
      const query = new URLSearchParams((win.location.hash || '').split('?').slice(1).join('?'));
      for (const key of ['app', 'height', 'tx', 'before', 'after', 'limit'])
        if (query.getAll(key).length > 1) throw new Error(`Choose only one ${key} selector.`);
      if (query.has('app')) view.app = appId(query.get('app'));
      if (route === 'explorer') {
        if (['height', 'tx', 'before'].filter((key) => query.has(key)).length > 1)
          throw new Error('Choose only one of height, transaction hash or before.');
        if (query.has('height')) view.height = height(query.get('height')).toString();
        if (query.has('before')) view.before = height(query.get('before'));
        if (query.has('tx')) view.tx = txHash(query.get('tx'));
        root.append(element('p', view.app ? `App chain: ${view.app}` : 'Settlement (L0)'));
        lookup(view);
      } else {
        if (query.has('after')) view.after = appId(query.get('after'));
        if (view.app && view.after !== null) throw new Error('Choose an app or a registry cursor.');
        if (query.has('limit')) {
          if (
            !/^\d+$/.test(query.get('limit')) ||
            Number(query.get('limit')) < 1 ||
            Number(query.get('limit')) > 100
          )
            throw new Error('Invalid registry page limit: choose 1–100.');
          view.limit = Number(query.get('limit'));
        }
      }
      root.append(view.content, view.status);
      view.status.append(element('p', 'Loading…'));
      run(view);
    } catch (failure) {
      root.append(view.content, view.status);
      error(view, failure.message);
    }
  }
  doc.addEventListener('visibilitychange', () => {
    const route = selected;
    if (!route) return;
    if (doc.hidden) {
      close();
      selected = route;
    } else open(route);
  });
  return { open, close };
}
