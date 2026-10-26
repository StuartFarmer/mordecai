import {
  existsSync,
  mkdirSync,
  readFileSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { decodeAddress } from '@mordecai/crypto';
import { encodeTransaction, decodeTransaction } from '@mordecai/protocol';
import { transactionHash, type Wallet } from '@mordecai/wallet';
import { verifyAccountRegistration } from '@mordecai/wallet/browser';
import type { NodeRpcClient } from '@mordecai/rpc';
import { FaucetError } from './faucet.js';

interface FundingNetwork {
  rpc: Pick<NodeRpcClient, 'getHead' | 'getAccount' | 'submitTx' | 'getTx' | 'waitForTx'>;
  wallet: Wallet;
  amount: bigint;
}
interface Registration {
  grants: { network: string; tx: string; hash: string }[];
  status: 'pending' | 'confirmed' | 'failed';
}
interface State {
  version: 1;
  chainId: string;
  pending: string | null;
  ips: Record<string, number>;
  records: Record<string, Registration>;
}

/** One service owns these funding keys; journal signed transfers before broadcasting. */
export class Accounts {
  private busy = false;
  private journalFailed = false;
  private state: State;
  private readonly path: string;
  constructor(
    dir: string,
    private readonly chainId: string,
    private readonly networks: Record<string, FundingNetwork>,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = join(dir, 'registrations.json');
    this.state = existsSync(this.path)
      ? JSON.parse(readFileSync(this.path, 'utf8'))
      : { version: 1, chainId, pending: null, ips: {}, records: {} };
    if (
      this.state.version !== 1 ||
      this.state.chainId !== chainId ||
      !this.state.records ||
      !this.state.ips ||
      (this.state.pending !== null && !this.state.records[this.state.pending])
    )
      throw new Error('Invalid account registration journal');
    for (const [address, record] of Object.entries(this.state.records)) {
      if (!['pending', 'confirmed', 'failed'].includes(record.status) || !record.grants?.length)
        throw new Error('Invalid account registration record');
      for (const grant of record.grants) {
        const network = networks[grant.network];
        const tx = decodeTransaction(Buffer.from(grant.tx, 'hex'));
        if (
          !network ||
          !Buffer.from(tx.sender).equals(network.wallet.publicKey) ||
          tx.payload.kind !== 'transfer' ||
          !Buffer.from(tx.payload.to).equals(decodeAddress(address)) ||
          tx.payload.amount !== network.amount ||
          Buffer.from(transactionHash(tx)).toString('hex') !== grant.hash
        )
          throw new Error('Account funding configuration changed; migrate the journal explicitly');
      }
    }
  }

  private save() {
    // shortcut: a single JSON journal fits the MVP; use a transactional store before large-scale registration.
    const temp = this.path + '.tmp';
    try {
      const fd = openSync(temp, 'w', 0o600);
      try {
        writeFileSync(fd, JSON.stringify(this.state));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, this.path);
    } catch (error) {
      this.journalFailed = true;
      throw error;
    }
  }

  info(ip: string) {
    const key = createHash('sha256').update(ip).digest('hex');
    return {
      enabled: true,
      amount: '1000000',
      cooldownSeconds: 60,
      retryAfter: Math.max(0, Math.ceil(((this.state.ips[key] ?? 0) - Date.now()) / 1000)),
    };
  }

  status(address: string) {
    const record = this.state.records[address];
    return record
      ? {
          address,
          amount: '1000000',
          status: record.status,
          transactions: record.grants.map(({ network, hash }) => ({ network, hash })),
        }
      : null;
  }

  async register(proof: unknown, ip: string) {
    if (this.journalFailed)
      throw new FaucetError(503, 'Account storage is unavailable. Contact the node operator.');
    let address: string;
    try {
      address = verifyAccountRegistration(proof, this.chainId);
    } catch {
      throw new FaucetError(400, 'Invalid account registration proof.');
    }
    if (this.busy)
      throw new FaucetError(503, 'Account registration is busy. Retry this account shortly.', 1);
    this.busy = true;
    try {
      if (this.state.records[address]) return await this.finish(address);
      const retry = this.info(ip).retryAfter;
      if (retry)
        throw new FaucetError(
          429,
          'Only one new account per minute is allowed from this IP.',
          retry,
        );
      if (this.state.pending) await this.finish(this.state.pending);
      const existing = await this.networks.l1!.rpc.getAccount(address);
      if (BigInt(existing.balance) !== 0n || BigInt(existing.nonce) !== 0n)
        throw new FaucetError(409, 'This account already has network activity. Load it instead.');
      const grants: Registration['grants'] = [];
      for (const [name, network] of Object.entries(this.networks)) {
        const head = await network.rpc.getHead();
        const funds = await network.rpc.getAccount(network.wallet.address);
        if (BigInt(funds.balance) < network.amount + 1000n)
          throw new FaucetError(503, 'New account funding is temporarily unavailable.');
        const tx = network.wallet.signTransaction({
          chainId: head.chainId,
          nonce: BigInt(funds.nonce),
          maxFee: 1000n,
          payload: { kind: 'transfer', to: decodeAddress(address), amount: network.amount },
        });
        grants.push({
          network: name,
          tx: Buffer.from(encodeTransaction(tx)).toString('hex'),
          hash: Buffer.from(transactionHash(tx)).toString('hex'),
        });
      }
      const now = Date.now();
      for (const [key, until] of Object.entries(this.state.ips))
        if (until <= now) delete this.state.ips[key];
      this.state.ips[createHash('sha256').update(ip).digest('hex')] = now + 60000;
      this.state.records[address] = { grants, status: 'pending' };
      this.state.pending = address;
      this.save();
      return await this.finish(address);
    } catch (error) {
      if (error instanceof FaucetError) throw error;
      throw new FaucetError(
        503,
        'Registration is not yet confirmed. Keep your key and retry this same account.',
        1,
      );
    } finally {
      this.busy = false;
    }
  }

  private async finish(address: string) {
    const record = this.state.records[address]!;
    if (record.status === 'failed')
      throw new FaucetError(409, 'Account funding failed. Contact the node operator.');
    if (record.status === 'confirmed') return this.status(address)!;
    for (const grant of record.grants) {
      const { rpc, wallet } = this.networks[grant.network]!;
      let receipt = await rpc.getTx(grant.hash);
      if (!receipt) {
        const bytes = Buffer.from(grant.tx, 'hex');
        const tx = decodeTransaction(bytes);
        if (BigInt((await rpc.getAccount(wallet.address)).nonce) > tx.nonce)
          throw new Error('Funding receipt unavailable');
        if ((await rpc.submitTx(bytes)) !== grant.hash) throw new Error('Unexpected funding hash');
        receipt = await rpc.waitForTx(grant.hash, { timeoutMs: 10000 });
      }
      if (!receipt.success) {
        record.status = 'failed';
        this.state.pending = null;
        this.save();
        throw new FaucetError(409, 'Account funding failed. Contact the node operator.');
      }
    }
    record.status = 'confirmed';
    this.state.pending = null;
    this.save();
    return this.status(address)!;
  }
}
