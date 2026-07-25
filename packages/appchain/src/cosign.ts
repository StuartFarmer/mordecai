import RPC from '@hyperswarm/rpc';
import type { KeyPair } from '@hssn/crypto';
import type { AnchorSignature } from '@hssn/protocol';
import type { NodeRpcServer } from '@hssn/rpc';
import type { Chain } from '@hssn/chain';
import {
  decodeAttestation,
  encodeAttestation,
  localChainMatches,
  signAttestation,
  type Attestation,
} from './attest.js';

/**
 * Anchor co-signing (app-chains spec §3.3). Registered on the validator's
 * existing node RPC endpoint — the node's identity *is* the validator
 * keypair, and the registry publishes those keys, so peers dial each
 * other with no extra discovery. `anchor_sign` refuses anything the
 * local chain does not agree with, so a malicious proposer cannot
 * harvest signatures for a state the quorum never reached.
 */
export function registerCosigner(
  server: NodeRpcServer,
  deps: {
    chain: Chain;
    keyPair: KeyPair;
    appId: string;
    /** How long to wait for the local chain to catch up to an attested height. */
    catchUpMs?: number;
  },
): void {
  server.respondRaw('anchor_sign', async (raw: Buffer) => {
    const attestation = decodeAttestation(raw.toString('utf8'));
    const error = await vet(deps, attestation);
    if (error) return Buffer.from(JSON.stringify({ ok: false, error }));
    const signature = signAttestation(attestation, deps.keyPair);
    return Buffer.from(
      JSON.stringify({
        ok: true,
        validator: Buffer.from(signature.validator).toString('hex'),
        signature: Buffer.from(signature.signature).toString('hex'),
      }),
    );
  });
}

async function vet(
  deps: { chain: Chain; appId: string; catchUpMs?: number },
  attestation: Attestation,
): Promise<string | null> {
  if (attestation.appId !== deps.appId) {
    return `attestation is for ${attestation.appId}, this cosigner serves ${deps.appId}`;
  }
  const deadline = Date.now() + (deps.catchUpMs ?? 5_000);
  for (;;) {
    if (await localChainMatches(deps.chain, attestation)) return null;
    if (attestation.appHeight <= deps.chain.height) {
      return 'attested state root does not match this validator’s chain';
    }
    if (Date.now() > deadline) return 'attested height is ahead of this validator’s chain';
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Ask a co-validator (dialed by its validator public key) to sign. */
export async function requestCosignature(
  validatorKey: Uint8Array,
  attestation: Attestation,
  options: { bootstrap?: { host: string; port: number }[] } = {},
): Promise<AnchorSignature> {
  const rpc = new RPC(options.bootstrap ? { bootstrap: options.bootstrap } : {});
  try {
    const client = rpc.connect(validatorKey);
    const raw = await client.request('anchor_sign', Buffer.from(encodeAttestation(attestation)));
    const response = JSON.parse(raw.toString('utf8')) as
      { ok: true; validator: string; signature: string } | { ok: false; error: string };
    if (!response.ok) throw new Error(`cosigner refused: ${response.error}`);
    return {
      validator: new Uint8Array(Buffer.from(response.validator, 'hex')),
      signature: new Uint8Array(Buffer.from(response.signature, 'hex')),
    };
  } finally {
    await rpc.destroy();
  }
}
