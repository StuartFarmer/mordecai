/* global document, fetch, AbortSignal, setTimeout */
const status = document.getElementById('status');
const chainId = document.getElementById('chain-id');
const height = document.getElementById('height');
const headHash = document.getElementById('head-hash');
const lastChecked = document.getElementById('last-checked');

async function refresh() {
  try {
    const response = await fetch('/api/head', {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Chain data unavailable');
    const head = await response.json();
    if (
      typeof head.chainId !== 'string' ||
      !head.chainId ||
      typeof head.height !== 'string' ||
      !/^\d+$/.test(head.height) ||
      typeof head.headHash !== 'string' ||
      !/^[a-f\d]{64}$/i.test(head.headHash)
    )
      throw new Error('Invalid chain data');

    chainId.textContent = head.chainId;
    height.textContent = BigInt(head.height).toLocaleString();
    headHash.textContent = head.headHash;
    status.textContent = 'Online';
    status.dataset.state = 'reachable';
    lastChecked.textContent = `Last checked ${new Date().toLocaleTimeString()}. Updates every second.`;
  } catch {
    status.textContent = 'Offline';
    status.dataset.state = 'unavailable';
    chainId.textContent = height.textContent = headHash.textContent = '—';
    lastChecked.textContent = 'Could not fetch chain data. Retrying in 1 second.';
  } finally {
    setTimeout(refresh, 1000);
  }
}

void refresh();
