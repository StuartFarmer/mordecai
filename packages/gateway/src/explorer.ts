import {
  NodeRpcClient,
  type AppInfo,
  type BlockInfo,
  type HeadInfo,
  type TxInfo,
} from '@mordecai/rpc';

export type AppReadRequest =
  { kind: 'head' } | { kind: 'block'; height: bigint } | { kind: 'tx'; hash: string };

export class AppReadError extends Error {
  readonly code = 'UPSTREAM_UNAVAILABLE';

  constructor() {
    super('App-chain peers are unavailable.');
    this.name = 'AppReadError';
  }
}

export async function readAppChain(
  entry: AppInfo,
  request: AppReadRequest,
  options: { bootstrap?: { host: string; port: number }[]; mounted?: NodeRpcClient },
): Promise<HeadInfo | BlockInfo | TxInfo | null> {
  const deadline = Date.now() + 5000;
  let matchingPeer = false;
  for (const peer of [options.mounted, ...entry.chainValidators]) {
    if (!peer) continue;
    if (Date.now() >= deadline) break;
    const attemptDeadline = Math.min(deadline, Date.now() + 1000);
    const remaining = () => {
      const timeout = attemptDeadline - Date.now();
      if (timeout <= 0) throw new AppReadError();
      return { timeout };
    };
    let client: NodeRpcClient | undefined;
    try {
      client =
        typeof peer === 'string'
          ? NodeRpcClient.connect(
              Buffer.from(peer, 'hex'),
              options.bootstrap ? { bootstrap: options.bootstrap } : {},
            )
          : peer;
      const head = await client.getHead(remaining());
      if (head.chainId !== `app:${entry.appId}`) continue;
      matchingPeer = true;
      if (request.kind === 'head') return head;
      const result =
        request.kind === 'block'
          ? await client.getBlock(request.height, remaining())
          : await client.getTx(request.hash, remaining());
      if (result) return result;
    } catch {
      // A failed peer must not hide data available from another registered validator.
    } finally {
      if (typeof peer === 'string') await client?.close();
    }
  }
  if (matchingPeer) return null;
  throw new AppReadError();
}
