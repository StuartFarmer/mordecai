import { Worker } from 'node:worker_threads';
import { blake2b256, verify } from '@hssn/crypto';
import {
  encodeTransaction,
  transactionSigningBytes,
  transactionSigningBytesFromEncoded,
  type Transaction,
} from '@hssn/protocol';

export interface TransactionFacts {
  hash: Uint8Array;
  hashHex: string;
  encodedLength: number;
  encoded?: Uint8Array;
}

const MAX_VERIFIED_SIGNATURES = 250_000;
const factsByTx = new WeakMap<Transaction, TransactionFacts>();
const verifiedSignatures = new Set<string>();
const verifiedSignatureOrder: string[] = [];
let verifiedSignatureOrderOffset = 0;
let signatureVerifierPool: SignatureVerifierPool | undefined;

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

function rememberVerifiedSignature(hashHex: string): void {
  if (verifiedSignatures.has(hashHex)) return;
  verifiedSignatures.add(hashHex);
  verifiedSignatureOrder.push(hashHex);
  if (verifiedSignatureOrder.length - verifiedSignatureOrderOffset <= MAX_VERIFIED_SIGNATURES) {
    return;
  }

  const trim = Math.max(1, Math.floor(MAX_VERIFIED_SIGNATURES / 10));
  const end = Math.min(verifiedSignatureOrder.length, verifiedSignatureOrderOffset + trim);
  for (; verifiedSignatureOrderOffset < end; verifiedSignatureOrderOffset += 1) {
    const evicted = verifiedSignatureOrder[verifiedSignatureOrderOffset];
    if (evicted === undefined) continue;
    verifiedSignatures.delete(evicted);
  }
  if (
    verifiedSignatureOrderOffset > MAX_VERIFIED_SIGNATURES &&
    verifiedSignatureOrderOffset * 2 > verifiedSignatureOrder.length
  ) {
    verifiedSignatureOrder.splice(0, verifiedSignatureOrderOffset);
    verifiedSignatureOrderOffset = 0;
  }
}

export function markTransactionSignatureVerified(facts: TransactionFacts): void {
  rememberVerifiedSignature(facts.hashHex);
}

export function rememberEncodedTransaction(tx: Transaction, encoded: Uint8Array): TransactionFacts {
  const hash = blake2b256(encoded);
  const facts = { hash, hashHex: hex(hash), encodedLength: encoded.length, encoded };
  factsByTx.set(tx, facts);
  return facts;
}

export function getTransactionFacts(tx: Transaction): TransactionFacts {
  const cached = factsByTx.get(tx);
  if (cached) return cached;
  return rememberEncodedTransaction(tx, encodeTransaction(tx));
}

/** Canonical transaction id: BLAKE2b-256 of the encoded transaction. */
export function transactionHash(tx: Transaction): Uint8Array {
  return getTransactionFacts(tx).hash;
}

export function verifyTransactionSignature(
  tx: Transaction,
  facts: TransactionFacts = getTransactionFacts(tx),
): boolean {
  if (verifiedSignatures.has(facts.hashHex)) return true;
  const signingBytes = facts.encoded
    ? transactionSigningBytesFromEncoded(facts.encoded)
    : transactionSigningBytes(tx);
  const valid = verify(tx.signature, signingBytes, tx.sender);
  if (valid) rememberVerifiedSignature(facts.hashHex);
  return valid;
}

interface SignatureVerifyJob {
  index: number;
  hashHex: string;
  signature: Uint8Array;
  sender: Uint8Array;
  encoded: Uint8Array;
}

interface SignatureVerifyResponse {
  requestId: number;
  valid: string[];
  invalid: number[];
}

/**
 * Verify transaction signatures, optionally in parallel.
 *
 * This preserves normal validation semantics; the worker path only moves
 * independent Ed25519 checks off the validator's main event loop.
 */
export async function verifyTransactionSignatures(
  txs: readonly Transaction[],
  concurrency: number,
): Promise<number | null> {
  const jobs: SignatureVerifyJob[] = [];
  for (const [index, tx] of txs.entries()) {
    const facts = getTransactionFacts(tx);
    if (verifiedSignatures.has(facts.hashHex)) continue;
    jobs.push({
      index,
      hashHex: facts.hashHex,
      signature: tx.signature,
      sender: tx.sender,
      encoded: facts.encoded ?? encodeTransaction(tx),
    });
  }
  if (jobs.length === 0) return null;

  if (concurrency <= 1 || jobs.length < 128) {
    for (const job of jobs) {
      const valid = verify(
        job.signature,
        transactionSigningBytesFromEncoded(job.encoded),
        job.sender,
      );
      if (!valid) return job.index;
      rememberVerifiedSignature(job.hashHex);
    }
    return null;
  }

  const pool = getSignatureVerifierPool(concurrency);
  const result = await pool.verify(jobs);
  for (const hashHex of result.valid) rememberVerifiedSignature(hashHex);
  return result.invalid[0] ?? null;
}

function getSignatureVerifierPool(size: number): SignatureVerifierPool {
  const normalizedSize = Math.max(1, Math.trunc(size));
  if (signatureVerifierPool?.size === normalizedSize) return signatureVerifierPool;
  void signatureVerifierPool?.close();
  signatureVerifierPool = new SignatureVerifierPool(normalizedSize);
  return signatureVerifierPool;
}

class SignatureVerifierPool {
  readonly workers: Worker[];
  private requestId = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly size: number) {
    this.workers = Array.from({ length: size }, () => {
      const worker = new Worker(new URL('./signature-worker.js', import.meta.url));
      worker.unref();
      return worker;
    });
  }

  verify(jobs: readonly SignatureVerifyJob[]): Promise<SignatureVerifyResponse> {
    const run = this.queue.then(() => this.verifyNow(jobs));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async verifyNow(jobs: readonly SignatureVerifyJob[]): Promise<SignatureVerifyResponse> {
    const chunkSize = Math.ceil(jobs.length / this.workers.length);
    const chunks = this.workers
      .map((worker, index) => ({
        worker,
        jobs: jobs.slice(index * chunkSize, (index + 1) * chunkSize),
      }))
      .filter((chunk) => chunk.jobs.length > 0);
    const results = await Promise.all(
      chunks.map(({ worker, jobs: chunkJobs }) => this.verifyChunk(worker, chunkJobs)),
    );
    return {
      requestId: 0,
      valid: results.flatMap((result) => result.valid),
      invalid: results.flatMap((result) => result.invalid),
    };
  }

  private verifyChunk(
    worker: Worker,
    jobs: readonly SignatureVerifyJob[],
  ): Promise<SignatureVerifyResponse> {
    const requestId = ++this.requestId;
    return new Promise((resolve, reject) => {
      const onMessage = (message: SignatureVerifyResponse) => {
        if (message?.requestId !== requestId) return;
        cleanup();
        resolve(message);
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        worker.off('message', onMessage);
        worker.off('error', onError);
      };
      worker.on('message', onMessage);
      worker.once('error', onError);
      worker.postMessage({ requestId, jobs });
    });
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.terminate()));
  }
}
