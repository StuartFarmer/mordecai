export async function persistAndSubmitTip({
  player,
  prepared,
  config,
  postId,
  current,
  request,
  onSubmitting = () => {},
}) {
  current();
  const envelope = await player.signMicroblogTip({
    version: 1,
    chainId: config.chainId,
    feedId: config.feedId,
    postId,
    transactionHash: prepared.hash,
  });
  current();
  await request(`${config.api}/tips`, { envelope, tx: prepared.hex });
  current();
  onSubmitting();
  return player.submitMicroblogTip(prepared);
}
