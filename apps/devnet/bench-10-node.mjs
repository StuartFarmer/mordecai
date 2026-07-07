#!/usr/bin/env node
/**
 * Local 10-validator throughput benchmark.
 *
 * Usage:
 *   pnpm build
 *   node apps/devnet/bench-10-node.mjs
 *
 * Defaults target the requested run: 10 local validators, 1,000,000 transfer
 * transactions, HyperDHT in-process testnet, real RPC submission, real
 * consensus gossip, block verification, and LevelDB persistence.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import createTestnet from '../../packages/networking/node_modules/hyperdht/testnet.js';
import {
  encodeAddress,
  generateSeed,
  keyPairFromSeed,
  sign,
} from '../../packages/crypto/dist/index.js';
import { transactionSigningBytes, encodeTransaction } from '../../packages/protocol/dist/index.js';
import { Node } from '../../packages/node/dist/index.js';
import { NodeRpcClient } from '../../packages/rpc/dist/index.js';

const DEFAULTS = {
  nodes: 10,
  txs: 1_000_000,
  perSender: 100,
  mempoolWindow: 64,
  maxTxsPerBlock: 10_000,
  minTxsPerBlock: 1,
  blockIntervalMs: 25,
  maxProposalWaitMs: 0,
  roundTimeoutMs: 3_000,
  rpcConcurrency: 256,
  bootstrapNodes: 3,
  meshTimeoutMs: 60_000,
  finalityTimeoutMs: 90 * 60_000,
};

function usage() {
  return `Usage: node apps/devnet/bench-10-node.mjs [options]

Options:
  --nodes <n>               Validator count (default ${DEFAULTS.nodes})
  --txs <n>                 Transactions to submit (default ${DEFAULTS.txs})
  --per-sender <n>          Target transactions per funded sender (default ${DEFAULTS.perSender})
  --mempool-window <n>      Pending nonces submitted per sender at once (default ${DEFAULTS.mempoolWindow})
  --max-txs-per-block <n>   Consensus block transaction cap (default ${DEFAULTS.maxTxsPerBlock})
  --min-txs-per-block <n>   Prefer waiting for this many txs before proposing (default ${DEFAULTS.minTxsPerBlock})
  --block-interval-ms <n>   Consensus tick interval (default ${DEFAULTS.blockIntervalMs})
  --max-proposal-wait-ms <n> Maximum wait for a fuller block before partial proposal (default ${DEFAULTS.maxProposalWaitMs})
  --round-timeout-ms <n>    Round proposer timeout (default ${DEFAULTS.roundTimeoutMs})
  --rpc-concurrency <n>     Concurrent RPC submit_tx calls (default ${DEFAULTS.rpcConcurrency})
  --bootstrap-nodes <n>     Local HyperDHT bootstrap nodes (default ${DEFAULTS.bootstrapNodes})
  --report <path>           JSON report path (default benchmark-results/<timestamp>.json)
  --keep-data               Keep temporary chain data after the run
  --help                    Show this help
`;
}

function readArgs(argv) {
  const options = { ...DEFAULTS, keepData: false, report: undefined };
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
      case '--block-interval-ms':
        options.blockIntervalMs = nextNumber();
        break;
      case '--max-proposal-wait-ms':
        options.maxProposalWaitMs = nextNumber();
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
      case '--report': {
        const raw = argv[++i];
        if (!raw) throw new Error('--report requires a value');
        options.report = raw;
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
const fmt = (n) => new Intl.NumberFormat('en-US').format(Math.trunc(n));
const seconds = (start, end = performance.now()) => (end - start) / 1000;

function jsonReplacer(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

async function waitFor(name, predicate, timeoutMs, intervalMs = 100) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`timeout waiting for ${name}`);
    await sleep(intervalMs);
  }
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

async function submitTransactions({ client, options, chainId, senders, recipient }) {
  let accepted = 0;
  let failed = 0;
  let firstError;
  const start = performance.now();
  let lastLog = start;
  let rpcActiveMs = 0;
  const senderCount = senders.length;
  const totalRounds = Math.ceil(options.txs / senderCount);

  async function waitForCommittedCount(targetCommitted) {
    let committed = 0;
    let lastHeight = 0n;
    const deadline = performance.now() + options.finalityTimeoutMs;
    while (committed < targetCommitted) {
      if (performance.now() > deadline) {
        throw new Error(`timeout waiting for ${fmt(targetCommitted)} committed transactions`);
      }
      const reference = options.referenceNode;
      while (lastHeight < reference.chain.height) {
        lastHeight += 1n;
        const block = await reference.chain.getBlock(lastHeight);
        if (!block) throw new Error(`missing block ${lastHeight}`);
        committed += block.txs.length;
      }
      if (committed < targetCommitted) await sleep(250);
    }
  }

  async function runBatch(batchStartIndex, batchEndIndex) {
    let next = batchStartIndex;
    async function worker() {
      for (;;) {
        if (firstError) return;
        const index = next;
        next += 1;
        if (index >= batchEndIndex) return;

        const senderIndex = index % senderCount;
        const nonce = BigInt(Math.floor(index / senderCount));
        const tx = makeTransfer({
          chainId,
          sender: senders[senderIndex],
          nonce,
          to: recipient.publicKey,
        });

        try {
          await client.submitTx(encodeTransaction(tx));
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
              `phase-rate=${fmt(rate)} tx/s failed=${failed}\n`,
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

async function monitorFinality({ nodes, targetTxs, startAtMs, timeoutMs }) {
  let committed = 0;
  let lastHeight = 0n;
  let lastLog = performance.now();
  const blockSizes = [];
  const deadline = performance.now() + timeoutMs;

  while (committed < targetTxs) {
    if (performance.now() > deadline) {
      throw new Error(`timeout waiting for ${fmt(targetTxs)} committed transactions`);
    }

    const reference = nodes[0];
    while (lastHeight < reference.chain.height) {
      lastHeight += 1n;
      const block = await reference.chain.getBlock(lastHeight);
      if (!block) throw new Error(`missing block ${lastHeight}`);
      committed += block.txs.length;
      blockSizes.push(block.txs.length);
    }

    const now = performance.now();
    if (now - lastLog > 5_000) {
      lastLog = now;
      const rate = committed / seconds(startAtMs, now);
      process.stdout.write(
        `[commit] blocks=${fmt(Number(lastHeight))} committed=${fmt(committed)}/${fmt(targetTxs)} ` +
          `end-to-end=${fmt(rate)} tx/s\n`,
      );
    }
    if (committed < targetTxs) await sleep(100);
  }

  const committedAtMs = performance.now();
  const referenceHeight = nodes[0].chain.height;
  await waitFor(
    `all ${nodes.length} validators to converge at height ${referenceHeight}`,
    () => nodes.every((node) => node.chain.height >= referenceHeight),
    60_000,
    100,
  );
  const referenceHead = hex(nodes[0].chain.headHash);
  await waitFor(
    `all ${nodes.length} validators to share head ${referenceHead}`,
    () =>
      nodes.every(
        (node) =>
          node.chain.height === referenceHeight && hex(node.chain.headHash) === referenceHead,
      ),
    60_000,
    100,
  );

  return {
    committed,
    height: referenceHeight,
    headHash: referenceHead,
    blockCount: blockSizes.length,
    blockSizes,
    committedAtMs,
    seconds: seconds(startAtMs, committedAtMs),
    txPerSecond: committed / seconds(startAtMs, committedAtMs),
  };
}

async function main() {
  const options = readArgs(process.argv.slice(2));
  if (options.nodes < 4) {
    throw new Error('use at least 4 validators for the BFT consensus benchmark');
  }
  const senderCount = Math.min(10_000, Math.ceil(options.txs / options.perSender));
  const maxTxsForAnySender = Math.ceil(options.txs / senderCount);
  const chainId = `hssn-bench-${Date.now()}`;
  const reportPath = resolve(
    options.report ??
      join('benchmark-results', `hssn-${options.nodes}-node-${options.txs}-tx-${Date.now()}.json`),
  );

  process.stdout.write(
    `Preparing ${options.nodes} validators, ${fmt(senderCount)} funded senders, ` +
      `${fmt(options.txs)} transactions (${fmt(maxTxsForAnySender)} max tx/sender)\n`,
  );

  const setupStart = performance.now();
  const validatorKeys = Array.from({ length: options.nodes }, () =>
    keyPairFromSeed(generateSeed()),
  );
  const senders = Array.from({ length: senderCount }, () => keyPairFromSeed(generateSeed()));
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

  const baseDir = mkdtempSync(join(tmpdir(), 'hssn-bench-'));
  const testnet = await createTestnet(options.bootstrapNodes);
  const nodes = [];
  let client;
  let cleanedUp = false;

  async function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    if (client) await client.close().catch(() => {});
    for (const node of nodes) await node.stop().catch(() => {});
    await testnet.destroy().catch(() => {});
    if (!options.keepData) rmSync(baseDir, { recursive: true, force: true });
  }

  process.on('SIGINT', () => {
    void cleanup().finally(() => process.exit(130));
  });
  process.on('SIGTERM', () => {
    void cleanup().finally(() => process.exit(143));
  });

  try {
    for (const [index, keyPair] of validatorKeys.entries()) {
      const node = await Node.start({
        dir: join(baseDir, `node-${index}`),
        genesis,
        keyPair,
        blockIntervalMs: options.blockIntervalMs,
        roundTimeoutMs: options.roundTimeoutMs,
        maxTxsPerBlock: options.maxTxsPerBlock,
        minTxsPerBlock: options.minTxsPerBlock,
        maxProposalWaitMs: options.maxProposalWaitMs,
        bootstrap: testnet.bootstrap,
        log: (message) => {
          if (message.includes('committed')) process.stdout.write(`[node-${index}] ${message}\n`);
        },
      });
      nodes.push(node);
    }

    process.stdout.write('Waiting for validator mesh\n');
    await waitFor(
      'full validator mesh',
      () => nodes.every((node) => node.hub?.peerCount >= options.nodes - 1),
      options.meshTimeoutMs,
      250,
    );

    client = NodeRpcClient.connect(nodes[0].rpcPublicKey, { bootstrap: testnet.bootstrap });
    const setupEnd = performance.now();
    process.stdout.write(`Setup complete in ${seconds(setupStart, setupEnd).toFixed(2)}s\n`);

    const submission = await submitTransactions({
      client,
      options: { ...options, referenceNode: nodes[0] },
      chainId,
      senders,
      recipient,
    });
    process.stdout.write(
      `Submission complete: ${fmt(submission.accepted)} accepted in ` +
        `${submission.seconds.toFixed(2)}s (${fmt(submission.txPerSecond)} tx/s)\n`,
    );

    const finality = await monitorFinality({
      nodes,
      targetTxs: options.txs,
      startAtMs: submission.startedAtMs,
      timeoutMs: options.finalityTimeoutMs,
    });
    process.stdout.write(
      `Finality complete: ${fmt(finality.committed)} committed in ` +
        `${finality.seconds.toFixed(2)}s (${fmt(finality.txPerSecond)} tx/s)\n`,
    );

    const report = {
      benchmark: 'hssn-local-10-node-throughput',
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
        blockIntervalMs: options.blockIntervalMs,
        maxProposalWaitMs: options.maxProposalWaitMs,
        roundTimeoutMs: options.roundTimeoutMs,
        rpcConcurrency: options.rpcConcurrency,
        bootstrapNodes: options.bootstrapNodes,
        chainId,
      },
      results: {
        setupSeconds: seconds(setupStart, setupEnd),
        submission,
        finality,
        finalityLagSeconds: Math.max(0, finality.seconds - submission.seconds),
        averageTxsPerBlock: finality.committed / finality.blockCount,
        validatorHeads: nodes.map((node, index) => ({
          index,
          height: node.chain.height,
          headHash: hex(node.chain.headHash),
        })),
      },
      dataDir: options.keepData ? baseDir : null,
    };

    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, jsonReplacer, 2)}\n`);
    process.stdout.write(`Report written: ${reportPath}\n`);
  } finally {
    await cleanup();
  }
}

main().catch((err) => {
  process.stderr.write(
    `error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
