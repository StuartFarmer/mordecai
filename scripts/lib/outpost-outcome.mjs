const utf8 = (s) => new TextEncoder().encode(s);
const bytes = (v) => Buffer.from(typeof v === 'string' ? Buffer.from(v, 'hex') : v);
function record(value, delivery) {
  const b = bytes(value);
  const offset = delivery ? 32 : 0;
  const length = b.readUInt32LE(offset + 32);
  return {
    buyer: b.subarray(offset, offset + 32),
    good: b.subarray(offset + 36, offset + 36 + length),
    amount: b.readBigUInt64LE(offset + 36 + length),
    ...(delivery ? {} : { phase: b.readBigUInt64LE(offset + 52 + length) }),
  };
}
export function selectSettlement(deliveries, orders, market) {
  const byId = new Map(
    orders.map(({ key, value }) => [bytes(key).readBigUInt64LE(8), record(value, false)]),
  );
  for (const [key, value] of [...deliveries].sort(([a], [b]) =>
    Buffer.compare(bytes(a), bytes(b)),
  )) {
    const id = bytes(key).readBigUInt64LE(11);
    const order = byId.get(id);
    const delivery = record(value, true);
    if (
      !order ||
      order.phase !== 0n ||
      !order.buyer.equals(delivery.buyer) ||
      !order.good.equals(delivery.good) ||
      order.amount !== delivery.amount
    )
      continue;
    const args = Buffer.alloc(44);
    args.writeBigUInt64LE(id);
    args.writeUInt32LE(32, 8);
    bytes(value).copy(args, 12, 0, 32);
    return { contract: market, action: 'settle', args: new Uint8Array(args) };
  }
  return null;
}
export function outpostOutcome(rpc, market, outpost) {
  return async (chain) =>
    selectSettlement(
      await chain.getContractState(outpost, utf8('s:Delivery:')),
      await rpc.getContractState(market, utf8('s:Order:')),
      market,
    );
}
