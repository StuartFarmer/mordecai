/**
 * JSON shapes exchanged over RPC. All u64 values travel as decimal strings,
 * all byte fields as lowercase hex.
 */

export interface HeadInfo {
  chainId: string;
  height: string;
  headHash: string;
  stateRoot: string;
  timestampMs: string;
}

export interface AccountInfo {
  address: string;
  balance: string;
  nonce: string;
}

export interface SubmitTxResult {
  hash: string;
}

export interface BlockHeaderInfo {
  version: number;
  chainId: string;
  height: string;
  prevHash: string;
  timestampMs: string;
  proposer: string;
  txsRoot: string;
  stateRoot: string;
}

export interface BlockInfo {
  hash: string;
  header: BlockHeaderInfo;
  /** Canonical encoded transactions, hex. */
  txs: string[];
}

export interface TxInfo {
  hash: string;
  height: string;
  index: number;
  success: boolean;
  error?: string;
  fee: string;
  /** Contract events, hex. */
  events: string[];
  /** Contract return data, hex. */
  returnData: string;
}

export interface AppInfo {
  appId: string;
  /** Developer address (z32). */
  owner: string;
  /** Hypercore key of the app bundle feed, hex. */
  pearKey: string;
  version: string;
  contractAddress: string;
  metadataHash: string;
}

/** One contract storage entry; the key is contract-internal (hex). */
export interface ContractStateEntry {
  key: string;
  value: string;
}

export type RpcEnvelope<T> = { ok: true; result: T } | { ok: false; error: string };

export const RPC_METHODS = [
  'get_head',
  'get_account',
  'submit_tx',
  'get_block',
  'get_tx',
  'get_contract_state',
] as const;
