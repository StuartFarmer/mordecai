import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Shared L1 world; bootL1 journals both steps for safe restarts. */
export async function bootFrontier({ repoRoot, chainId, bootL1 }) {
  const code = new Uint8Array(readFileSync(join(repoRoot, 'contracts/dist/frontier.wasm')));
  const deployed = await bootL1('frontier-deploy', { kind: 'deploy_contract', code });
  const contract = deployed.returnData;
  const args = new Uint8Array(8);
  new DataView(args.buffer).setBigUint64(0, 144n, true);
  await bootL1('frontier-init', {
    kind: 'execute_contract',
    contract: new Uint8Array(Buffer.from(contract, 'hex')),
    value: 0n,
    action: 'init',
    args,
  });
  return { config: { chainId, contract } };
}
