import { encodeAddress, sign, type KeyPair } from '@mordecai/crypto';
import {
  encodeTransaction,
  transactionSigningBytes,
  type AnchorCall,
  type AnchorSignature,
} from '@mordecai/protocol';
import { NodeRpcClient, type TxInfo } from '@mordecai/rpc';
import { anchorQuorum, type Chain } from '@mordecai/chain';
import { buildAttestation, signAttestation, type Attestation } from './attest.js';
import { requestCosignature } from './cosign.js';

export interface AnchorDaemonOptions {
  /** The app chain being anchored. */
  chain: Chain;
  appId: string;
  /** The registered validator set; co-signatures are collected from it. */
  validators: Uint8Array[];
  /** This validator's key (must be in the set). */
  keyPair: KeyPair;
  /** L1 connection. */
  l1: {
    chainId: string;
    nodeKey: Uint8Array;
    bootstrap?: { host: string; port: number }[];
  };
  /** Funded L1 account that pays anchor fees. Untrusted by the protocol. */
  relayer: KeyPair;
  /**
   * Decides the outcome call for each anchor by reading app-chain state
   * (app-chains spec §3.3); return null to anchor the root alone.
   */
  outcome?: (chain: Chain) => AnchorCall | null | Promise<AnchorCall | null>;
  /** Anchor automatically every interval; omit for manual anchorNow(). */
  epochIntervalMs?: number;
  maxFee?: bigint;
  log?: (message: string) => void;
}

/**
 * Builds, quorum-signs, and relays anchors (app-chains spec §3.3). Runs
 * on any validator; the co-signing endpoint on each peer refuses state
 * its own chain doesn't agree with, so the daemon can't overreach.
 */
export class AnchorDaemon {
  private readonly rpc: NodeRpcClient;
  private timer: NodeJS.Timeout | undefined;
  private lastAnchoredHeight = -1n;

  constructor(private readonly options: AnchorDaemonOptions) {
    this.rpc = NodeRpcClient.connect(
      options.l1.nodeKey,
      options.l1.bootstrap ? { bootstrap: options.l1.bootstrap } : {},
    );
    if (options.epochIntervalMs !== undefined) {
      this.timer = setInterval(() => {
        this.anchorNow().catch((err) =>
          options.log?.(`anchor failed: ${err instanceof Error ? err.message : err}`),
        );
      }, options.epochIntervalMs);
    }
  }

  /** Anchor the current app-chain head to L1; resolves with the L1 receipt. */
  async anchorNow(): Promise<TxInfo | null> {
    const { chain, appId, l1, relayer, log } = this.options;

    if (chain.height === this.lastAnchoredHeight) {
      log?.('anchor skipped: no new blocks');
      return null;
    }

    // Next epoch comes from L1, so concurrent daemons converge.
    const last = await this.rpc.getAppAnchor(appId);
    const epoch = last ? BigInt(last.epoch) + 1n : 1n;

    const call = (await this.options.outcome?.(chain)) ?? undefined;
    const attestation = buildAttestation(chain, {
      l1ChainId: l1.chainId,
      appId,
      epoch,
      ...(call ? { call } : {}),
    });

    const signatures = await this.collectSignatures(attestation);

    const { l1ChainId: _l1, ...body } = attestation;
    const account = await this.rpc.getAccount(encodeAddress(relayer.publicKey));
    const unsigned = {
      chainId: l1.chainId,
      nonce: BigInt(account.nonce),
      sender: relayer.publicKey,
      maxFee: this.options.maxFee ?? 500_000n,
      payload: { kind: 'anchor' as const, ...body, signatures },
    };
    const tx = {
      ...unsigned,
      signature: sign(transactionSigningBytes(unsigned), relayer.secretKey),
    };
    const hash = await this.rpc.submitTx(encodeTransaction(tx));
    const info = await this.rpc.waitForTx(hash, { timeoutMs: 30_000 });
    if (!info.success) throw new Error(`anchor rejected by L1: ${info.error}`);

    this.lastAnchoredHeight = attestation.appHeight;
    log?.(`anchored epoch ${epoch} (app height ${attestation.appHeight})`);
    return info;
  }

  /** Self-sign, then gather co-signatures until the quorum is met. */
  private async collectSignatures(attestation: Attestation): Promise<AnchorSignature[]> {
    const { validators, keyPair, l1, log } = this.options;
    const signatures: AnchorSignature[] = [signAttestation(attestation, keyPair)];
    const needed = anchorQuorum(validators.length);

    for (const validator of validators) {
      if (signatures.length >= needed) break;
      if (Buffer.compare(validator, keyPair.publicKey) === 0) continue;
      try {
        signatures.push(
          await requestCosignature(validator, attestation, {
            ...(l1.bootstrap ? { bootstrap: l1.bootstrap } : {}),
          }),
        );
      } catch (err) {
        log?.(
          `cosigner ${Buffer.from(validator).toString('hex').slice(0, 12)}… unavailable: ` +
            `${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (signatures.length < needed) {
      throw new Error(`could not reach quorum: ${signatures.length} of ${needed} signatures`);
    }
    return signatures;
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.rpc.close();
  }
}
