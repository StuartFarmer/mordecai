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

export interface JoinOptions {
  dir: string;
  /** The network's genesis, parsed from its canonical genesis.json. */
  genesis: Genesis;
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
 * Read a hex-seed key file (the `node.key` / `peer.key` format: one line
 * of hex, plaintext — an operational key, not a user wallet).
 */
export function readKeyFile(path: string): KeyPair {
  const hex = readFileSync(path, 'utf8').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${path}: expected a 32-byte hex seed`);
  }
  return keyPairFromSeed(new Uint8Array(Buffer.from(hex, 'hex')));
}

/** Write a hex-seed key file (0600), minting a fresh seed by default. */
export function writeKeyFile(path: string, seed: Uint8Array = generateSeed()): KeyPair {
  writeFileSync(path, Buffer.from(seed).toString('hex') + '\n', { mode: 0o600 });
  return keyPairFromSeed(seed);
}

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

  const keyPair = writeKeyFile(join(options.dir, KEY_FILE));
  const address = encodeAddress(keyPair.publicKey);

  const genesis: Genesis = {
    chainId: options.chainId,
    validators: options.validators ?? [address],
    allocations: options.allocations,
  };
  writeFileSync(genesisPath, genesisToJson(genesis));
  return { dir: options.dir, genesis, keyPair, address };
}

/**
 * Create a node data dir for an *existing* chain: a fresh node key plus
 * the network's genesis, rewritten canonically. Unlike `initNodeDir` this
 * mints no genesis of its own — the caller supplies the network's, and the
 * resulting genesis hash (the swarm topic) must match the rest of the
 * network exactly or the node lands on an empty mesh of one.
 */
export function joinNodeDir(options: JoinOptions): NodeConfig {
  const genesisPath = join(options.dir, GENESIS_FILE);
  if (existsSync(genesisPath)) {
    throw new Error(`already initialized: ${genesisPath}`);
  }
  mkdirSync(options.dir, { recursive: true });

  const keyPair = writeKeyFile(join(options.dir, KEY_FILE));
  writeFileSync(genesisPath, genesisToJson(options.genesis));
  return {
    dir: options.dir,
    genesis: options.genesis,
    keyPair,
    address: encodeAddress(keyPair.publicKey),
  };
}

export function loadNodeDir(dir: string): NodeConfig {
  const genesis = parseGenesisJson(readFileSync(join(dir, GENESIS_FILE), 'utf8'));
  const keyPair = readKeyFile(join(dir, KEY_FILE));
  return { dir, genesis, keyPair, address: encodeAddress(keyPair.publicKey) };
}
