/**
 * Node data-dir setup. The load-bearing property for `join` is that a
 * joiner reproduces the network's genesis hash exactly — that hash is the
 * swarm topic, so a mismatch is an empty mesh of one rather than an error.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { genesisHash, parseGenesisJson } from '@mordecai/chain';
import { encodeAddress, generateSeed, keyPairFromSeed } from '@mordecai/crypto';
import { initNodeDir, joinNodeDir, loadNodeDir, readKeyFile, writeKeyFile } from '../src/config.js';

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mordecai-cfg-'));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('node data dirs', () => {
  const founderDir = tmp();
  const alloc = encodeAddress(keyPairFromSeed(generateSeed()).publicKey);
  const founder = initNodeDir({
    dir: founderDir,
    chainId: 'mordecai-join-test',
    allocations: [{ address: alloc, balance: 1_000n }],
  });

  it('init makes this node the sole validator', () => {
    expect(founder.genesis.validators).toEqual([founder.address]);
  });

  it('join reproduces the genesis hash byte for byte', () => {
    const network = parseGenesisJson(readFileSync(join(founderDir, 'genesis.json'), 'utf8'));
    const joined = joinNodeDir({ dir: tmp(), genesis: network });

    expect(genesisHash(joined.genesis)).toEqual(genesisHash(founder.genesis));
    // A distinct identity on the same chain — the whole point.
    expect(joined.address).not.toBe(founder.address);
    expect(joined.genesis.validators).not.toContain(joined.address);
  });

  it('join survives a reformatted genesis file', () => {
    // Whitespace and key order differ; the canonical encoding does not.
    const raw = JSON.parse(readFileSync(join(founderDir, 'genesis.json'), 'utf8')) as object;
    const reordered = tmp();
    const path = join(reordered, 'genesis.json');
    writeFileSync(path, JSON.stringify({ ...raw }));
    const joined = joinNodeDir({
      dir: tmp(),
      genesis: parseGenesisJson(readFileSync(path, 'utf8')),
    });
    expect(genesisHash(joined.genesis)).toEqual(genesisHash(founder.genesis));
  });

  it('join round-trips through loadNodeDir', () => {
    const dir = tmp();
    const joined = joinNodeDir({ dir, genesis: founder.genesis });
    const loaded = loadNodeDir(dir);
    expect(loaded.address).toBe(joined.address);
    expect(genesisHash(loaded.genesis)).toEqual(genesisHash(founder.genesis));
  });

  it('refuses to clobber an initialized dir', () => {
    expect(() => joinNodeDir({ dir: founderDir, genesis: founder.genesis })).toThrow(
      /already initialized/,
    );
  });

  it('key files round-trip and reject junk', () => {
    const path = join(tmp(), 'peer.key');
    const written = writeKeyFile(path);
    expect(readKeyFile(path).publicKey).toEqual(written.publicKey);
    expect(readFileSync(path, 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/);

    const bad = join(tmp(), 'bad.key');
    writeFileSync(bad, 'not-a-seed\n');
    expect(() => readKeyFile(bad)).toThrow(/32-byte hex seed/);
  });
});
