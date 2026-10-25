import { expect, test } from 'vitest';
import { loadBrowserWallet } from '../src/browser.js';
import {
  signMicroblogPost,
  verifyMicroblogPost,
  microblogPostId,
  signMicroblogTip,
  verifyMicroblogTip,
  signMicroblogHide,
  verifyMicroblogHide,
  type SignedMicroblogPost,
} from '../src/microblog.js';

const wallet = loadBrowserWallet('11'.repeat(32));
const post = {
  version: 1 as const,
  chainId: 'test',
  feedId: '22'.repeat(32),
  nonce: '33'.repeat(32),
  text: '<b>Hello 🌍</b>',
};
test('post identity authenticates exact text and rejects tampering, extra fields and malformed Unicode', () => {
  const signed = signMicroblogPost(wallet, post);
  expect(verifyMicroblogPost(signed)).toBe(wallet.address);
  expect(microblogPostId(signed)).toMatch(/^[a-f0-9]{64}$/);
  expect(() => verifyMicroblogPost({ ...signed, message: { ...post, text: 'changed' } })).toThrow();
  expect(() => signMicroblogPost(wallet, { ...post, text: '😀'.repeat(281) })).toThrow();
  expect(() => signMicroblogPost(wallet, { ...post, text: '\ud800' })).toThrow();
  expect(() =>
    signMicroblogPost(wallet, { ...post, payout: wallet.address } as typeof post),
  ).toThrow();
});
test('tip signatures bind one feed, post and transaction hash', () => {
  const tip = signMicroblogTip(wallet, {
    version: 1,
    chainId: post.chainId,
    feedId: post.feedId,
    postId: '44'.repeat(32),
    transactionHash: '55'.repeat(32),
  });
  expect(verifyMicroblogTip(tip)).toBe(wallet.address);
  expect(() =>
    verifyMicroblogTip({ ...tip, message: { ...tip.message, postId: '66'.repeat(32) } }),
  ).toThrow();
});
test('author hide proof has a dedicated domain and exact post binding', () => {
  const signed = signMicroblogHide(wallet, {
    version: 1,
    chainId: post.chainId,
    feedId: post.feedId,
    postId: '44'.repeat(32),
  });
  expect(verifyMicroblogHide(signed)).toBe(wallet.address);
  expect(() => verifyMicroblogPost(signed as unknown as SignedMicroblogPost)).toThrow();
});
