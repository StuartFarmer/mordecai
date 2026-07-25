import { blake2b256, verify } from '@mordecai/crypto';
import {
  DOMAIN_APP_SENDER,
  MAX_APP_VALIDATORS,
  Reader,
  Writer,
  anchorSigningBytes,
  encodeTransaction,
  type AnchorPayload,
  type Transaction,
} from '@mordecai/protocol';
import { Overlay, type StateReader } from '@mordecai/state';
import {
  EXEC_OK,
  VALIDATE_OK,
  VmHostError,
  VmRuntime,
  validationError,
  type VmHost,
} from '@mordecai/vm';
import {
  EMPTY_ACCOUNT,
  accountKey,
  decodeAccount,
  encodeAccount,
  type Account,
} from './account.js';
import { transactionHash, verifyTransactionSignature } from './tx.js';

// ------------------------------------------------------------------- fees

/** Flat fee plus per-byte charge (plan D7). */
export const FLAT_FEE = 10n;
export const FEE_PER_BYTE = 1n;
/** Fuel units bought per fee unit. */
export const FUEL_PER_FEE = 100n;
/** Hard per-transaction execution budget regardless of maxFee. */
export const MAX_FUEL = 10_000_000n;
export const MAX_CALL_DEPTH = 4;
export const MAX_EVENTS = 64;

/** The state-independent part of the fee, charged on every included tx. */
export function computeFee(tx: Transaction): bigint {
  return FLAT_FEE + FEE_PER_BYTE * BigInt(encodeTransaction(tx).length);
}

export interface Receipt {
  txHash: Uint8Array;
  success: boolean;
  /** Present when success is false. */
  error?: string;
  fee: bigint;
  /** Contract events (success only). */
  events: Uint8Array[];
  /** Contract return data (success only). */
  returnData: Uint8Array;
}

export type InclusionError = string;

// ------------------------------------------------------------ state layout

const CODE_PREFIX = new TextEncoder().encode('cc:');
const STORAGE_PREFIX = new TextEncoder().encode('cs:');

export function contractCodeKey(contractId: Uint8Array): Uint8Array {
  const key = new Uint8Array(CODE_PREFIX.length + 32);
  key.set(CODE_PREFIX);
  key.set(contractId, CODE_PREFIX.length);
  return key;
}

export function contractStorageKey(contractId: Uint8Array, inner: Uint8Array): Uint8Array {
  const key = new Uint8Array(STORAGE_PREFIX.length + 32 + 1 + inner.length);
  key.set(STORAGE_PREFIX);
  key.set(contractId, STORAGE_PREFIX.length);
  key[STORAGE_PREFIX.length + 32] = 0x3a; // ':'
  key.set(inner, STORAGE_PREFIX.length + 33);
  return key;
}

/** Deterministic contract id: H(domain ‖ sender ‖ nonce ‖ code). */
export function contractIdFor(sender: Uint8Array, nonce: bigint, code: Uint8Array): Uint8Array {
  const nonceBytes = new Uint8Array(8);
  new DataView(nonceBytes.buffer).setBigUint64(0, nonce, true);
  return blake2b256(new TextEncoder().encode('mordecai:contract:v1'), sender, nonceBytes, code);
}

/**
 * The account address an app's anchored outcome calls execute under
 * (app-chains spec §2.1). A hash with no known private key: only an
 * anchor quorum can act as this sender.
 */
export function appAddress(appId: string): Uint8Array {
  return blake2b256(new TextEncoder().encode(DOMAIN_APP_SENDER), new TextEncoder().encode(appId));
}

// ------------------------------------------------------- app registry (§17)

const APP_PREFIX = new TextEncoder().encode('app:');

export function appKey(appId: string): Uint8Array {
  const id = new TextEncoder().encode(appId);
  const key = new Uint8Array(APP_PREFIX.length + id.length);
  key.set(APP_PREFIX);
  key.set(id, APP_PREFIX.length);
  return key;
}

/** On-chain registry entry; `owner` is the developer key that registered it. */
export interface AppEntry {
  owner: Uint8Array;
  pearKey: Uint8Array;
  version: string;
  contractAddress: Uint8Array;
  metadataHash: Uint8Array;
  /** App-chain validator set whose quorum L1 accepts anchors from; empty = no chain. */
  chainValidators: Uint8Array[];
}

export function encodeAppEntry(entry: AppEntry): Uint8Array {
  const w = new Writer(160);
  w.fixed(entry.owner, 32);
  w.fixed(entry.pearKey, 32);
  w.string(entry.version, 32);
  w.fixed(entry.contractAddress, 32);
  w.fixed(entry.metadataHash, 32);
  w.array(entry.chainValidators, MAX_APP_VALIDATORS, (w, v) => w.fixed(v, 32));
  return w.finish();
}

export function decodeAppEntry(bytes: Uint8Array): AppEntry {
  const r = new Reader(bytes);
  const entry: AppEntry = {
    owner: r.fixed(32),
    pearKey: r.fixed(32),
    version: r.string(32),
    contractAddress: r.fixed(32),
    metadataHash: r.fixed(32),
    chainValidators: r.array(MAX_APP_VALIDATORS, (r) => r.fixed(32)),
  };
  r.finish();
  return entry;
}

// ------------------------------------------------------ app-chain anchors

const ANCHOR_PREFIX = new TextEncoder().encode('an:');

export function anchorKey(appId: string): Uint8Array {
  const id = new TextEncoder().encode(appId);
  const key = new Uint8Array(ANCHOR_PREFIX.length + id.length);
  key.set(ANCHOR_PREFIX);
  key.set(id, ANCHOR_PREFIX.length);
  return key;
}

/** The last accepted anchor for an app (app-chains spec §2.3 step 4). */
export interface AnchorRecord {
  epoch: bigint;
  appHeight: bigint;
  stateRoot: Uint8Array;
}

export function encodeAnchorRecord(record: AnchorRecord): Uint8Array {
  const w = new Writer(48);
  w.u64(record.epoch);
  w.u64(record.appHeight);
  w.fixed(record.stateRoot, 32);
  return w.finish();
}

export function decodeAnchorRecord(bytes: Uint8Array): AnchorRecord {
  const r = new Reader(bytes);
  const record: AnchorRecord = {
    epoch: r.u64(),
    appHeight: r.u64(),
    stateRoot: r.fixed(32),
  };
  r.finish();
  return record;
}

/** Quorum threshold over a validator set: strictly more than 2/3. */
export function anchorQuorum(validatorCount: number): number {
  return Math.floor((2 * validatorCount) / 3) + 1;
}

/**
 * Verify an anchor's attestation against a validator set: distinct known
 * signers, each signature valid over `anchorSigningBytes`, quorum met.
 * Returns null when valid, an error string otherwise.
 */
export function verifyAnchorSignatures(
  l1ChainId: string,
  payload: AnchorPayload,
  validators: Uint8Array[],
): string | null {
  if (validators.length === 0) return 'app has no registered chain validators';
  const message = anchorSigningBytes(l1ChainId, payload);
  const seen = new Set<string>();
  let valid = 0;
  for (const { validator, signature } of payload.signatures) {
    const hex = Buffer.from(validator).toString('hex');
    if (seen.has(hex)) return 'duplicate anchor signer';
    seen.add(hex);
    if (!validators.some((v) => Buffer.compare(v, validator) === 0)) {
      return 'anchor signer is not a registered validator';
    }
    if (!verify(signature, message, validator)) return 'invalid anchor signature';
    valid++;
  }
  const needed = anchorQuorum(validators.length);
  if (valid < needed) {
    return `anchor quorum not met: ${valid} of ${validators.length} (need ${needed})`;
  }
  return null;
}

// -------------------------------------------------------------- accounts

async function getAccount(state: StateReader, publicKey: Uint8Array): Promise<Account> {
  const raw = await state.get(accountKey(publicKey));
  return raw ? decodeAccount(raw) : { ...EMPTY_ACCOUNT };
}

function getAccountSync(state: StateReader, publicKey: Uint8Array): Account {
  const raw = state.getSync(accountKey(publicKey));
  return raw ? decodeAccount(raw) : { ...EMPTY_ACCOUNT };
}

function setAccount(overlay: Overlay, publicKey: Uint8Array, account: Account): void {
  overlay.set(accountKey(publicKey), encodeAccount(account));
}

// -------------------------------------------------------------- admission

/** Checks that don't depend on state: signature and chain binding. */
export function checkStateless(tx: Transaction, chainId: string): InclusionError | null {
  if (tx.chainId !== chainId) return `wrong chain id: ${tx.chainId}`;
  if (!verifyTransactionSignature(tx)) return 'invalid signature';
  if (computeFee(tx) > tx.maxFee) return 'maxFee below required fee';
  return null;
}

/** Funds a tx must provably hold at inclusion (fee reserve + attached value). */
export function requiredBalance(tx: Transaction): bigint {
  switch (tx.payload.kind) {
    case 'transfer':
      return computeFee(tx);
    case 'execute_contract':
      return tx.maxFee + tx.payload.value;
    default:
      return tx.maxFee;
  }
}

/** State-dependent inclusion checks at the transaction's execution point. */
export async function checkInclusion(
  state: StateReader,
  tx: Transaction,
  chainId: string,
): Promise<InclusionError | null> {
  const stateless = checkStateless(tx, chainId);
  if (stateless) return stateless;
  switch (tx.payload.kind) {
    case 'transfer':
    case 'execute_contract':
      break;
    case 'deploy_contract': {
      const status = VmRuntime.validate(tx.payload.code);
      if (status !== VALIDATE_OK) return `invalid contract: ${validationError(status)}`;
      break;
    }
    case 'register_app':
    case 'update_app':
      if (tx.payload.appId.length === 0) return 'empty app id';
      break;
    case 'anchor':
      // Cheap gates only; signature verification happens in execution so
      // mempool admission stays O(bytes).
      if (tx.payload.appId.length === 0) return 'empty app id';
      if (tx.payload.signatures.length === 0) return 'anchor carries no signatures';
      break;
  }
  const sender = await getAccount(state, tx.sender);
  if (tx.nonce !== sender.nonce) {
    return `nonce mismatch: tx ${tx.nonce}, account ${sender.nonce}`;
  }
  if (sender.balance < requiredBalance(tx)) return 'balance cannot cover fee reserve';
  return null;
}

// -------------------------------------------------------------- execution

interface ExecCtx {
  events: Uint8Array[];
  returnData: Uint8Array;
  meter: { used: bigint; budget: bigint };
}

function charge(ctx: ExecCtx, amount: bigint): void {
  ctx.meter.used += amount;
  if (ctx.meter.used > ctx.meter.budget) {
    throw new VmHostError('out of fuel (host ops)', true);
  }
}

/**
 * Execute one includable transaction against `blockOverlay`.
 * Nonce and the actual fee always apply; payload effects revert as a unit.
 */
export async function applyTransaction(
  blockOverlay: Overlay,
  tx: Transaction,
  proposer: Uint8Array,
  height: bigint,
  timeMs: bigint,
): Promise<Receipt> {
  const staticFee = computeFee(tx);
  const feeReserve = tx.payload.kind === 'transfer' ? staticFee : tx.maxFee;
  const txHash = transactionHash(tx);

  // Nonce + fee reserve come out first so the payload can't spend them.
  const sender = await getAccount(blockOverlay, tx.sender);
  setAccount(blockOverlay, tx.sender, {
    balance: sender.balance - feeReserve,
    nonce: sender.nonce + 1n,
  });

  const budget =
    tx.payload.kind === 'transfer' ? 0n : minBig(MAX_FUEL, (tx.maxFee - staticFee) * FUEL_PER_FEE);
  const ctx: ExecCtx = {
    events: [],
    returnData: new Uint8Array(0),
    meter: { used: 0n, budget },
  };

  // Payload effects revert as a unit on failure.
  const txOverlay = new Overlay(blockOverlay);
  const outcome = executePayload(txOverlay, tx, ctx, height, timeMs);

  const fuelUsed = outcome.fuelUsed + ctx.meter.used;
  const actualFee = minBig(tx.maxFee, staticFee + ceilDiv(fuelUsed, FUEL_PER_FEE));

  if (outcome.error === null) txOverlay.commitInto(blockOverlay);

  // Refund the unused reserve, pay the proposer.
  const senderAfter = await getAccount(blockOverlay, tx.sender);
  setAccount(blockOverlay, tx.sender, {
    ...senderAfter,
    balance: senderAfter.balance + (feeReserve - actualFee),
  });
  const proposerAccount = await getAccount(blockOverlay, proposer);
  setAccount(blockOverlay, proposer, {
    ...proposerAccount,
    balance: proposerAccount.balance + actualFee,
  });

  if (outcome.error !== null) {
    return {
      txHash,
      success: false,
      error: outcome.error,
      fee: actualFee,
      events: [],
      returnData: new Uint8Array(0),
    };
  }
  return {
    txHash,
    success: true,
    fee: actualFee,
    events: ctx.events,
    returnData: ctx.returnData,
  };
}

function executePayload(
  overlay: Overlay,
  tx: Transaction,
  ctx: ExecCtx,
  height: bigint,
  timeMs: bigint,
): { error: string | null; fuelUsed: bigint } {
  switch (tx.payload.kind) {
    case 'transfer': {
      const { to, amount } = tx.payload;
      const sender = getAccountSync(overlay, tx.sender);
      if (sender.balance < amount) {
        return {
          error: `insufficient balance: have ${sender.balance}, need ${amount}`,
          fuelUsed: 0n,
        };
      }
      setAccount(overlay, tx.sender, { ...sender, balance: sender.balance - amount });
      const recipient = getAccountSync(overlay, to);
      setAccount(overlay, to, { ...recipient, balance: recipient.balance + amount });
      return { error: null, fuelUsed: 0n };
    }
    case 'deploy_contract': {
      const contractId = contractIdFor(tx.sender, tx.nonce, tx.payload.code);
      if (overlay.getSync(contractCodeKey(contractId)) !== undefined) {
        return { error: 'contract already exists', fuelUsed: 0n };
      }
      overlay.set(contractCodeKey(contractId), tx.payload.code);
      ctx.returnData = contractId;
      return { error: null, fuelUsed: 0n };
    }
    case 'execute_contract': {
      try {
        return runContract(overlay, ctx, {
          contractId: tx.payload.contract,
          caller: tx.sender,
          action: tx.payload.action,
          args: tx.payload.args,
          value: tx.payload.value,
          height,
          timeMs,
          fuel: ctx.meter.budget,
          depth: 0,
        });
      } catch (err) {
        if (err instanceof VmHostError && err.outOfFuel) {
          return { error: 'out of fuel', fuelUsed: ctx.meter.budget };
        }
        throw err;
      }
    }
    case 'register_app': {
      const key = appKey(tx.payload.appId);
      if (overlay.getSync(key) !== undefined) {
        return { error: `app already registered: ${tx.payload.appId}`, fuelUsed: 0n };
      }
      overlay.set(
        key,
        encodeAppEntry({
          owner: tx.sender,
          pearKey: tx.payload.pearKey,
          version: tx.payload.version,
          contractAddress: tx.payload.contractAddress,
          metadataHash: tx.payload.metadataHash,
          chainValidators: tx.payload.chainValidators,
        }),
      );
      ctx.events.push(new TextEncoder().encode(`app:registered:${tx.payload.appId}`));
      return { error: null, fuelUsed: 0n };
    }
    case 'update_app': {
      const key = appKey(tx.payload.appId);
      const existing = overlay.getSync(key);
      if (existing === undefined) {
        return { error: `no such app: ${tx.payload.appId}`, fuelUsed: 0n };
      }
      const entry = decodeAppEntry(existing);
      if (Buffer.compare(entry.owner, tx.sender) !== 0) {
        return { error: 'only the registering key may update an app', fuelUsed: 0n };
      }
      overlay.set(
        key,
        encodeAppEntry({
          owner: entry.owner,
          pearKey: tx.payload.pearKey,
          version: tx.payload.version,
          contractAddress: tx.payload.contractAddress,
          metadataHash: tx.payload.metadataHash,
          chainValidators: tx.payload.chainValidators,
        }),
      );
      ctx.events.push(new TextEncoder().encode(`app:updated:${tx.payload.appId}`));
      return { error: null, fuelUsed: 0n };
    }
    case 'anchor': {
      const payload = tx.payload;
      const raw = overlay.getSync(appKey(payload.appId));
      if (raw === undefined) {
        return { error: `no such app: ${payload.appId}`, fuelUsed: 0n };
      }
      const entry = decodeAppEntry(raw);

      const key = anchorKey(payload.appId);
      const prevRaw = overlay.getSync(key);
      const prevEpoch = prevRaw === undefined ? 0n : decodeAnchorRecord(prevRaw).epoch;
      if (payload.epoch <= prevEpoch) {
        return {
          error: `stale anchor epoch: ${payload.epoch} (last anchored ${prevEpoch})`,
          fuelUsed: 0n,
        };
      }

      const sigError = verifyAnchorSignatures(tx.chainId, payload, entry.chainValidators);
      if (sigError !== null) return { error: sigError, fuelUsed: 0n };

      // The outcome call runs as the app; a failed call fails the whole
      // payload so the epoch is not consumed by a bad outcome.
      if (payload.call) {
        const result = (() => {
          try {
            return runContract(overlay, ctx, {
              contractId: payload.call.contract,
              caller: appAddress(payload.appId),
              action: payload.call.action,
              args: payload.call.args,
              value: 0n,
              height,
              timeMs,
              fuel: ctx.meter.budget,
              depth: 0,
            });
          } catch (err) {
            if (err instanceof VmHostError && err.outOfFuel) {
              return { error: 'out of fuel', fuelUsed: ctx.meter.budget };
            }
            throw err;
          }
        })();
        if (result.error !== null) {
          return {
            error: `anchor outcome call failed: ${result.error}`,
            fuelUsed: result.fuelUsed,
          };
        }
        overlay.set(
          key,
          encodeAnchorRecord({
            epoch: payload.epoch,
            appHeight: payload.appHeight,
            stateRoot: payload.stateRoot,
          }),
        );
        ctx.events.push(new TextEncoder().encode(`anchor:${payload.appId}:${payload.epoch}`));
        return { error: null, fuelUsed: result.fuelUsed };
      }

      overlay.set(
        key,
        encodeAnchorRecord({
          epoch: payload.epoch,
          appHeight: payload.appHeight,
          stateRoot: payload.stateRoot,
        }),
      );
      ctx.events.push(new TextEncoder().encode(`anchor:${payload.appId}:${payload.epoch}`));
      return { error: null, fuelUsed: 0n };
    }
  }
}

interface CallParams {
  contractId: Uint8Array;
  caller: Uint8Array;
  action: string;
  args: Uint8Array;
  value: bigint;
  height: bigint;
  timeMs: bigint;
  fuel: bigint;
  depth: number;
}

function runContract(
  overlay: Overlay,
  ctx: ExecCtx,
  params: CallParams,
): { error: string | null; fuelUsed: bigint } {
  const code = overlay.getSync(contractCodeKey(params.contractId));
  if (code === undefined) return { error: 'no such contract', fuelUsed: 0n };

  // Attach value: caller pays the contract before the action runs.
  if (params.value > 0n) {
    const caller = getAccountSync(overlay, params.caller);
    if (caller.balance < params.value) {
      return { error: 'insufficient balance for attached value', fuelUsed: 0n };
    }
    setAccount(overlay, params.caller, { ...caller, balance: caller.balance - params.value });
    const contract = getAccountSync(overlay, params.contractId);
    setAccount(overlay, params.contractId, {
      ...contract,
      balance: contract.balance + params.value,
    });
  }

  const host: VmHost = {
    storageGet: (key) => {
      charge(ctx, 200n + BigInt(key.length));
      return overlay.getSync(contractStorageKey(params.contractId, key));
    },
    storageSet: (key, value) => {
      charge(ctx, 500n + 5n * BigInt(key.length + value.length));
      overlay.set(contractStorageKey(params.contractId, key), value);
    },
    storageDelete: (key) => {
      charge(ctx, 500n);
      overlay.delete(contractStorageKey(params.contractId, key));
    },
    transfer: (to, amount) => {
      charge(ctx, 1_000n);
      const from = getAccountSync(overlay, params.contractId);
      if (from.balance < amount) return false;
      setAccount(overlay, params.contractId, { ...from, balance: from.balance - amount });
      const recipient = getAccountSync(overlay, to);
      setAccount(overlay, to, { ...recipient, balance: recipient.balance + amount });
      return true;
    },
    emit: (event) => {
      charge(ctx, 100n + BigInt(event.length));
      if (ctx.events.length >= MAX_EVENTS) {
        throw new VmHostError('too many events', true);
      }
      ctx.events.push(event);
    },
    call: (contract, actionBytes, args, value, fuelRemaining) => {
      charge(ctx, 2_000n);
      if (params.depth + 1 > MAX_CALL_DEPTH) return -9n;
      const sub = new Overlay(overlay);
      const result = runContract(sub, ctx, {
        contractId: contract,
        caller: params.contractId,
        action: new TextDecoder().decode(actionBytes),
        args,
        value,
        height: params.height,
        timeMs: params.timeMs,
        fuel: fuelRemaining,
        depth: params.depth + 1,
      });
      if (result.error !== null) return -8n;
      sub.commitInto(overlay);
      return result.fuelUsed;
    },
  };

  const result = VmRuntime.execute({
    code,
    action: params.action,
    args: params.args,
    caller: params.caller,
    value: params.value,
    height: params.height,
    timeMs: params.timeMs,
    fuel: params.fuel,
    host,
  });
  if (result.status !== EXEC_OK) {
    return {
      error: result.error === '' ? `execution failed (${result.status})` : result.error,
      fuelUsed: result.fuelUsed,
    };
  }
  if (params.depth === 0) ctx.returnData = result.returnData;
  return { error: null, fuelUsed: result.fuelUsed };
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}
