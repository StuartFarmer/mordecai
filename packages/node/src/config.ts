import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeAddress, generateSeed, keyPairFromSeed, type KeyPair } from '@mordecai/crypto';
import { genesisToJson, parseGenesisJson, type Genesis } from '@mordecai/chain';

export interface InitOptions {
  dir: string;
  chainId: string;
  allocations: { address: string; balance: bigint }[];
  /** Defaults to just this node's own address. */
  validators?: string[];
}

export interface NodeConfig {
  dir: string;
  genesis: Genesis;
  keyPair: KeyPair;
  address: string;
}

const GENESIS_FILE = 'genesis.json';
const KEY_FILE = 'node.key';

/**
 * Create a node data dir: a fresh node key (hex seed, plaintext — an
 * operational validator key, not a user wallet) plus genesis.json.
 */
export function initNodeDir(options: InitOptions): NodeConfig {
  const genesisPath = join(options.dir, GENESIS_FILE);
  if (existsSync(genesisPath)) {
    throw new Error(`already initialized: ${genesisPath}`);
  }
  mkdirSync(options.dir, { recursive: true });

  const seed = generateSeed();
  const keyPair = keyPairFromSeed(seed);
  const address = encodeAddress(keyPair.publicKey);
  writeFileSync(join(options.dir, KEY_FILE), Buffer.from(seed).toString('hex') + '\n', {
    mode: 0o600,
  });

  const genesis: Genesis = {
    chainId: options.chainId,
    validators: options.validators ?? [address],
    allocations: options.allocations,
  };
  writeFileSync(genesisPath, genesisToJson(genesis));
  return { dir: options.dir, genesis, keyPair, address };
}

export function loadNodeDir(dir: string): NodeConfig {
  const genesis = parseGenesisJson(readFileSync(join(dir, GENESIS_FILE), 'utf8'));
  const seed = new Uint8Array(Buffer.from(readFileSync(join(dir, KEY_FILE), 'utf8').trim(), 'hex'));
  const keyPair = keyPairFromSeed(seed);
  return { dir, genesis, keyPair, address: encodeAddress(keyPair.publicKey) };
}
