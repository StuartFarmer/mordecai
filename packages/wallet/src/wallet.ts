import {
  blake2b256,
  encodeAddress,
  generateMnemonic,
  keyPairFromSeed,
  openSeed,
  sealSeed,
  seedFromMnemonic,
  sign,
  verify,
  type KdfLimits,
  type Keystore,
} from '@hssn/crypto';
import {
  encodeTransaction,
  transactionSigningBytes,
  type Payload,
  type Transaction,
  type UnsignedTransaction,
} from '@hssn/protocol';

export interface NewWallet {
  wallet: Wallet;
  /** Shown once at creation; never stored. */
  mnemonic: string;
}

export interface SignParams {
  chainId: string;
  nonce: bigint;
  maxFee: bigint;
  payload: Payload;
}

export class Wallet {
  readonly publicKey: Uint8Array;
  readonly address: string;
  private readonly secretKey: Uint8Array;
  private readonly seed: Uint8Array;

  private constructor(seed: Uint8Array) {
    const keyPair = keyPairFromSeed(seed);
    this.seed = seed;
    this.publicKey = keyPair.publicKey;
    this.secretKey = keyPair.secretKey;
    this.address = encodeAddress(keyPair.publicKey);
  }

  static create(): NewWallet {
    const mnemonic = generateMnemonic();
    return { wallet: Wallet.fromMnemonic(mnemonic), mnemonic };
  }

  static fromMnemonic(mnemonic: string): Wallet {
    return new Wallet(seedFromMnemonic(mnemonic));
  }

  static fromSeed(seed: Uint8Array): Wallet {
    return new Wallet(new Uint8Array(seed));
  }

  static fromKeystore(keystore: Keystore, passphrase: string): Wallet {
    return new Wallet(openSeed(keystore, passphrase));
  }

  toKeystore(passphrase: string, limits?: KdfLimits): Keystore {
    return sealSeed(this.seed, passphrase, limits);
  }

  signTransaction(params: SignParams): Transaction {
    const unsigned: UnsignedTransaction = {
      chainId: params.chainId,
      nonce: params.nonce,
      sender: this.publicKey,
      maxFee: params.maxFee,
      payload: params.payload,
    };
    return { ...unsigned, signature: sign(transactionSigningBytes(unsigned), this.secretKey) };
  }

  /** Sign arbitrary bytes (application authentication, not transactions). */
  signMessage(message: Uint8Array): Uint8Array {
    return sign(message, this.secretKey);
  }
}

/** Check a transaction's signature against its sender key. */
export function verifyTransactionSignature(tx: Transaction): boolean {
  return verify(tx.signature, transactionSigningBytes(tx), tx.sender);
}

/** Canonical transaction id: BLAKE2b-256 of the full encoded transaction. */
export function transactionHash(tx: Transaction): Uint8Array {
  return blake2b256(encodeTransaction(tx));
}
