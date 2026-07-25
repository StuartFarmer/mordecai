import { decodeAddress } from '@mordecai/crypto';
import { ContractArgs, type Mordecai } from '@mordecai/sdk';
import type { TxInfo } from '@mordecai/rpc';

/**
 * Client for the ChessWager escrow contract
 * (compiler/examples/chess_wager.pysc — written in the DSL). Stakes ride
 * as attached value; the pot pays out when both players report the same
 * winner. Match ids are sequential (Meta[0].next_id).
 */
export class WagerClient {
  constructor(
    private readonly app: Mordecai,
    private readonly contract: Uint8Array,
  ) {}

  /** Open a match, escrowing `stake`. Returns the receipt (id = creation order). */
  create(stake: bigint): Promise<TxInfo> {
    return this.app.execute(this.contract, 'create', new Uint8Array(0), stake);
  }

  join(matchId: bigint, stake: bigint): Promise<TxInfo> {
    return this.app.execute(this.contract, 'join', new ContractArgs().u64(matchId).encode(), stake);
  }

  report(matchId: bigint, winner: string | Uint8Array): Promise<TxInfo> {
    const key = typeof winner === 'string' ? decodeAddress(winner) : winner;
    return this.app.execute(
      this.contract,
      'report',
      new ContractArgs().u64(matchId).address(key).encode(),
    );
  }

  cancel(matchId: bigint): Promise<TxInfo> {
    return this.app.execute(this.contract, 'cancel', new ContractArgs().u64(matchId).encode());
  }
}
