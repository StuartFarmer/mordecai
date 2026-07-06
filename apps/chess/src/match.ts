import type { Feed } from '@hssn/networking';
import type { Hssn } from '@hssn/sdk';

/**
 * A p2p chess match: each player owns one append-only move feed (signed,
 * replicated directly between the players — spec §15: the game never
 * touches the chain). The host plays white. Moves interleave by ply:
 * white's feed holds plies 0,2,4…, black's 1,3,5….
 *
 * Move *legality* is the UI layer's job (both clients validate; the
 * signed feeds are the authoritative record for dispute evidence).
 */
export class ChessMatch {
  private constructor(
    private readonly mine: Feed,
    private readonly theirs: Feed,
    readonly white: boolean,
  ) {}

  /** Host a match (plays white). Share `feedKey` with the opponent. */
  static async host(app: Hssn, matchName: string): Promise<ChessMatch> {
    const mine = await app.createFeed(`chess:${matchName}:white`);
    await app.joinFeed(mine);
    return new ChessMatch(mine, undefined as never, true);
  }

  /** The host learns the guest's feed key out of band (or via a lobby feed). */
  async acceptOpponent(app: Hssn, guestFeedKey: Uint8Array): Promise<ChessMatch> {
    const theirs = await app.openFeed(guestFeedKey);
    return new ChessMatch(this.mine, theirs, this.white);
  }

  /** Join a hosted match (plays black). */
  static async join(app: Hssn, matchName: string, hostFeedKey: Uint8Array): Promise<ChessMatch> {
    const mine = await app.createFeed(`chess:${matchName}:black`);
    await app.joinFeed(mine);
    const theirs = await app.openFeed(hostFeedKey);
    await app.joinFeed(theirs);
    return new ChessMatch(mine, theirs, false);
  }

  get feedKey(): Uint8Array {
    return this.mine.key;
  }

  /** Total plies played (both sides). */
  get plies(): number {
    return this.mine.length + (this.theirs?.length ?? 0);
  }

  get myTurn(): boolean {
    return this.white
      ? this.mine.length === this.theirs.length
      : this.theirs.length > this.mine.length;
  }

  async move(san: string): Promise<void> {
    if (!this.myTurn) throw new Error('not your turn');
    await this.mine.append(san);
  }

  /** Wait until the opponent's reply for the given ply count arrives. */
  async waitForOpponent(): Promise<string> {
    const wanted = this.white ? this.mine.length : this.mine.length + 1;
    // get() actively requests the block from peers and resolves when it
    // arrives (update() only waits for announcements, which can stall).
    const move = await this.theirs.get(wanted - 1);
    return new TextDecoder().decode(move);
  }

  /** Full game so far, interleaved white/black. */
  async moves(): Promise<string[]> {
    const whiteFeed = this.white ? this.mine : this.theirs;
    const blackFeed = this.white ? this.theirs : this.mine;
    const out: string[] = [];
    for (let ply = 0; ply < this.plies; ply++) {
      const feed = ply % 2 === 0 ? whiteFeed : blackFeed;
      const index = Math.floor(ply / 2);
      if (index >= feed.length) break;
      out.push(new TextDecoder().decode(await feed.get(index)));
    }
    return out;
  }
}
