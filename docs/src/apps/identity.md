# Wallets, Identity & Sessions

## One key, everywhere

An identity is an Ed25519 keypair. Because Hypercore uses the same scheme,
one key serves as: the wallet (signs transactions), the feed owner (signs
shared state), and the login (signs app challenges). The address is the
z32-encoded public key.

`@mordecai/wallet` manages keys:

- `Wallet.create()` → wallet + a 24-word BIP39 mnemonic (the only backup —
  shown once, never stored).
- Keystore files encrypt the seed with argon2id + XChaCha20-Poly1305; the
  address is stored in the clear so tools can display it without the
  passphrase.
- `mordecai-wallet` CLI: `create`, `address`, `transfer` (see
  [CLI Tools](../reference/cli.md)).

## The Signer boundary

Applications never hold keys. They program against the `Signer` interface:

```ts
interface Signer {
  address: string;
  publicKey: Uint8Array;
  signTransaction(params): Transaction | Promise<Transaction>;
  signMessage(message): Uint8Array | Promise<Uint8Array>;
}
```

A local `Wallet` implements it directly (fine for tools and tests). Real
apps get a **`RemoteSigner`** instead — a proxy whose keys live in another
process.

## The wallet daemon (`@mordecai/pear-integration`)

The threat model's rule is _auto-authenticate must never mean auto-sign_,
and it is enforced by a process boundary:

```text
┌────────────── app process ──────────────┐   ┌────────── wallet daemon ─────────┐
│ Mordecai.connect({ wallet: remoteSigner })  │──▶│ WalletDaemon                      │
│ RemoteSigner (no key material)          │IPC│  · unlocked Wallet (the keys)     │
└─────────────────────────────────────────┘   │  · per-app SessionGrant           │
                                              │  · allowance meter                │
                                              │  · ApprovalPrompt hook (UI seam)  │
                                              └───────────────────────────────────┘
```

```ts
// shell / daemon side
const daemon = await WalletDaemon.start({
  wallet,
  grants: { 'com.example.chess': { auth: true, spendLimit: 1_000_000n } },
  approve: async (req) => showPromptToUser(req),  // the future Pear wallet UI
});

// app side
const signer = await RemoteSigner.connect(daemon.publicKey, 'com.example.chess');
const app = Mordecai.connect({ wallet: signer, ... });
```

Enforcement is entirely daemon-side:

- **`auth` grant** gates challenge signing — an app without it cannot even
  prove the user's identity.
- **`spendLimit`** is a session allowance; every transaction's worst case
  (`amount + attached value + maxFee`) burns it down.
- **Overages escalate** to the `ApprovalPrompt` with the app id, a payload
  summary, the cost, and the remaining allowance. Deny is the default.
- Unknown app ids are refused at `hello`.

The transport is `@hyperswarm/rpc`, so the daemon can be local IPC today
and a phone-as-signer tomorrow without app changes.
