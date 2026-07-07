#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { blockHash } from '../../packages/chain/dist/index.js';
import { keyPairFromSeed } from '../../packages/crypto/dist/index.js';
import { Node } from '../../packages/node/dist/index.js';

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const fromHex = (value) => new Uint8Array(Buffer.from(value, 'hex'));

let node;
let index = -1;
let lastReportedHeight = 0n;
let blockReporter;

function send(message) {
  if (process.connected) process.send(message);
}

async function reportBlocks() {
  if (!node) return;
  while (lastReportedHeight < node.chain.height) {
    lastReportedHeight += 1n;
    const block = await node.chain.getBlock(lastReportedHeight);
    if (!block) return;
    send({
      type: 'block',
      index,
      height: lastReportedHeight.toString(),
      txs: block.txs.length,
      blockHash: hex(blockHash(block.header)),
      headHash: hex(node.chain.headHash),
    });
  }
}

async function status(requestId) {
  await reportBlocks().catch(() => {});
  send({
    type: 'status',
    requestId,
    index,
    height: node?.chain.height.toString() ?? '0',
    headHash: node ? hex(node.chain.headHash) : '',
    mempoolSize: node?.mempool.size ?? 0,
    peerCount: node?.hub?.peerCount ?? 0,
  });
}

async function stop(exitCode = 0) {
  if (blockReporter) clearInterval(blockReporter);
  await node?.stop().catch(() => {});
  process.exit(exitCode);
}

process.on('message', (message) => {
  void (async () => {
    if (message?.type === 'start') {
      index = message.index;
      mkdirSync(dirname(message.dir), { recursive: true });
      node = await Node.start({
        dir: message.dir,
        genesis: message.genesis,
        keyPair: keyPairFromSeed(fromHex(message.seedHex)),
        blockIntervalMs: message.blockIntervalMs,
        roundTimeoutMs: message.roundTimeoutMs,
        maxTxsPerBlock: message.maxTxsPerBlock,
        minTxsPerBlock: message.minTxsPerBlock,
        maxProposalWaitMs: message.maxProposalWaitMs,
        txRepair: message.txRepair,
        indexTransactions: message.indexTransactions,
        stateBackend: message.stateBackend,
        signatureVerificationConcurrency: message.signatureVerificationConcurrency,
        bootstrap: message.bootstrap,
        log: (logMessage) => {
          if (logMessage.includes('round') || logMessage.includes('proposed')) {
            send({ type: 'log', index, message: logMessage });
          }
        },
      });
      blockReporter = setInterval(() => {
        void reportBlocks().catch((err) => {
          send({ type: 'error', index, message: err instanceof Error ? err.message : String(err) });
        });
      }, 250);
      blockReporter.unref();
      send({ type: 'ready', index, rpcPublicKey: hex(node.rpcPublicKey) });
      return;
    }
    if (message?.type === 'status') {
      await status(message.requestId);
      return;
    }
    if (message?.type === 'submit_tx') {
      try {
        const hash = await node.mempool.addEncoded(message.tx);
        if (message.gossip !== false) node.engine?.broadcastTxBytes(message.tx);
        send({
          type: 'submit_result',
          requestId: message.requestId,
          ok: true,
          hash: hex(hash),
        });
      } catch (err) {
        send({
          type: 'submit_result',
          requestId: message.requestId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    if (message?.type === 'ingest_tx') {
      await node.mempool
        .addEncoded(message.tx)
        .then(() => {
          if (message.gossip !== false) node.engine?.broadcastTxBytes(message.tx);
        })
        .catch(() => {
          // Best-effort replica ingress ignores duplicates and stale transactions.
        });
      return;
    }
    if (message?.type === 'stop') {
      await stop(0);
    }
  })().catch((err) => {
    send({
      type: 'error',
      index,
      message: err instanceof Error ? (err.stack ?? err.message) : err,
    });
    void stop(1);
  });
});

process.on('SIGINT', () => void stop(130));
process.on('SIGTERM', () => void stop(143));
