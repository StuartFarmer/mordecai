import { readFileSync } from 'node:fs';
import { setInterval, clearInterval } from 'node:timers';
import { join } from 'node:path';
import { appAddress } from '../../packages/chain/dist/index.js';
import { NodeRpcClient } from '../../packages/rpc/dist/index.js';
import { AnchorDaemon, AppChain } from '../../packages/appchain/dist/index.js';
import { Wallet } from '../../packages/wallet/dist/index.js';
import { loadDemoIdentity, bootstrapTransaction } from './demo-state.mjs';
import { outpostOutcome } from './outpost-outcome.mjs';
const APP = 'com.example.outpost';
const hex = (s) => new Uint8Array(Buffer.from(s, 'hex'));
const addr = (key) => {
  const b = Buffer.alloc(36);
  b.writeUInt32LE(32);
  b.set(key, 4);
  return new Uint8Array(b);
};
export async function bootOutpost({ base, repoRoot, rpc, chainId, nodeKey, bootstrap, bootL1 }) {
  const dir = join(base, 'outpost');
  const identity = loadDemoIdentity(dir, chainId, 0);
  const hosts = ['host-a', 'host-b'].map((role) => identity.key(role));
  const relayer = identity.key('relayer');
  const faucet = Wallet.fromSeed(identity.seed('app-faucet'));
  await bootL1('outpost-relayer-fund', {
    kind: 'transfer',
    to: relayer.publicKey,
    amount: 10_000_000n,
  });
  const market = hex(
    (
      await bootL1('outpost-market-deploy', {
        kind: 'deploy_contract',
        code: new Uint8Array(readFileSync(join(repoRoot, 'contracts/dist/goods_market.wasm'))),
      })
    ).returnData,
  );
  await bootL1('outpost-market-init', {
    kind: 'execute_contract',
    contract: market,
    value: 0n,
    action: 'init',
    args: addr(appAddress(APP)),
  });
  await bootL1('outpost-register', {
    kind: 'register_app',
    appId: APP,
    pearKey: new Uint8Array(32).fill(1),
    version: '1.0.0',
    contractAddress: new Uint8Array(32),
    metadataHash: new Uint8Array(32).fill(2),
    chainValidators: hosts.map((k) => k.publicKey),
  });
  const chains = [];
  let appRpc;
  try {
    const joins = await Promise.allSettled(
      hosts.map((keyPair, i) =>
        AppChain.join(rpc, APP, {
          dir: join(dir, `app-${i}`),
          keyPair,
          bootstrap,
          blockIntervalMs: 300,
        }).then((chain) => {
          chains[i] = chain;
          return chain;
        }),
      ),
    );
    const failedJoin = joins.find((result) => result.status === 'rejected');
    if (failedJoin) throw failedJoin.reason;
    await Promise.all(chains.map((chain) => chain.waitForPeers(1)));
    appRpc = NodeRpcClient.connect(chains[0].rpcPublicKey, { bootstrap });
    const appChainId = chains[0].genesis.chainId;
    const bootApp = (step, payload) =>
      bootstrapTransaction(dir, step, appRpc, appChainId, hosts[0], payload);
    const outpost = hex(
      (
        await bootApp('outpost-deploy', {
          kind: 'deploy_contract',
          code: new Uint8Array(readFileSync(join(repoRoot, 'contracts/dist/outpost.wasm'))),
        })
      ).returnData,
    );
    const size = Buffer.alloc(8);
    size.writeBigUInt64LE(144n);
    await bootApp('outpost-init', {
      kind: 'execute_contract',
      contract: outpost,
      value: 0n,
      action: 'init',
      args: new Uint8Array(size),
    });
    await bootApp('outpost-faucet-fund', {
      kind: 'transfer',
      to: faucet.publicKey,
      amount: 100_000_000_000n,
    });
    let daemon,
      timer,
      pending = Promise.resolve();
    return {
      config: {
        chainId,
        appChainId,
        appId: APP,
        market: Buffer.from(market).toString('hex'),
        outpost: Buffer.from(outpost).toString('hex'),
        appApi: '/api/demos/outpost',
        appFaucet: '/api/demos/outpost/api/faucet',
      },
      networks: {
        outpost: {
          nodeKey: chains[0].rpcPublicKey,
          bootstrap,
          faucet,
          faucetAmount: 1_000_000_000n,
        },
      },
      start() {
        if (daemon) return;
        daemon = new AnchorDaemon({
          chain: chains[0].chain,
          appId: APP,
          validators: hosts.map((k) => k.publicKey),
          keyPair: hosts[0],
          l1: { chainId, nodeKey, bootstrap },
          relayer,
          outcome: outpostOutcome(rpc, market, outpost),
        });
        timer = setInterval(() => {
          pending = pending
            .then(() => daemon.anchorNow())
            .catch((error) => console.error('[outpost anchor]', error));
        }, 5000);
      },
      async close() {
        clearInterval(timer);
        await pending;
        await daemon?.close();
        await appRpc.close();
        await Promise.all(chains.map((chain) => chain.stop()));
      },
    };
  } catch (error) {
    await appRpc?.close().catch(() => {});
    await Promise.all(chains.map((chain) => chain.stop().catch(() => {})));
    throw error;
  }
}
