import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  generateSeed,
  keyPairFromSeed,
  encodeAddress,
  sign,
} from '../../packages/crypto/dist/index.js';
import {
  decodeTransaction,
  encodeTransaction,
  transactionSigningBytes,
} from '../../packages/protocol/dist/index.js';
import { transactionHash } from '../../packages/wallet/dist/index.js';

const ROLES = [
  'validator-0',
  'validator-1',
  'validator-2',
  'host-a',
  'host-b',
  'relayer',
  'faucet',
  'web-faucet',
  'app-faucet',
];

export function loadDemoIdentity(dir, chainId, timeoutMs) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'identity.json');
  if (!existsSync(path)) {
    const seeds = Object.fromEntries(
      ROLES.map((role) => [role, Buffer.from(generateSeed()).toString('hex')]),
    );
    writeFileSync(
      path,
      JSON.stringify({ version: 1, chainId, timeoutMs: String(timeoutMs), seeds }),
      { flag: 'wx', mode: 0o600 },
    );
  }
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  if (saved.version !== 1 || saved.chainId !== chainId || saved.timeoutMs !== String(timeoutMs))
    throw new Error(
      'Demo identity/configuration mismatch; reuse the original chain and timeout settings.',
    );
  for (const role of ROLES)
    if (!/^[a-f0-9]{64}$/.test(saved.seeds?.[role]))
      throw new Error(`Invalid persisted demo identity: ${role}`);
  return {
    key: (role) => keyPairFromSeed(new Uint8Array(Buffer.from(saved.seeds[role], 'hex'))),
    seed: (role) => new Uint8Array(Buffer.from(saved.seeds[role], 'hex')),
  };
}

/** Journal signed bytes before admission, so interrupted startup cannot deploy twice. */
export async function bootstrapTransaction(dir, step, rpc, chainId, who, payload) {
  const journal = join(dir, 'deployments');
  mkdirSync(journal, { recursive: true, mode: 0o700 });
  const path = join(journal, `${step}.json`);
  let tx;
  if (existsSync(path)) {
    tx = decodeTransaction(Buffer.from(JSON.parse(readFileSync(path, 'utf8')).tx, 'hex'));
    const expected = { chainId, sender: who.publicKey, nonce: tx.nonce, maxFee: 500_000n, payload };
    if (
      !Buffer.from(transactionSigningBytes(tx)).equals(
        Buffer.from(transactionSigningBytes(expected)),
      )
    )
      throw new Error(
        `Bootstrap step ${step} changed; use the original contracts/configuration or migrate explicitly.`,
      );
  } else {
    const account = await rpc.getAccount(encodeAddress(who.publicKey));
    const unsigned = {
      chainId,
      sender: who.publicKey,
      nonce: BigInt(account.nonce),
      maxFee: 500_000n,
      payload,
    };
    tx = { ...unsigned, signature: sign(transactionSigningBytes(unsigned), who.secretKey) };
    writeFileSync(
      path,
      JSON.stringify({ tx: Buffer.from(encodeTransaction(tx)).toString('hex') }),
      { flag: 'wx', mode: 0o600 },
    );
  }
  const bytes = encodeTransaction(tx);
  const hash = Buffer.from(transactionHash(tx)).toString('hex');
  let receipt = await rpc.getTx(hash);
  if (!receipt) {
    const account = await rpc.getAccount(encodeAddress(who.publicKey));
    if (BigInt(account.nonce) > tx.nonce)
      throw new Error(`Bootstrap receipt unavailable for ${step}: ${hash}`);
    const returned = await rpc.submitTx(bytes);
    if (returned !== hash) throw new Error(`Unexpected transaction hash for ${step}`);
    receipt = await rpc.waitForTx(hash, { timeoutMs: 30_000 });
  }
  if (!receipt.success) throw new Error(`Bootstrap ${step} failed: ${receipt.error}`);
  return receipt;
}
