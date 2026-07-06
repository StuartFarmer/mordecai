import type { Payload, Transaction } from '@hssn/protocol';
import type { SignParams, Signer, Wallet } from '@hssn/wallet';

/**
 * Per-app wallet permissions (threat model: applications are trusted only
 * by the user running them; they request signatures, never keys, and
 * "auto-authenticate" must never mean "auto-sign").
 */
export interface SessionGrant {
  appId: string;
  /** May the app prove the user's identity (sign auth challenges)? */
  auth: boolean;
  /** Total native-currency spend (amounts + value + fees) allowed without asking. */
  spendLimit: bigint;
}

export interface ApprovalRequest {
  appId: string;
  payload: Payload;
  /** Worst-case cost of this transaction (amount/value + maxFee). */
  cost: bigint;
  /** Spend allowance still available in this session. */
  remaining: bigint;
}

/** The Pear shell's approval hook — in a real app this is the wallet UI prompt. */
export type ApprovalPrompt = (request: ApprovalRequest) => Promise<boolean> | boolean;

export class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermissionDeniedError';
  }
}

function costOf(params: SignParams): bigint {
  const payload = params.payload;
  const moved =
    payload.kind === 'transfer'
      ? payload.amount
      : payload.kind === 'execute_contract'
        ? payload.value
        : 0n;
  return moved + params.maxFee;
}

/**
 * A Signer the app can hold. The Wallet (and its keys) stay on the shell
 * side of the boundary; the session enforces the grant and burns down the
 * spend allowance, escalating to the approval prompt beyond it.
 */
export class WalletSession implements Signer {
  private remaining: bigint;

  constructor(
    private readonly wallet: Wallet,
    private readonly grant: SessionGrant,
    private readonly approve: ApprovalPrompt = () => false,
  ) {
    this.remaining = grant.spendLimit;
  }

  get address(): string {
    return this.wallet.address;
  }

  get publicKey(): Uint8Array {
    return this.wallet.publicKey;
  }

  get remainingAllowance(): bigint {
    return this.remaining;
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    if (!this.grant.auth) {
      throw new PermissionDeniedError(`${this.grant.appId} has no auth permission`);
    }
    return this.wallet.signMessage(message);
  }

  async signTransaction(params: SignParams): Promise<Transaction> {
    const cost = costOf(params);
    if (cost > this.remaining) {
      const approved = await this.approve({
        appId: this.grant.appId,
        payload: params.payload,
        cost,
        remaining: this.remaining,
      });
      if (!approved) {
        throw new PermissionDeniedError(
          `${this.grant.appId}: spend of ${cost} exceeds the session allowance ` +
            `(${this.remaining} left) and was not approved`,
        );
      }
    } else {
      this.remaining -= cost;
    }
    return this.wallet.signTransaction(params);
  }
}
