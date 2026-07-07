#!/usr/bin/env node
import { fork } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import createTestnet from '../../packages/networking/node_modules/hyperdht/testnet.js';
import {
  encodeAddress,
  generateSeed,
  keyPairFromSeed,
  sign,
} from '../../packages/crypto/dist/index.js';
import { transactionSigningBytes, encodeTransaction } from '../../packages/protocol/dist/index.js';
import { NodeRpcClient } from '../../packages/rpc/dist/index.js';

const DEFAULTS = {
  runs: 1,
  nodes: 10,
  txs: 1_000_000,
  perSender: 100,
  mempoolWindow: 64,
  maxTxsPerBlock: 10_000,
  minTxsPerBlock: 10_000,
  maxProposalWaitMs: 4_000,
  blockIntervalMs: 100,
  roundTimeoutMs: 15_000,
  rpcConcurrency: 1024,
  bootstrapNodes: 3,
  meshMinPeers: undefined,
  meshTimeoutMs: 60_000,
  finalityTimeoutMs: 180 * 60_000,
  submitMode: 'rpc',
  submitReplication: 1,
  submitOrder: 'nonce-major',
  submitRouting: 'proposer',
  txRepair: false,
  windowConvergence: true,
  ipcGossip: false,
  indexTransactions: false,
  stateBackend: 'memory',
  signatureWorkers: 3,
};

function usage() {
  return `Usage: node apps/devnet/bench-10-node-cluster.mjs [options]

Options:
  --runs <n>                Number of full benchmark runs (default ${DEFAULTS.runs})
  --nodes <n>               Validator count (default ${DEFAULTS.nodes})
  --txs <n>                 Transactions per run (default ${DEFAULTS.txs})
  --per-sender <n>          Target transactions per funded sender (default ${DEFAULTS.perSender})
  --mempool-window <n>      Pending nonce rounds submitted per sender (default ${DEFAULTS.mempoolWindow})
  --max-txs-per-block <n>   Consensus block transaction cap (default ${DEFAULTS.maxTxsPerBlock})
  --min-txs-per-block <n>   Prefer waiting for this many txs before proposing (default ${DEFAULTS.minTxsPerBlock})
  --max-proposal-wait-ms <n> Maximum wait for fuller block before partial proposal (default ${DEFAULTS.maxProposalWaitMs})
  --block-interval-ms <n>   Consensus tick interval (default ${DEFAULTS.blockIntervalMs})
  --round-timeout-ms <n>    Round proposer timeout (default ${DEFAULTS.roundTimeoutMs})
  --rpc-concurrency <n>     Concurrent RPC submit_tx calls (default ${DEFAULTS.rpcConcurrency})
  --bootstrap-nodes <n>     Local HyperDHT bootstrap nodes (default ${DEFAULTS.bootstrapNodes})
  --mesh-min-peers <n>      Direct peers required per validator (default nodes - 1)
  --mesh-timeout-ms <n>     Mesh wait timeout (default ${DEFAULTS.meshTimeoutMs})
  --submit-mode <rpc|ipc>   Submit through public RPC or worker IPC (default ${DEFAULTS.submitMode})
  --submit-replication <n>  Best-effort extra ingress replicas per tx (default ${DEFAULTS.submitReplication})
  --submit-order <sender-major|nonce-major>
                            Submission order within each nonce window (default ${DEFAULTS.submitOrder})
  --submit-routing <proposer|sender>
                            Ingress target selection (default ${DEFAULTS.submitRouting})
  --tx-repair               Enable experimental missing-nonce repair gossip
  --no-window-convergence   Do not wait for all validators between nonce windows
  --ipc-gossip              Gossip IPC-submitted txs to peers (default off)
  --index-transactions      Persist per-transaction lookup records during benchmark
  --state-backend <memory|level>
                            State storage backend for validators (default ${DEFAULTS.stateBackend})
  --signature-workers <n>   Worker threads per validator for proposal signature checks (default ${DEFAULTS.signatureWorkers})
  --report-dir <path>       Report directory (default benchmark-results/cluster-<timestamp>)
  --keep-data               Keep temporary chain data after the run
  --help                    Show this help
`;
}

function readArgs(argv) {
  const options = { ...DEFAULTS, keepData: false, reportDir: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const nextNumber = () => {
      const raw = argv[++i];
      if (!raw) throw new Error(`${arg} requires a value`);
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${arg} must be positive`);
      return value;
    };
    switch (arg) {
      case '--runs':
        options.runs = nextNumber();
        break;
      case '--nodes':
        options.nodes = nextNumber();
        break;
      case '--txs':
        options.txs = nextNumber();
        break;
      case '--per-sender':
        options.perSender = nextNumber();
        break;
      case '--mempool-window':
        options.mempoolWindow = nextNumber();
        break;
      case '--max-txs-per-block':
        options.maxTxsPerBlock = nextNumber();
        break;
      case '--min-txs-per-block':
        options.minTxsPerBlock = nextNumber();
        break;
      case '--max-proposal-wait-ms':
        options.maxProposalWaitMs = nextNumber();
        break;
      case '--block-interval-ms':
        options.blockIntervalMs = nextNumber();
        break;
      case '--round-timeout-ms':
        options.roundTimeoutMs = nextNumber();
        break;
      case '--rpc-concurrency':
        options.rpcConcurrency = nextNumber();
        break;
      case '--bootstrap-nodes':
        options.bootstrapNodes = nextNumber();
        break;
      case '--mesh-min-peers':
        options.meshMinPeers = nextNumber();
        break;
      case '--mesh-timeout-ms':
        options.meshTimeoutMs = nextNumber();
        break;
      case '--submit-mode': {
        const raw = argv[++i];
        if (raw !== 'rpc' && raw !== 'ipc') throw new Error('--submit-mode must be rpc or ipc');
        options.submitMode = raw;
        break;
      }
      case '--submit-replication':
        options.submitReplication = nextNumber();
        break;
      case '--submit-order': {
        const raw = argv[++i];
        if (raw !== 'sender-major' && raw !== 'nonce-major') {
          throw new Error('--submit-order must be sender-major or nonce-major');
        }
        options.submitOrder = raw;
        break;
      }
      case '--submit-routing': {
        const raw = argv[++i];
        if (raw !== 'proposer' && raw !== 'sender') {
          throw new Error('--submit-routing must be proposer or sender');
        }
        options.submitRouting = raw;
        break;
      }
      case '--tx-repair':
        options.txRepair = true;
        break;
      case '--no-window-convergence':
        options.windowConvergence = false;
        break;
      case '--ipc-gossip':
        options.ipcGossip = true;
        break;
      case '--index-transactions':
        options.indexTransactions = true;
        break;
      case '--state-backend': {
        const raw = argv[++i];
        if (raw !== 'memory' && raw !== 'level') {
          throw new Error('--state-backend must be memory or level');
        }
        options.stateBackend = raw;
        break;
      }
      case '--signature-workers':
        options.signatureWorkers = nextNumber();
        break;
      case '--report-dir': {
        const raw = argv[++i];
        if (!raw) throw new Error('--report-dir requires a value');
        options.reportDir = raw;
        break;
      }
      case '--keep-data':
        options.keepData = true;
        break;
      case '--help':
      case '-h':
        process.stdout.write(usage());
        process.exit(0);
      default:
        throw new Error(`unknown option: ${arg}\n\n${usage()}`);
    }
  }
  return options;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const fromHex = (value) => new Uint8Array(Buffer.from(value, 'hex'));
const fmt = (n) => new Intl.NumberFormat('en-US').format(Math.trunc(n));
const seconds = (start, end = performance.now()) => (end - start) / 1000;
const workerPath = fileURLToPath(new URL('./validator-worker.mjs', import.meta.url));
const IPC_SUBMIT_TIMEOUT_MS = 30_000;

function jsonReplacer(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

function makeTransfer({ chainId, sender, nonce, to }) {
  const unsigned = {
    chainId,
    nonce,
    sender: sender.publicKey,
    maxFee: 1_000n,
    payload: { kind: 'transfer', to, amount: 0n },
  };
  return { ...unsigned, signature: sign(transactionSigningBytes(unsigned), sender.secretKey) };
}

function createWorker(index, onMessage) {
  const child = fork(workerPath, [], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    serialization: 'advanced',
  });
  child.setMaxListeners(0);
  child.stdout.on('data', (chunk) => process.stdout.write(`[worker-${index}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[worker-${index}] ${chunk}`));
  child.on('message', onMessage);
  child.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      process.stderr.write(`[worker-${index}] exited with code ${code}\n`);
    } else if (signal) {
      process.stderr.write(`[worker-${index}] exited from signal ${signal}\n`);
    }
  });
  return child;
}

async function waitForWorkers(workers, predicate, timeoutMs, label) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(250);
    for (const worker of workers) worker.send({ type: 'status', requestId: 0 });
  }
}

function requestStatus(worker) {
  const requestId = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.off('message', onMessage);
      reject(new Error('status request timed out'));
    }, 5_000);
    const onMessage = (message) => {
      if (message?.type !== 'status' || message.requestId !== requestId) return;
      clearTimeout(timer);
      worker.off('message', onMessage);
      resolve(message);
    };
    worker.on('message', onMessage);
    worker.send({ type: 'status', requestId });
  });
}

function submitIpc(target, txBytes, gossip) {
  const requestId = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      target.worker.off('message', onMessage);
      reject(new Error(`submit timeout after ${IPC_SUBMIT_TIMEOUT_MS}ms`));
    }, IPC_SUBMIT_TIMEOUT_MS);
    const onMessage = (message) => {
      if (message?.type !== 'submit_result' || message.requestId !== requestId) return;
      clearTimeout(timer);
      target.worker.off('message', onMessage);
      if (message.ok) resolve(message.hash);
      else reject(new Error(message.error));
    };
    target.worker.on('message', onMessage);
    target.worker.send({ type: 'submit_tx', requestId, tx: txBytes, gossip });
  });
}

async function waitForConvergence(workers, targetHeight, targetHash, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const statuses = await Promise.all(workers.map(requestStatus));
    const converged = statuses.every(
      (status) => BigInt(status.height) >= targetHeight && status.headHash === targetHash,
    );
    if (converged) return statuses;
    if (performance.now() > deadline) {
      throw new Error(`timeout waiting for convergence at ${targetHeight} ${targetHash}`);
    }
    await sleep(500);
  }
}

async function waitForMesh(workers, expectedPeers, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const statuses = await Promise.all(workers.map(requestStatus));
    if (statuses.every((status) => status.peerCount >= expectedPeers)) return statuses;
    if (performance.now() > deadline) {
      const peerCounts = statuses.map((status) => `${status.index}:${status.peerCount}`).join(', ');
      throw new Error(`timeout waiting for validator mesh (${peerCounts})`);
    }
    await sleep(500);
  }
}

function isRetryableRpcError(err) {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('CHANNEL_CLOSED') ||
    message.includes('CHANNEL_DESTROYED') ||
    message.includes('channel closed') ||
    message.includes('RPC client closed') ||
    message.includes('REQUEST_TIMEOUT') ||
    message.includes('submit timeout')
  );
}

function isAlreadyAppliedError(err) {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('nonce too low:');
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    }),
  ]);
}

async function submitWithRetry(targets, startIndex, txBytes, bootstrap, ipcGossip) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const target = targets[(startIndex + attempt) % targets.length];
    try {
      if (target.mode === 'ipc') return await submitIpc(target, txBytes, ipcGossip);
      return await withTimeout(target.client.submitTx(txBytes), 3_000, 'submit');
    } catch (err) {
      lastError = err;
      if (isAlreadyAppliedError(err)) return 'already-applied';
      if (!isRetryableRpcError(err)) throw err;
      if (target.mode === 'ipc') {
        await sleep(Math.min(1_000, 50 * (attempt + 1)));
        continue;
      }
      const oldClient = target.client;
      target.client = NodeRpcClient.connect(target.publicKey, { bootstrap });
      try {
        await oldClient.close();
      } catch {
        // The channel is already being replaced; close failures are retry noise.
      }
      await sleep(Math.min(1_000, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}

function submitBestEffortReplica(target, txBytes, ipcGossip) {
  if (target.mode === 'ipc') {
    try {
      target.worker.send({ type: 'ingest_tx', tx: txBytes, gossip: ipcGossip });
    } catch {
      // Best-effort replication should never fail the authoritative submit.
    }
    return;
  }

  void withTimeout(target.client.submitTx(txBytes), 3_000, 'replica submit').catch(() => {
    // Replica admission is opportunistic; the primary submit path still owns success/failure.
  });
}

function replicateSubmission(targets, startIndex, txBytes, replication, ipcGossip) {
  const replicaCount = Math.min(replication, targets.length);
  for (let offset = 1; offset < replicaCount; offset += 1) {
    submitBestEffortReplica(targets[(startIndex + offset) % targets.length], txBytes, ipcGossip);
  }
}

async function submitTransactions({
  clients,
  bootstrap,
  options,
  chainId,
  senders,
  recipient,
  committed,
  senderOrder,
  senderRankByIndex,
  waitForWindowConvergence,
}) {
  let accepted = 0;
  let failed = 0;
  let firstError;
  const start = performance.now();
  let lastLog = start;
  let rpcActiveMs = 0;
  const senderCount = senders.length;
  const totalRounds = Math.ceil(options.txs / senderCount);

  async function reconnectClients() {
    await Promise.all(
      clients.map(async (target) => {
        if (target.mode !== 'rpc') return;
        await target.client.close().catch(() => {});
        target.client = NodeRpcClient.connect(target.publicKey, { bootstrap });
      }),
    );
  }

  async function waitForCommittedCount(targetCommitted) {
    const deadline = performance.now() + options.finalityTimeoutMs;
    while (committed.count < targetCommitted) {
      if (performance.now() > deadline) {
        throw new Error(`timeout waiting for ${fmt(targetCommitted)} committed transactions`);
      }
      await sleep(500);
    }
    if (options.windowConvergence) await waitForWindowConvergence();
  }

  function targetIndexFor(senderIndex, windowStart, windowWidth) {
    if (options.submitRouting === 'sender') return senderIndex % clients.length;

    const senderRank = senderRankByIndex[senderIndex];
    const blocksBeforeWindow = Math.floor((windowStart * senderCount) / options.maxTxsPerBlock);
    const blockOffset = Math.floor((senderRank * windowWidth) / options.maxTxsPerBlock);
    const expectedHeight = blocksBeforeWindow + blockOffset + 1;
    return expectedHeight % clients.length;
  }

  async function runBatch(batchStartIndex, batchEndIndex) {
    let next = batchStartIndex;
    const windowStart = Math.floor(batchStartIndex / senderCount);
    const windowWidth = Math.ceil((batchEndIndex - batchStartIndex) / senderCount);
    async function worker() {
      for (;;) {
        if (firstError) return;
        const index = next;
        next += 1;
        if (index >= batchEndIndex) return;

        const ordinal = index - batchStartIndex;
        let senderIndex;
        let nonce;
        if (options.submitOrder === 'sender-major') {
          const senderRank = Math.floor(ordinal / windowWidth);
          senderIndex = senderOrder[senderRank];
          nonce = BigInt(windowStart + (ordinal % windowWidth));
        } else {
          senderIndex = index % senderCount;
          nonce = BigInt(Math.floor(index / senderCount));
        }
        const tx = makeTransfer({
          chainId,
          sender: senders[senderIndex],
          nonce,
          to: recipient.publicKey,
        });
        const targetIndex = targetIndexFor(senderIndex, windowStart, windowWidth);
        const txBytes = encodeTransaction(tx);

        try {
          replicateSubmission(
            clients,
            targetIndex,
            txBytes,
            options.submitReplication,
            options.ipcGossip,
          );
          await submitWithRetry(clients, targetIndex, txBytes, bootstrap, options.ipcGossip);
          accepted += 1;
        } catch (err) {
          failed += 1;
          firstError = err;
          return;
        }

        const now = performance.now();
        if (now - lastLog > 5_000) {
          lastLog = now;
          const rate = accepted / seconds(start, now);
          process.stdout.write(
            `[submit] accepted=${fmt(accepted)}/${fmt(options.txs)} ` +
              `phase-rate=${fmt(rate)} tx/s committed=${fmt(committed.count)} failed=${failed}\n`,
          );
        }
      }
    }

    const batchStart = performance.now();
    const workers = Array.from({ length: options.rpcConcurrency }, () => worker());
    await Promise.all(workers);
    rpcActiveMs += performance.now() - batchStart;
  }

  for (let windowStart = 0; windowStart < totalRounds; windowStart += options.mempoolWindow) {
    const windowEnd = Math.min(totalRounds, windowStart + options.mempoolWindow);
    const batchStartIndex = windowStart * senderCount;
    const batchEndIndex = Math.min(options.txs, windowEnd * senderCount);
    process.stdout.write(
      `[submit] nonce window ${windowStart}-${windowEnd - 1}: ` +
        `${fmt(batchEndIndex - batchStartIndex)} tx\n`,
    );
    await reconnectClients();
    await runBatch(batchStartIndex, batchEndIndex);
    if (firstError) throw firstError;
    if (batchEndIndex < options.txs) {
      process.stdout.write(
        `[submit] waiting for ${fmt(batchEndIndex)} committed tx before next nonce window\n`,
      );
      await waitForCommittedCount(batchEndIndex);
    }
  }

  const end = performance.now();
  return {
    accepted,
    failed,
    startedAtMs: start,
    endedAtMs: end,
    seconds: seconds(start, end),
    txPerSecond: accepted / seconds(start, end),
    rpcActiveSeconds: rpcActiveMs / 1000,
    rpcActiveTxPerSecond: accepted / (rpcActiveMs / 1000),
  };
}

async function runOnce({ runNumber, options, reportDir }) {
  const senderCount = Math.min(10_000, Math.ceil(options.txs / options.perSender));
  const maxTxsForAnySender = Math.ceil(options.txs / senderCount);
  const chainId = `hssn-cluster-${Date.now()}-${runNumber}`;
  const baseDir = mkdtempSync(join(tmpdir(), `hssn-cluster-${runNumber}-`));
  const testnet = await createTestnet(options.bootstrapNodes);
  const workers = [];
  const ready = new Map();
  const committed = {
    count: 0,
    height: 0n,
    headHash: '',
    blockSizes: [],
    byHeight: new Map(),
    conflicts: [],
  };
  let cleanedUp = false;
  const clients = [];

  async function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    for (const target of clients) {
      if (target.mode === 'rpc') await target.client.close().catch(() => {});
    }
    for (const worker of workers) worker.send({ type: 'stop' });
    await Promise.allSettled(
      workers.map(
        (worker) =>
          new Promise((resolve) => {
            if (worker.exitCode !== null) return resolve();
            worker.once('exit', resolve);
            setTimeout(() => {
              if (worker.exitCode === null) worker.kill('SIGTERM');
              resolve();
            }, 5_000).unref();
          }),
      ),
    );
    await testnet.destroy().catch(() => {});
    if (!options.keepData) rmSync(baseDir, { recursive: true, force: true });
  }

  const validatorSeeds = Array.from({ length: options.nodes }, () => generateSeed());
  const validatorKeys = validatorSeeds.map(keyPairFromSeed);
  const senders = Array.from({ length: senderCount }, () => keyPairFromSeed(generateSeed()));
  const senderOrder = [...senders.keys()].sort((a, b) =>
    Buffer.compare(Buffer.from(senders[a].publicKey), Buffer.from(senders[b].publicKey)),
  );
  const senderRankByIndex = new Array(senderCount);
  senderOrder.forEach((senderIndex, rank) => {
    senderRankByIndex[senderIndex] = rank;
  });
  const recipient = keyPairFromSeed(generateSeed());
  const allocationPerSender = BigInt(maxTxsForAnySender * 1_000 + 10_000);
  const genesis = {
    chainId,
    validators: validatorKeys.map((validator) => encodeAddress(validator.publicKey)),
    allocations: senders.map((sender) => ({
      address: encodeAddress(sender.publicKey),
      balance: allocationPerSender,
    })),
  };

  const setupStart = performance.now();
  process.stdout.write(
    `Run ${runNumber}: preparing ${options.nodes} validator processes, ` +
      `${fmt(senderCount)} funded senders, ${fmt(options.txs)} transactions\n`,
  );

  try {
    for (let index = 0; index < options.nodes; index += 1) {
      const worker = createWorker(index, (message) => {
        if (message?.type === 'ready') ready.set(message.index, message.rpcPublicKey);
        if (message?.type === 'error') {
          process.stderr.write(`[node-${message.index}] ${message.message}\n`);
        }
        if (message?.type === 'log') {
          process.stdout.write(`[node-${message.index}] ${message.message}\n`);
        }
        if (message?.type === 'block') {
          const height = BigInt(message.height);
          const existing = committed.byHeight.get(message.height);
          if (existing) {
            if (existing.blockHash !== message.blockHash || existing.txs !== message.txs) {
              committed.conflicts.push({
                height: message.height,
                first: existing,
                conflicting: {
                  index: message.index,
                  txs: message.txs,
                  blockHash: message.blockHash,
                },
              });
            }
            return;
          }
          committed.byHeight.set(message.height, {
            index: message.index,
            txs: message.txs,
            blockHash: message.blockHash,
          });
          committed.height = height;
          committed.count += message.txs;
          committed.headHash = message.headHash;
          committed.blockSizes.push(message.txs);
        }
      });
      workers.push(worker);
      worker.send({
        type: 'start',
        index,
        dir: join(baseDir, `node-${index}`),
        genesis,
        seedHex: hex(validatorSeeds[index]),
        bootstrap: testnet.bootstrap,
        blockIntervalMs: options.blockIntervalMs,
        roundTimeoutMs: options.roundTimeoutMs,
        maxTxsPerBlock: options.maxTxsPerBlock,
        minTxsPerBlock: options.minTxsPerBlock,
        maxProposalWaitMs: options.maxProposalWaitMs,
        txRepair: options.txRepair,
        indexTransactions: options.indexTransactions,
        stateBackend: options.stateBackend,
        signatureVerificationConcurrency: options.signatureWorkers,
      });
    }

    await waitForWorkers(
      workers,
      () => ready.size === options.nodes,
      options.meshTimeoutMs,
      'validator process startup',
    );
    process.stdout.write('Waiting for validator mesh\n');
    await waitForMesh(workers, options.meshMinPeers ?? options.nodes - 1, options.meshTimeoutMs);

    for (const index of [...ready.keys()].sort((a, b) => a - b)) {
      if (options.submitMode === 'ipc') {
        clients.push({ mode: 'ipc', worker: workers[index], index });
      } else {
        const publicKey = fromHex(ready.get(index));
        clients.push({
          mode: 'rpc',
          publicKey,
          client: NodeRpcClient.connect(publicKey, { bootstrap: testnet.bootstrap }),
        });
      }
    }
    const setupEnd = performance.now();
    process.stdout.write(`Setup complete in ${seconds(setupStart, setupEnd).toFixed(2)}s\n`);

    let lastCommitLog = performance.now();
    const commitLogger = setInterval(() => {
      const now = performance.now();
      if (now - lastCommitLog < 5_000) return;
      lastCommitLog = now;
      const elapsed = options._submitStartMs ? seconds(options._submitStartMs, now) : 0;
      const rate = elapsed > 0 ? committed.count / elapsed : 0;
      process.stdout.write(
        `[commit] blocks=${fmt(Number(committed.height))} committed=${fmt(committed.count)}/${fmt(
          options.txs,
        )} end-to-end=${fmt(rate)} tx/s\n`,
      );
    }, 1_000);
    commitLogger.unref();

    const submissionStart = performance.now();
    options._submitStartMs = submissionStart;
    const submission = await submitTransactions({
      clients,
      bootstrap: testnet.bootstrap,
      options,
      chainId,
      senders,
      recipient,
      committed,
      senderOrder,
      senderRankByIndex,
      waitForWindowConvergence: async () => {
        await waitForConvergence(workers, committed.height, committed.headHash, 60_000);
      },
    });
    process.stdout.write(
      `Submission complete: ${fmt(submission.accepted)} accepted in ` +
        `${submission.seconds.toFixed(2)}s (${fmt(submission.txPerSecond)} tx/s)\n`,
    );

    const deadline = performance.now() + options.finalityTimeoutMs;
    while (committed.count < options.txs) {
      if (performance.now() > deadline) {
        throw new Error(`timeout waiting for ${fmt(options.txs)} committed transactions`);
      }
      await sleep(500);
    }
    clearInterval(commitLogger);

    const committedAtMs = performance.now();
    const statuses = await waitForConvergence(
      workers,
      committed.height,
      committed.headHash,
      60_000,
    );
    const finality = {
      committed: committed.count,
      height: committed.height,
      headHash: committed.headHash,
      blockCount: committed.blockSizes.length,
      blockSizes: committed.blockSizes,
      conflicts: committed.conflicts,
      committedAtMs,
      seconds: seconds(submission.startedAtMs, committedAtMs),
      txPerSecond: committed.count / seconds(submission.startedAtMs, committedAtMs),
    };
    process.stdout.write(
      `Finality complete: ${fmt(finality.committed)} committed in ` +
        `${finality.seconds.toFixed(2)}s (${fmt(finality.txPerSecond)} tx/s)\n`,
    );

    const report = {
      benchmark: 'hssn-local-10-process-throughput',
      run: runNumber,
      completedAt: new Date().toISOString(),
      environment: {
        hostname: os.hostname(),
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        cpus: os.cpus().length,
        cpuModel: os.cpus()[0]?.model ?? 'unknown',
        totalMemoryBytes: os.totalmem(),
        node: process.version,
      },
      parameters: {
        nodes: options.nodes,
        transactions: options.txs,
        fundedSenders: senderCount,
        targetTransactionsPerSender: options.perSender,
        maxTransactionsForAnySender: maxTxsForAnySender,
        mempoolWindow: options.mempoolWindow,
        maxTxsPerBlock: options.maxTxsPerBlock,
        minTxsPerBlock: options.minTxsPerBlock,
        maxProposalWaitMs: options.maxProposalWaitMs,
        blockIntervalMs: options.blockIntervalMs,
        roundTimeoutMs: options.roundTimeoutMs,
        rpcConcurrency: options.rpcConcurrency,
        submitMode: options.submitMode,
        submitReplication: options.submitReplication,
        submitOrder: options.submitOrder,
        submitRouting: options.submitRouting,
        txRepair: options.txRepair,
        windowConvergence: options.windowConvergence,
        ipcGossip: options.ipcGossip,
        indexTransactions: options.indexTransactions,
        stateBackend: options.stateBackend,
        signatureWorkers: options.signatureWorkers,
        bootstrapNodes: options.bootstrapNodes,
        chainId,
      },
      results: {
        setupSeconds: seconds(setupStart, setupEnd),
        submission,
        finality,
        finalityLagSeconds: Math.max(0, finality.seconds - submission.seconds),
        averageTxsPerBlock: finality.committed / finality.blockCount,
        validatorHeads: statuses.map((status) => ({
          index: status.index,
          height: status.height,
          headHash: status.headHash,
          mempoolSize: status.mempoolSize,
        })),
      },
      dataDir: options.keepData ? baseDir : null,
    };

    mkdirSync(reportDir, { recursive: true });
    const reportPath = join(reportDir, `run-${String(runNumber).padStart(2, '0')}.json`);
    writeFileSync(reportPath, `${JSON.stringify(report, jsonReplacer, 2)}\n`);
    process.stdout.write(`Report written: ${reportPath}\n`);
    return report;
  } finally {
    await cleanup();
  }
}

async function main() {
  const options = readArgs(process.argv.slice(2));
  if (options.nodes < 3) throw new Error('use at least 3 validators for the consensus benchmark');
  if (options.submitMode === 'ipc' && !options.ipcGossip && options.submitRouting !== 'proposer') {
    throw new Error('--submit-mode ipc without --ipc-gossip requires --submit-routing proposer');
  }
  const reportDir = resolve(
    options.reportDir ?? join('benchmark-results', `cluster-${Date.now()}`),
  );

  const reports = [];
  for (let runNumber = 1; runNumber <= options.runs; runNumber += 1) {
    reports.push(await runOnce({ runNumber, options: { ...options }, reportDir }));
  }
  const summary = {
    benchmark: 'hssn-local-10-process-throughput-summary',
    completedAt: new Date().toISOString(),
    runs: reports.map((report) => ({
      run: report.run,
      committed: report.results.finality.committed,
      seconds: report.results.finality.seconds,
      txPerSecond: report.results.finality.txPerSecond,
      headHash: report.results.finality.headHash,
    })),
  };
  writeFileSync(join(reportDir, 'summary.json'), `${JSON.stringify(summary, jsonReplacer, 2)}\n`);
  process.stdout.write(`Summary written: ${join(reportDir, 'summary.json')}\n`);
}

main().catch((err) => {
  process.stderr.write(
    `error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
