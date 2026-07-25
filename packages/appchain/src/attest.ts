import { sign, verify, type KeyPair } from '@mordecai/crypto';
import {
  anchorSigningBytes,
  type AnchorCall,
  type AnchorPayload,
  type AnchorSignature,
} from '@mordecai/protocol';
import type { Chain } from '@mordecai/chain';

/** The attested fields of an anchor plus the L1 it is destined for. */
export interface Attestation {
  l1ChainId: string;
  appId: string;
  epoch: bigint;
  appHeight: bigint;
  stateRoot: Uint8Array;
  call?: AnchorCall;
}

export function attestationBody(
  attestation: Attestation,
): Omit<AnchorPayload, 'kind' | 'signatures'> {
  const { l1ChainId: _l1, ...body } = attestation;
  return body;
}

/** Attest the app chain's current head. */
export function buildAttestation(
  chain: Chain,
  params: { l1ChainId: string; appId: string; epoch: bigint; call?: AnchorCall },
): Attestation {
  return {
    l1ChainId: params.l1ChainId,
    appId: params.appId,
    epoch: params.epoch,
    appHeight: chain.height,
    stateRoot: chain.headHeader.stateRoot,
    ...(params.call ? { call: params.call } : {}),
  };
}

export function signAttestation(attestation: Attestation, keyPair: KeyPair): AnchorSignature {
  const message = anchorSigningBytes(attestation.l1ChainId, attestationBody(attestation));
  return { validator: keyPair.publicKey, signature: sign(message, keyPair.secretKey) };
}

export function verifyAttestationSignature(
  attestation: Attestation,
  signature: AnchorSignature,
): boolean {
  const message = anchorSigningBytes(attestation.l1ChainId, attestationBody(attestation));
  return verify(signature.signature, message, signature.validator);
}

/**
 * A validator only attests what its own chain agrees with: the block at
 * `appHeight` must exist locally and carry the claimed state root.
 */
export async function localChainMatches(chain: Chain, attestation: Attestation): Promise<boolean> {
  if (attestation.appHeight > chain.height) return false;
  const block = await chain.getBlock(attestation.appHeight);
  if (!block) return false;
  return Buffer.compare(block.header.stateRoot, attestation.stateRoot) === 0;
}

// ------------------------------------------------- JSON transport codec

interface AttestationWire {
  l1ChainId: string;
  appId: string;
  epoch: string;
  appHeight: string;
  stateRoot: string;
  call?: { contract: string; action: string; args: string };
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const fromHex = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));

export function encodeAttestation(attestation: Attestation): string {
  const wire: AttestationWire = {
    l1ChainId: attestation.l1ChainId,
    appId: attestation.appId,
    epoch: attestation.epoch.toString(),
    appHeight: attestation.appHeight.toString(),
    stateRoot: hex(attestation.stateRoot),
    ...(attestation.call
      ? {
          call: {
            contract: hex(attestation.call.contract),
            action: attestation.call.action,
            args: hex(attestation.call.args),
          },
        }
      : {}),
  };
  return JSON.stringify(wire);
}

export function decodeAttestation(json: string): Attestation {
  const wire = JSON.parse(json) as AttestationWire;
  return {
    l1ChainId: wire.l1ChainId,
    appId: wire.appId,
    epoch: BigInt(wire.epoch),
    appHeight: BigInt(wire.appHeight),
    stateRoot: fromHex(wire.stateRoot),
    ...(wire.call
      ? {
          call: {
            contract: fromHex(wire.call.contract),
            action: wire.call.action,
            args: fromHex(wire.call.args),
          },
        }
      : {}),
  };
}
