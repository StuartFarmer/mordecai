import { encodeAddress } from '@mordecai/crypto';
import type { Genesis } from '@mordecai/chain';

/**
 * Fee float allocated to every app-chain validator at genesis. App-chain
 * currency is valueless by design (app-chains spec invariant 1) — this
 * only keeps the existing fee accounting satisfied.
 */
export const APP_CHAIN_ALLOCATION = 1_000_000_000_000n;

/**
 * The deterministic app-chain genesis (app-chains spec §2.5): derived
 * entirely from the registry entry, so every joiner computes the same
 * genesis hash — which is the swarm topic — with no extra coordination.
 */
export function appChainGenesis(appId: string, chainValidators: Uint8Array[]): Genesis {
  if (chainValidators.length === 0) {
    throw new Error(`app ${appId} has no chain validators — nothing to join`);
  }
  const addresses = chainValidators.map(encodeAddress);
  return {
    chainId: `app:${appId}`,
    validators: addresses,
    allocations: addresses.map((address) => ({ address, balance: APP_CHAIN_ALLOCATION })),
  };
}
