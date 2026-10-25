import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeTransaction } from '../../packages/protocol/dist/index.js';
import { encodeAddress } from '../../packages/crypto/dist/index.js';
import { ChessRooms } from '../../packages/gateway/dist/chess-rooms.js';

export async function bootChess({ base, repoRoot, rpc, chainId, bootL1, trustRailwayProxy }) {
  const receipt = await bootL1('chess-wager-v1', {
    kind: 'deploy_contract',
    code: new Uint8Array(readFileSync(join(repoRoot, 'contracts/dist/chess_wager.wasm'))),
  });
  const contract = receipt.returnData;
  if (!/^[a-f0-9]{64}$/.test(contract)) throw new Error('Invalid Chess deployment');
  const rooms = new ChessRooms({
    trustRailwayProxy,
    dir: join(base, 'chess-rooms'),
    chainId,
    contract,
    async getWager(roomId) {
      const entries = await rpc.getContractState(Buffer.from(contract, 'hex'));
      const room = entries.find(
        (e) =>
          e.key ===
          Buffer.concat([Buffer.from('s:Room:'), Buffer.from(roomId, 'hex')]).toString('hex'),
      );
      if (!room) return null;
      const id = Buffer.from(room.value, 'hex').readBigUInt64LE() - 1n;
      if (id < 0n) return null;
      const key = Buffer.alloc(8);
      key.writeBigUInt64LE(id);
      const match = entries.find(
        (e) => e.key === Buffer.concat([Buffer.from('s:Match:'), key]).toString('hex'),
      );
      if (!match) throw new Error('Missing Chess wager');
      const b = Buffer.from(match.value, 'hex');
      let offset = 0;
      const address = () => {
        const a = encodeAddress(b.subarray(offset, offset + 32));
        offset += 32;
        return a;
      };
      const number = () => {
        const n = b.readBigUInt64LE(offset);
        offset += 8;
        return n;
      };
      const bool = () => b[offset++] === 1;
      return {
        matchId: id.toString(),
        creator: address(),
        opponent: address(),
        stake: number().toString(),
        phase: Number(number()),
        creatorReported: bool(),
        opponentReported: bool(),
        creatorPick: address(),
        opponentPick: address(),
        creatorDraw: bool(),
        opponentDraw: bool(),
      };
    },
    async verifyCreate(roomId, envelope) {
      const tx = await rpc.getTx(envelope.message.data);
      if (!tx?.success) throw new Error('Confirmed create receipt required');
      const block = await rpc.getBlock(BigInt(tx.height));
      if (!block?.txs[tx.index]) throw new Error('Create transaction unavailable');
      const signed = decodeTransaction(Buffer.from(block.txs[tx.index], 'hex'));
      const p = signed.payload;
      const args = Buffer.concat([Buffer.from([32, 0, 0, 0]), Buffer.from(roomId, 'hex')]);
      if (
        signed.chainId !== chainId ||
        Buffer.from(signed.sender).toString('hex') !== envelope.publicKey ||
        p.kind !== 'execute_contract' ||
        Buffer.from(p.contract).toString('hex') !== contract ||
        p.action !== 'create_room' ||
        !Buffer.from(p.args).equals(args)
      )
        throw new Error('Create transaction does not bind this room');
    },
  });
  return {
    config: { chainId, contract, roomsApi: '/api/demos/chess/rooms' },
    handleRequest: rooms.handleRequest.bind(rooms),
    close: () => rooms.close(),
  };
}
