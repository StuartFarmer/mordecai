import { verify } from '@hssn/crypto';
import { transactionSigningBytesFromEncoded } from '@hssn/protocol';
import { parentPort } from 'node:worker_threads';

interface SignatureVerifyJob {
  index: number;
  hashHex: string;
  signature: Uint8Array;
  sender: Uint8Array;
  encoded: Uint8Array;
}

interface SignatureVerifyRequest {
  requestId: number;
  jobs: SignatureVerifyJob[];
}

if (!parentPort) throw new Error('signature worker requires a parent port');

parentPort.on('message', (message: SignatureVerifyRequest) => {
  const valid: string[] = [];
  const invalid: number[] = [];
  for (const job of message.jobs) {
    if (verify(job.signature, transactionSigningBytesFromEncoded(job.encoded), job.sender)) {
      valid.push(job.hashHex);
    } else {
      invalid.push(job.index);
    }
  }
  parentPort!.postMessage({ requestId: message.requestId, valid, invalid });
});
