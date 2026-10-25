/**
 * The mordecai app CLI against a live L1 + app chain. The app chain is
 * registered with two validators — the CLI's key and an in-process one —
 * so a quorum needs both. A transaction submitted through the spawned
 * process's own RPC and committed therefore proves it really joined
 * consensus, rather than merely having started.
 *
 * Runs the built dist/cli.js, so it skips until `pnpm build` has run.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import createTestnet from 'hyperdht/testnet';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeAddress, generateSeed, keyPairFromSeed, sign, type KeyPair } from '@mordecai/crypto';
import { encodeTransaction, transactionSigningBytes } from '@mordecai/protocol';
import { Node } from '@mordecai/node';
import { NodeRpcClient } from '@mordecai/rpc';
import { AppChain } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const appCli = join(here, '..', 'dist', 'cli.js');
const cli = join(here, '..', '..', '..', 'bin', 'mordecai.mjs');
const nodeCli = join(here, '..', '..', 'node', 'dist', 'cli.js');
const enabled = existsSync(appCli) && existsSync(nodeCli);

const L1_CHAIN = 'mordecai-cli-test';
const APP = 'com.example.cli';

const owner: KeyPair = keyPairFromSeed(generateSeed());
const l1Validator: KeyPair = keyPairFromSeed(generateSeed());
const other: KeyPair = keyPairFromSeed(generateSeed());

let testnet: Awaited<ReturnType<typeof createTestnet>>;
let l1: Node;
let l1Rpc: NodeRpcClient;
let inProcess: AppChain;
let child: ChildProcessWithoutNullStreams | undefined;
const dirs: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function bootstrapArg(): string {
  return testnet.bootstrap.map((b) => `${b.host}:${b.port}`).join(',');
}

/** Run a CLI to completion, returning stdout (rejects on non-zero exit). */
function runCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [cli, ...args], { stdio: 'pipe' });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d: Buffer) => (out += d.toString()));
    proc.stderr.on('data', (d: Buffer) => (err += d.toString()));
    proc.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`)),
    );
  });
}

/** Spawn a long-running CLI, resolving once `marker` appears on stdout. */
function spawnUntil(
  args: string[],
  marker: string,
  timeoutMs = 60_000,
): Promise<{ proc: ChildProcessWithoutNullStreams; output: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [cli, ...args], { stdio: 'pipe' });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`timed out waiting for "${marker}"\nstdout:\n${out}\nstderr:\n${err}`));
    }, timeoutMs);
    proc.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      if (out.includes(marker)) {
        clearTimeout(timer);
        resolve({ proc, output: out });
      }
    });
    proc.stderr.on('data', (d: Buffer) => (err += d.toString()));
    proc.on('close', (code) => {
      clearTimeout(timer);
      reject(new Error(`exited early (${code})\nstdout:\n${out}\nstderr:\n${err}`));
    });
  });
}

describe.skipIf(!enabled)('mordecai app CLI', () => {
  let peerDir: string;
  let peerPublicKey: string;

  it('dispatches settlement initialization and help, and rejects unknown command groups', async () => {
    expect(await runCli(['--help'])).toContain('mordecai l1');
    expect(await runCli(['app', '--help'])).toContain('mordecai app init');
    expect(await runCli(['l1', '--help'])).toContain('mordecai l1 init');
    await expect(runCli(['unknown'])).rejects.toThrow(/unknown command group/i);
    const dir = tmp('mordecai-unified-l1-');
    const result = JSON.parse(
      await runCli(['l1', 'init', '--dir', dir, '--chain-id', 'unified-cli']),
    ) as { address: string };
    const genesis = JSON.parse(readFileSync(join(dir, 'genesis.json'), 'utf8'));
    expect(genesis.chainId).toBe('unified-cli');
    expect(genesis.validators).toEqual([result.address]);
  });

  beforeAll(async () => {
    testnet = await createTestnet(3);

    // The CLI mints its own key; its public key is what the registry entry
    // must carry, so init has to happen before register_app.
    peerDir = tmp('mordecai-cli-peer-');
    const init = JSON.parse(await runCli(['app', 'init', '--dir', peerDir])) as {
      publicKey: string;
    };
    peerPublicKey = init.publicKey;

    l1 = await Node.start({
      dir: tmp('mordecai-cli-l1-'),
      genesis: {
        chainId: L1_CHAIN,
        validators: [encodeAddress(l1Validator.publicKey)],
        allocations: [{ address: encodeAddress(owner.publicKey), balance: 10_000_000n }],
      },
      keyPair: l1Validator,
      blockIntervalMs: 100,
      bootstrap: testnet.bootstrap,
    });
    l1Rpc = NodeRpcClient.connect(l1.rpcPublicKey, { bootstrap: testnet.bootstrap });

    const unsigned = {
      chainId: L1_CHAIN,
      nonce: 0n,
      sender: owner.publicKey,
      maxFee: 500_000n,
      payload: {
        kind: 'register_app' as const,
        appId: APP,
        pearKey: new Uint8Array(32).fill(1),
        version: '1.0.0',
        contractAddress: new Uint8Array(32),
        metadataHash: new Uint8Array(32).fill(2),
        chainValidators: [new Uint8Array(Buffer.from(peerPublicKey, 'hex')), other.publicKey],
      },
    };
    const hash = await l1Rpc.submitTx(
      encodeTransaction({
        ...unsigned,
        signature: sign(transactionSigningBytes(unsigned), owner.secretKey),
      }),
    );
    const info = await l1Rpc.waitForTx(hash, { timeoutMs: 30_000 });
    if (!info.success) throw new Error(`register_app failed: ${info.error}`);

    // The second validator, in-process: quorum is 2 of 2.
    inProcess = await AppChain.start({
      appId: APP,
      chainValidators: [new Uint8Array(Buffer.from(peerPublicKey, 'hex')), other.publicKey],
      dir: tmp('mordecai-cli-other-'),
      keyPair: other,
      bootstrap: testnet.bootstrap,
      blockIntervalMs: 300,
    });
  }, 120_000);

  afterAll(async () => {
    child?.kill('SIGKILL');
    await inProcess?.stop();
    await l1Rpc?.close();
    await l1?.stop();
    await testnet?.destroy();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it('init writes a reusable peer.key and refuses to replace it', async () => {
    const seed = readFileSync(join(peerDir, 'peer.key'), 'utf8').trim();
    expect(seed).toMatch(/^[0-9a-f]{64}$/);
    // The printed public key must be the one derived from that seed —
    // it's what the operator pastes into the registered validator set.
    const derived = keyPairFromSeed(new Uint8Array(Buffer.from(seed, 'hex')));
    expect(Buffer.from(derived.publicKey).toString('hex')).toBe(peerPublicKey);
    await expect(runCli(['app', 'init', '--dir', peerDir])).rejects.toThrow(
      /refusing to overwrite/,
    );
    expect(readFileSync(join(peerDir, 'peer.key'), 'utf8').trim()).toBe(seed);
  });

  it('start joins the app chain from the registry and reaches consensus', async () => {
    const started = await spawnUntil(
      [
        'app',
        'start',
        '--dir',
        peerDir,
        '--app',
        APP,
        '--settlement-node',
        Buffer.from(l1.rpcPublicKey).toString('hex'),
        '--bootstrap',
        bootstrapArg(),
        '--block-interval',
        '300',
      ],
      'peer running',
    );
    child = started.proc;

    // Genesis came from the registry entry, not from any local config.
    expect(started.output).toContain(`app:${APP}`);
    expect(started.output).toContain('role:     validator');

    const rpcKey = /rpc key:\s+([0-9a-f]{64})/.exec(started.output)?.[1];
    expect(rpcKey).toBeDefined();

    await inProcess.waitForPeers(1);

    // Submit through the CLI peer's own RPC. Nothing here produces empty
    // blocks, so a committed tx is the real proof: the spawned process
    // served the RPC and voted, and quorum is 2 of 2.
    const peerRpc = NodeRpcClient.connect(new Uint8Array(Buffer.from(rpcKey!, 'hex')), {
      bootstrap: testnet.bootstrap,
    });
    try {
      const chainId = `app:${APP}`;
      const unsigned = {
        chainId,
        nonce: 0n,
        sender: other.publicKey,
        maxFee: 500_000n,
        payload: { kind: 'transfer' as const, to: new Uint8Array(32).fill(7), amount: 1_000n },
      };
      const hash = await peerRpc.submitTx(
        encodeTransaction({
          ...unsigned,
          signature: sign(transactionSigningBytes(unsigned), other.secretKey),
        }),
      );
      const info = await peerRpc.waitForTx(hash, { timeoutMs: 60_000 });
      expect(info.success).toBe(true);
      expect(inProcess.chain.height).toBeGreaterThan(0n);
    } finally {
      await peerRpc.close();
    }
  }, 120_000);

  it('connect creates an ordinary peer and starts its HTTP gateway without init', async () => {
    const dir = tmp('mordecai-cli-connect-');
    const started = await spawnUntil(
      [
        'app',
        'connect',
        '--dir',
        dir,
        '--app',
        APP,
        '--l1-node',
        Buffer.from(l1.rpcPublicKey).toString('hex'),
        '--bootstrap',
        bootstrapArg(),
      ],
      'peer running',
    );
    try {
      expect(started.output).toContain('role:     peer');
      expect(readFileSync(join(dir, 'peer.key'), 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/);
      const url = /http:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(started.output)![1];
      await expect
        .poll(
          async () => {
            const response = await fetch(`${url}/api/head`);
            return ((await response.json()) as { height: string }).height;
          },
          { timeout: 15_000 },
        )
        .toBe('1');
    } finally {
      const stopped = new Promise<void>((resolve) => started.proc.once('exit', () => resolve()));
      started.proc.kill('SIGTERM');
      await stopped;
    }
  }, 60_000);

  it('explains that named lookup needs settlement or a direct peer URL', async () => {
    await expect(
      runCli(['app', 'connect', '--dir', tmp('mordecai-no-settlement-'), '--app', APP]),
    ).rejects.toThrow(/settlement.*peer URL/i);
  });

  it('joins an unregistered app by URL and then by the new peer IP without settlement', async () => {
    const validatorDir = tmp('mordecai-direct-validator-');
    const identity = JSON.parse(await runCli(['app', 'init', '--dir', validatorDir])) as {
      publicKey: string;
    };
    const standalone = await AppChain.start({
      appId: 'com.example.standalone',
      chainValidators: [other.publicKey, new Uint8Array(Buffer.from(identity.publicKey, 'hex'))],
      dir: tmp('mordecai-standalone-'),
      keyPair: other,
      bootstrap: testnet.bootstrap,
      gateway: { config: { secret: 'must not appear in connection metadata' } },
    });
    const spawned: ChildProcessWithoutNullStreams[] = [];
    try {
      let target = `http://127.0.0.1:${standalone.node.gateway.port}`;
      for (let i = 0; i < 2; i++) {
        const started = await spawnUntil(
          [
            'app',
            'connect',
            '--dir',
            i === 0 ? validatorDir : tmp('mordecai-direct-'),
            '--app',
            target,
          ],
          'peer running',
        );
        spawned.push(started.proc);
        expect(started.output).toContain(`role:     ${i === 0 ? 'validator' : 'peer'}`);
        const url = /http:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(started.output)![1]!;
        const config = await (await fetch(`${url}/api/connect`)).json();
        expect(config).toMatchObject({
          version: 1,
          appId: 'com.example.standalone',
          bootstrap: testnet.bootstrap,
        });
        expect(config.settlement).toBeUndefined();
        expect(config.secret).toBeUndefined();
        if (i === 0) {
          await standalone.waitForPeers(1);
          const unsigned = {
            chainId: 'app:com.example.standalone',
            nonce: 0n,
            sender: other.publicKey,
            maxFee: 500_000n,
            payload: { kind: 'transfer' as const, to: owner.publicKey, amount: 123n },
          };
          const tx = {
            ...unsigned,
            signature: sign(transactionSigningBytes(unsigned), other.secretKey),
          };
          const response = await fetch(`${url}/api/tx`, {
            method: 'POST',
            body: JSON.stringify({ tx: Buffer.from(encodeTransaction(tx)).toString('hex') }),
          });
          expect(response.ok).toBe(true);
        }
        await expect
          .poll(
            async () => {
              const response = await fetch(`${url}/api/account/${encodeAddress(owner.publicKey)}`);
              return ((await response.json()) as { balance: string }).balance;
            },
            { timeout: 15_000 },
          )
          .toBe('123');
        target = url.replace('http://', '');
      }
      await standalone.waitForPeers(2);
      expect(await standalone.chain.getCertificate(1n)).toHaveLength(2);
    } finally {
      for (const proc of spawned) {
        const stopped = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
        proc.kill('SIGTERM');
        await stopped;
      }
      await standalone.stop();
    }
  }, 60_000);
});
