import { readFileSync } from 'node:fs';
import { decodeAddress, encodeAddress, type Keystore } from '@mordecai/crypto';
import { encodeTransaction } from '@mordecai/protocol';
import { Wallet, transactionHash } from '@mordecai/wallet';

const AMOUNT = 10_000n;
const MAX_FEE = 1_000n;
const COOLDOWN_MS = 60_000;
const HOUR_MS = 3_600_000;

interface FaucetRpc {
  getHead(): Promise<{ chainId: string }>;
  getAccount(address: string): Promise<{ balance: string; nonce: string }>;
  submitTx(bytes: Uint8Array): Promise<string>;
}

export class FaucetError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfter = 0,
  ) {
    super(message);
  }
}

/** The CLI keeps the passphrase out of command-line arguments and public config. */
export function loadFaucetWallet(path?: string): Wallet | undefined {
  if (!path) return undefined;
  const passphrase = process.env.MORDECAI_FAUCET_PASSPHRASE;
  if (!passphrase) throw new Error('Set MORDECAI_FAUCET_PASSPHRASE to unlock the faucet keystore');
  return Wallet.fromKeystore(JSON.parse(readFileSync(path, 'utf8')) as Keystore, passphrase);
}

export class Faucet {
  private busy = false;
  private pending: { nonce: bigint; bytes: Uint8Array } | undefined;
  // shortcut: limits reset on restart; use shared durable limits before running replicas.
  private readonly addresses = new Map<string, number>();
  private readonly ips = new Map<string, number>();
  private claims: number[] = [];

  constructor(
    private readonly rpc: FaucetRpc,
    private readonly wallet: Wallet,
    private readonly amount: bigint = AMOUNT,
  ) {
    if (amount <= 0n || amount >= 1n << 64n)
      throw new Error('Faucet grant must be a positive u64 amount');
  }

  info() {
    return {
      enabled: true,
      address: this.wallet.address,
      amount: this.amount.toString(),
      cooldownSeconds: COOLDOWN_MS / 1000,
    };
  }

  async claim(address: unknown, ip: string) {
    let to: Uint8Array;
    try {
      if (typeof address !== 'string' || address.length !== 52) throw new Error();
      to = decodeAddress(address);
      if (encodeAddress(to) !== address || address === this.wallet.address) throw new Error();
    } catch {
      throw new FaucetError(
        400,
        'Enter a valid recipient wallet address other than the faucet address.',
      );
    }
    const recipient = address as string;
    const now = Date.now();
    for (const limits of [this.addresses, this.ips]) {
      for (const [key, until] of limits) if (until <= now) limits.delete(key);
    }
    const until = Math.max(this.addresses.get(recipient) ?? 0, this.ips.get(ip) ?? 0);
    if (until > now)
      throw new FaucetError(
        429,
        'Please wait before requesting more test CAI.',
        Math.ceil((until - now) / 1000),
      );
    this.claims = this.claims.filter((time) => time > now - HOUR_MS);
    if (this.claims.length >= 100)
      throw new FaucetError(
        429,
        'The faucet has reached its hourly limit.',
        Math.ceil((this.claims[0]! + HOUR_MS - now) / 1000),
      );
    if (this.busy)
      throw new FaucetError(
        503,
        'The faucet is processing another claim. Please try again shortly.',
        1,
      );

    this.busy = true;
    try {
      const account = await this.rpc.getAccount(this.wallet.address);
      const nonce = BigInt(account.nonce);
      if (this.pending) {
        if (nonce <= this.pending.nonce) {
          // Resend only the identical transfer after a lost response or delayed block.
          await this.rpc.submitTx(this.pending.bytes);
          throw new FaucetError(
            503,
            'The previous faucet transfer is awaiting confirmation. Please try again shortly.',
            1,
          );
        }
        this.pending = undefined;
      }
      if (BigInt(account.balance) < this.amount + MAX_FEE)
        throw new FaucetError(503, 'The faucet needs more funds. Please try again later.');
      const head = await this.rpc.getHead();
      const tx = this.wallet.signTransaction({
        chainId: head.chainId,
        nonce,
        maxFee: MAX_FEE,
        payload: { kind: 'transfer', to, amount: this.amount },
      });
      const bytes = encodeTransaction(tx);
      const hash = Buffer.from(transactionHash(tx)).toString('hex');
      this.pending = { nonce, bytes };
      const claimedAt = Date.now();
      this.addresses.set(recipient, claimedAt + COOLDOWN_MS);
      this.ips.set(ip, claimedAt + COOLDOWN_MS);
      this.claims.push(claimedAt);
      try {
        await this.rpc.submitTx(bytes);
      } catch {
        throw new FaucetError(
          503,
          `Submission is unconfirmed. Check transaction ${hash} before requesting again.`,
        );
      }
      return { hash, amount: this.amount.toString(), status: 'submitted' as const };
    } catch (error) {
      if (error instanceof FaucetError) throw error;
      throw new FaucetError(503, 'The faucet cannot reach the node. Please try again shortly.', 1);
    } finally {
      this.busy = false;
    }
  }
}
