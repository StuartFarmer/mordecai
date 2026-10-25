import { ed25519 } from '@noble/curves/ed25519';
import { blake2b } from '@noble/hashes/blake2b';
import { browserAddress, type BrowserWallet } from './browser.js';

export interface MicroblogPost {
  version: 1;
  chainId: string;
  feedId: string;
  nonce: string;
  text: string;
}
export interface MicroblogTip {
  version: 1;
  chainId: string;
  feedId: string;
  postId: string;
  transactionHash: string;
}
export interface MicroblogHide {
  version: 1;
  chainId: string;
  feedId: string;
  postId: string;
}
export interface SignedMicroblogPost {
  message: MicroblogPost;
  publicKey: string;
  signature: string;
}
export interface SignedMicroblogTip {
  message: MicroblogTip;
  publicKey: string;
  signature: string;
}
export interface SignedMicroblogHide {
  message: MicroblogHide;
  publicKey: string;
  signature: string;
}
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const bytes = (value: string) => Uint8Array.from(value.match(/../g) ?? [], (b) => parseInt(b, 16));
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function binding(m: MicroblogPost | MicroblogTip | MicroblogHide) {
  if (
    !m ||
    m.version !== 1 ||
    typeof m.chainId !== 'string' ||
    !/^[a-zA-Z0-9_.-]{1,128}$/.test(m.chainId) ||
    !hash(m.feedId)
  )
    throw new Error('Invalid microblog network or feed');
}
export function microblogPostSigningBytes(m: MicroblogPost): Uint8Array {
  binding(m);
  if (
    Object.keys(m).sort().join() !== 'chainId,feedId,nonce,text,version' ||
    !hash(m.nonce) ||
    typeof m.text !== 'string' ||
    !m.text.trim() ||
    [...m.text].length > 280 ||
    new TextEncoder().encode(m.text).length > 2048 ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(m.text)
  )
    throw new Error('Post must contain 1–280 Unicode characters (maximum 2 KiB)');
  return new TextEncoder().encode(
    JSON.stringify(['mordecai/microblog/post/v1', m.chainId, m.feedId, m.nonce, m.text]),
  );
}
export function microblogTipSigningBytes(m: MicroblogTip): Uint8Array {
  binding(m);
  if (
    Object.keys(m).sort().join() !== 'chainId,feedId,postId,transactionHash,version' ||
    !hash(m.postId) ||
    !hash(m.transactionHash)
  )
    throw new Error('Invalid tip attribution');
  return new TextEncoder().encode(
    JSON.stringify(['mordecai/microblog/tip/v1', m.chainId, m.feedId, m.postId, m.transactionHash]),
  );
}
export function signMicroblogPost(
  wallet: BrowserWallet,
  message: MicroblogPost,
): SignedMicroblogPost {
  return {
    message: { ...message },
    publicKey: hex(wallet.publicKey),
    signature: hex(ed25519.sign(microblogPostSigningBytes(message), wallet.seed)),
  };
}
export function signMicroblogTip(wallet: BrowserWallet, message: MicroblogTip): SignedMicroblogTip {
  return {
    message: { ...message },
    publicKey: hex(wallet.publicKey),
    signature: hex(ed25519.sign(microblogTipSigningBytes(message), wallet.seed)),
  };
}
export function microblogHideSigningBytes(m: MicroblogHide): Uint8Array {
  binding(m);
  if (Object.keys(m).sort().join() !== 'chainId,feedId,postId,version' || !hash(m.postId))
    throw new Error('Invalid hide request');
  return new TextEncoder().encode(
    JSON.stringify(['mordecai/microblog/hide/v1', m.chainId, m.feedId, m.postId]),
  );
}
export function signMicroblogHide(
  wallet: BrowserWallet,
  message: MicroblogHide,
): SignedMicroblogHide {
  return {
    message: { ...message },
    publicKey: hex(wallet.publicKey),
    signature: hex(ed25519.sign(microblogHideSigningBytes(message), wallet.seed)),
  };
}
export function verifyMicroblogHide(envelope: SignedMicroblogHide): string {
  return verify(envelope, microblogHideSigningBytes(envelope?.message));
}
function verify(
  envelope: SignedMicroblogPost | SignedMicroblogTip | SignedMicroblogHide,
  signing: Uint8Array,
): string {
  if (
    Object.keys(envelope).sort().join() !== 'message,publicKey,signature' ||
    !hash(envelope.publicKey) ||
    typeof envelope.signature !== 'string' ||
    !/^[a-f0-9]{128}$/.test(envelope.signature) ||
    !ed25519.verify(bytes(envelope.signature), signing, bytes(envelope.publicKey), {
      zip215: false,
    })
  )
    throw new Error('Invalid microblog signature');
  return browserAddress(bytes(envelope.publicKey));
}
export function verifyMicroblogPost(envelope: SignedMicroblogPost): string {
  return verify(envelope, microblogPostSigningBytes(envelope?.message));
}
export function verifyMicroblogTip(envelope: SignedMicroblogTip): string {
  return verify(envelope, microblogTipSigningBytes(envelope?.message));
}
export function microblogPostId(envelope: SignedMicroblogPost): string {
  verifyMicroblogPost(envelope);
  return hex(blake2b(microblogPostSigningBytes(envelope.message), { dkLen: 32 }));
}
