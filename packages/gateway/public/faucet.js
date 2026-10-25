/* global document, fetch, AbortSignal, setTimeout */
const faucetForm = document.getElementById('faucet-form');
const faucetFields = document.getElementById('faucet-fields');
const faucetAddress = document.getElementById('faucet-address');
const faucetMessage = document.getElementById('faucet-message');
const faucetTx = document.getElementById('faucet-tx');
let faucetAvailable = false;

async function loadFaucet() {
  try {
    const response = await fetch('./api/faucet', {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error();
    const info = await response.json();
    if (!info.enabled) {
      faucetMessage.textContent = 'This node has not enabled a faucet.';
      return;
    }
    if (typeof info.amount !== 'string' || !/^\d+$/.test(info.amount)) throw new Error();
    faucetMessage.textContent = `${BigInt(info.amount).toLocaleString()} test CAI per claim. One claim per minute.`;
    faucetAvailable = true;
    faucetFields.disabled = false;
  } catch {
    faucetMessage.textContent = 'The faucet is unavailable. Reload the page to try again.';
  }
}

faucetForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!faucetAvailable || faucetFields.disabled) return;
  faucetFields.disabled = true;
  faucetTx.hidden = true;
  faucetMessage.textContent = 'Requesting test CAI…';
  try {
    const response = await fetch('./api/faucet', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: faucetAddress.value.trim() }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The faucet could not process this claim.');
    if (typeof result.hash !== 'string' || !/^[a-f\d]{64}$/.test(result.hash))
      throw new Error('The faucet returned an invalid transaction receipt.');
    faucetTx.href = `./api/tx/${result.hash}`;
    faucetTx.textContent = 'View transaction';
    faucetTx.hidden = false;
    faucetMessage.textContent =
      'Transfer submitted; awaiting confirmation. Check the transaction before requesting again.';
    for (let attempt = 0; attempt < 15; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const receipt = await fetch(faucetTx.href, {
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      });
      if (receipt.status === 404) continue;
      if (!receipt.ok) break;
      const tx = await receipt.json();
      faucetMessage.textContent =
        tx.success === true
          ? 'Transfer confirmed. Your test CAI is ready to use.'
          : 'The transfer failed. Check the transaction for details.';
      break;
    }
  } catch (error) {
    faucetMessage.textContent = !faucetTx.hidden
      ? 'Transfer submitted; confirmation is unavailable. Check the transaction before requesting again.'
      : error.name === 'TimeoutError' || error.name === 'TypeError'
        ? 'The request could not be confirmed. Check your wallet before trying again.'
        : error.message;
  } finally {
    faucetFields.disabled = false;
  }
});

void loadFaucet();
