import type { Block, BlockHeader, Transaction, Vote } from '../src/index.js';
import { PROTOCOL_VERSION } from '../src/index.js';

export const CHAIN_ID = 'mordecai-dev-1';

/** Deterministic filler bytes so fixtures (and golden vectors) are reproducible. */
export function fill(size: number, byte: number): Uint8Array {
  return new Uint8Array(size).fill(byte);
}

export function transferTx(): Transaction {
  return {
    chainId: CHAIN_ID,
    nonce: 7n,
    sender: fill(32, 0x11),
    maxFee: 1_000n,
    payload: { kind: 'transfer', to: fill(32, 0x22), amount: 123_456_789n },
    signature: fill(64, 0x33),
  };
}

export function deployTx(): Transaction {
  return {
    chainId: CHAIN_ID,
    nonce: 0n,
    sender: fill(32, 0x44),
    maxFee: 50_000n,
    payload: {
      kind: 'deploy_contract',
      code: Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]),
    },
    signature: fill(64, 0x55),
  };
}

export function executeTx(): Transaction {
  return {
    chainId: CHAIN_ID,
    nonce: 42n,
    sender: fill(32, 0x66),
    maxFee: 9_999n,
    payload: {
      kind: 'execute_contract',
      contract: fill(32, 0x77),
      value: 5_000n,
      action: 'buy',
      args: Uint8Array.from([1, 2, 3, 4]),
    },
    signature: fill(64, 0x88),
  };
}

export function registerAppTx(): Transaction {
  return {
    chainId: CHAIN_ID,
    nonce: 1n,
    sender: fill(32, 0x99),
    maxFee: 2_500n,
    payload: {
      kind: 'register_app',
      appId: 'com.example.chess',
      pearKey: fill(32, 0xaa),
      version: '1.0.0',
      contractAddress: fill(32, 0x00),
      metadataHash: fill(32, 0xbb),
      chainValidators: [fill(32, 0xa1), fill(32, 0xa2)],
    },
    signature: fill(64, 0xcc),
  };
}

export function updateAppTx(): Transaction {
  const base = registerAppTx();
  return {
    ...base,
    nonce: 2n,
    payload: { ...base.payload, kind: 'update_app', version: '1.1.0' } as Transaction['payload'],
  };
}

export function anchorTx(): Transaction {
  return {
    chainId: CHAIN_ID,
    nonce: 3n,
    sender: fill(32, 0x12),
    maxFee: 7_500n,
    payload: {
      kind: 'anchor',
      appId: 'com.example.chess',
      epoch: 4n,
      appHeight: 1_024n,
      stateRoot: fill(32, 0x5a),
      call: {
        contract: fill(32, 0x6b),
        action: 'payout',
        args: Uint8Array.from([9, 8, 7]),
      },
      signatures: [
        { validator: fill(32, 0xa1), signature: fill(64, 0xb1) },
        { validator: fill(32, 0xa2), signature: fill(64, 0xb2) },
      ],
    },
    signature: fill(64, 0x13),
  };
}

export function anchorTxNoCall(): Transaction {
  const base = anchorTx();
  const { call: _call, ...payload } = base.payload as Extract<
    Transaction['payload'],
    { kind: 'anchor' }
  >;
  return { ...base, payload };
}

export function header(): BlockHeader {
  return {
    version: PROTOCOL_VERSION,
    chainId: CHAIN_ID,
    height: 100n,
    prevHash: fill(32, 0xdd),
    timestampMs: 1_700_000_000_000n,
    proposer: fill(32, 0xee),
    txsRoot: fill(32, 0x01),
    stateRoot: fill(32, 0x02),
  };
}

export function block(): Block {
  return {
    header: header(),
    txs: [transferTx(), executeTx()],
    proposerSignature: fill(64, 0xff),
  };
}

export function vote(): Vote {
  return {
    chainId: CHAIN_ID,
    height: 100n,
    round: 0,
    blockHash: fill(32, 0x03),
    validator: fill(32, 0x04),
    signature: fill(64, 0x05),
  };
}
