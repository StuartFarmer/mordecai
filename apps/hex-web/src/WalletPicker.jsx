import React, { useRef, useState } from 'react';
import {
  createBrowserWallet,
  loadBrowserWallet,
  exportBrowserWallet,
} from '@mordecai/wallet/browser';

export function downloadWallet(wallet) {
  const url = URL.createObjectURL(
    new Blob([exportBrowserWallet(wallet)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `mordecai-${wallet.address.slice(0, 12)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function WalletPicker({ onLoad, legacy }) {
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const selected = useRef(false);
  function choose(wallet, backedUp) {
    if (selected.current) return;
    selected.current = true;
    onLoad(wallet, backedUp);
  }
  function load(text, backedUp) {
    if (selected.current) return;
    try {
      choose(loadBrowserWallet(text), backedUp);
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <div className="app">
      <section className="lobby">
        <h1>Play Hex with your account</h1>
        {legacy && <button onClick={() => choose(legacy, true)}>Use saved Hex account</button>}
        <p>
          Load the key you created in the <a href="./account.html">Account page</a>, or create a
          temporary test account here. Hex's demo faucet supplies test funds on both chains.
        </p>
        <p className="hint">
          Keys stay in this tab. Backups are unencrypted and must be kept private.
        </p>
        <label htmlFor="hex-wallet-file">Load an account backup</label>
        <input
          id="hex-wallet-file"
          type="file"
          accept=".json,.txt"
          onChange={async (event) => {
            const file = event.target.files[0];
            if (!file) return;
            try {
              if (file.size > 4096) throw new Error('Account file is too large.');
              load(await file.text(), true);
            } catch (e) {
              setError(e.message);
            }
          }}
        />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            load(key, false);
          }}
        >
          <label htmlFor="hex-wallet-key">Or load a private key (hexadecimal)</label>
          <div className="code-form">
            <input
              id="hex-wallet-key"
              type="password"
              autoComplete="off"
              required
              maxLength={128}
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
            <button type="submit">Load account</button>
          </div>
        </form>
        <button
          onClick={() => {
            try {
              choose(createBrowserWallet(), false);
            } catch {
              setError('Secure randomness is unavailable. Use HTTPS or localhost.');
            }
          }}
        >
          Create temporary account
        </button>
        <p role="status">{error}</p>
      </section>
    </div>
  );
}
