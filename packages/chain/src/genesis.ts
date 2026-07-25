import { blake2b256, decodeAddress } from '@mordecai/crypto';
import {
  MAX_CHAIN_ID_BYTES,
  PROTOCOL_VERSION,
  PUBKEY_SIZE,
  SIGNATURE_SIZE,
  Writer,
  type Block,
  type BlockHeader,
} from '@mordecai/protocol';
import { EMPTY_ROOT, computeStateRootWith, type Change, type StateStore } from '@mordecai/state';
import { accountKey, encodeAccount } from './account.js';

export interface GenesisAllocation {
  /** z32 wallet address. */
  address: string;
  balance: bigint;
}

export interface Genesis {
  chainId: string;
  /** z32 addresses of the fixed validator set (M4); single sequencer in M3. */
  validators: string[];
  allocations: GenesisAllocation[];
}

const MAX_GENESIS_ENTRIES = 10_000;

/** Canonical encoding of the genesis config; its hash anchors the chain. */
export function encodeGenesis(genesis: Genesis): Uint8Array {
  const w = new Writer();
  w.string(genesis.chainId, MAX_CHAIN_ID_BYTES);
  w.array(genesis.validators, MAX_GENESIS_ENTRIES, (wr, address) => {
    wr.fixed(decodeAddress(address), PUBKEY_SIZE);
  });
  w.array(genesis.allocations, MAX_GENESIS_ENTRIES, (wr, alloc) => {
    wr.fixed(decodeAddress(alloc.address), PUBKEY_SIZE);
    wr.u64(alloc.balance);
  });
  return w.finish();
}

export function genesisHash(genesis: Genesis): Uint8Array {
  return blake2b256(encodeGenesis(genesis));
}

/** State changes that seed the initial allocations. */
export function genesisChanges(genesis: Genesis): Change[] {
  const seen = new Set<string>();
  const changes: Change[] = [];
  for (const alloc of genesis.allocations) {
    if (seen.has(alloc.address)) {
      throw new Error(`duplicate genesis allocation for ${alloc.address}`);
    }
    seen.add(alloc.address);
    changes.push([
      accountKey(decodeAddress(alloc.address)),
      encodeAccount({ balance: alloc.balance, nonce: 0n }),
    ]);
  }
  return changes;
}

/**
 * The height-0 block. Its prevHash is the genesis config hash, tying every
 * later block to the exact initial conditions. Proposer and signature are
 * zero — height 0 is not signed, it is agreed out of band.
 */
export async function buildGenesisBlock(genesis: Genesis, store: StateStore): Promise<Block> {
  const header: BlockHeader = {
    version: PROTOCOL_VERSION,
    chainId: genesis.chainId,
    height: 0n,
    prevHash: genesisHash(genesis),
    timestampMs: 0n,
    proposer: new Uint8Array(PUBKEY_SIZE),
    txsRoot: EMPTY_ROOT.slice(),
    stateRoot: await computeStateRootWith(store, genesisChanges(genesis)),
  };
  return { header, txs: [], proposerSignature: new Uint8Array(SIGNATURE_SIZE) };
}

/** Parse a genesis.json document (balances as decimal strings). */
export function parseGenesisJson(json: string): Genesis {
  const raw = JSON.parse(json) as {
    chainId?: string;
    validators?: string[];
    allocations?: Record<string, string>;
  };
  if (!raw.chainId) throw new Error('genesis: missing chainId');
  return {
    chainId: raw.chainId,
    validators: raw.validators ?? [],
    allocations: Object.entries(raw.allocations ?? {}).map(([address, balance]) => ({
      address,
      balance: BigInt(balance),
    })),
  };
}

export function genesisToJson(genesis: Genesis): string {
  return (
    JSON.stringify(
      {
        chainId: genesis.chainId,
        validators: genesis.validators,
        allocations: Object.fromEntries(
          genesis.allocations.map((a) => [a.address, a.balance.toString()]),
        ),
      },
      null,
      2,
    ) + '\n'
  );
}
