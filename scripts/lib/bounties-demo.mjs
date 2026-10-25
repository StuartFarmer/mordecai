import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export async function bootBounties({ repoRoot, chainId, bootL1 }) {
  const code = new Uint8Array(
    readFileSync(join(repoRoot, 'contracts/dist/information_bounties.wasm')),
  );
  const deployed = await bootL1('bounties-deploy', { kind: 'deploy_contract', code });
  return { config: { chainId, contract: deployed.returnData, awardWindow: 100 } };
}
