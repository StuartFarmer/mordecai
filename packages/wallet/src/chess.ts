import { ed25519 } from '@noble/curves/ed25519';
import { blake2b } from '@noble/hashes/blake2b';
import { Chess } from 'chess.js';
import { browserAddress, type BrowserWallet } from './browser.js';

export const CHESS_ZERO_HASH = '0'.repeat(64);
export interface ChessMessage {
  version: 1;
  chainId: string;
  contract: string;
  roomId: string;
  sequence: number;
  previousHash: string;
  action: 'create' | 'join' | 'move' | 'resign' | 'draw-offer' | 'draw-accept';
  data: string;
}
export interface SignedChessMessage {
  message: ChessMessage;
  publicKey: string;
  signature: string;
}
export const chessHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
export const chessBytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
const hashPattern = /^[a-f0-9]{64}$/;
export function chessSigningBytes(input: ChessMessage): Uint8Array {
  if (
    !input ||
    Object.keys(input).sort().join() !==
      'action,chainId,contract,data,previousHash,roomId,sequence,version' ||
    input.version !== 1 ||
    typeof input.chainId !== 'string' ||
    !/^[a-zA-Z0-9_.-]{1,128}$/.test(input.chainId) ||
    !hashPattern.test(input.contract) ||
    !hashPattern.test(input.roomId) ||
    !hashPattern.test(input.previousHash) ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 0 ||
    typeof input.data !== 'string' ||
    !['create', 'join', 'move', 'resign', 'draw-offer', 'draw-accept'].includes(input.action) ||
    (input.action === 'create'
      ? !hashPattern.test(input.data)
      : input.action === 'move'
        ? !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(input.data)
        : input.data !== '')
  )
    throw new Error('Invalid Chess message');
  return new TextEncoder().encode(
    JSON.stringify([
      'mordecai/chess/v1',
      input.version,
      input.chainId,
      input.contract,
      input.roomId,
      input.sequence,
      input.previousHash,
      input.action,
      input.data,
    ]),
  );
}
export function signChessMessage(wallet: BrowserWallet, message: ChessMessage): SignedChessMessage {
  const bytes = chessSigningBytes(message);
  return {
    message: { ...message },
    publicKey: chessHex(wallet.publicKey),
    signature: chessHex(ed25519.sign(bytes, wallet.seed)),
  };
}
export function verifyChessMessage(envelope: SignedChessMessage): string {
  if (
    !envelope ||
    Object.keys(envelope).sort().join() !== 'message,publicKey,signature' ||
    !hashPattern.test(envelope.publicKey) ||
    !/^[a-f0-9]{128}$/.test(envelope.signature) ||
    !ed25519.verify(
      chessBytes(envelope.signature),
      chessSigningBytes(envelope.message),
      chessBytes(envelope.publicKey),
      { zip215: false },
    )
  )
    throw new Error('Invalid Chess signature');
  return browserAddress(chessBytes(envelope.publicKey));
}
export function chessMessageHash(envelope: SignedChessMessage): string {
  verifyChessMessage(envelope);
  return chessHex(
    blake2b(
      new TextEncoder().encode(
        JSON.stringify([
          chessHex(chessSigningBytes(envelope.message)),
          envelope.publicKey,
          envelope.signature,
        ]),
      ),
      { dkLen: 32 },
    ),
  );
}
/** Replay signatures and rules in the host and browser, without trusting a supplied board. */
export function replayChess(
  messages: SignedChessMessage[],
  binding: { chainId: string; contract: string; roomId: string },
) {
  const game = new Chess();
  let white = '',
    black = '',
    previousHash = CHESS_ZERO_HASH,
    result = '',
    drawOffer = '';
  messages.forEach((envelope, sequence) => {
    const actor = verifyChessMessage(envelope),
      m = envelope.message;
    if (
      m.sequence !== sequence ||
      m.previousHash !== previousHash ||
      m.chainId !== binding.chainId ||
      m.contract !== binding.contract ||
      m.roomId !== binding.roomId
    )
      throw new Error('Chess history binding or sequence mismatch');
    if (sequence === 0) {
      if (m.action !== 'create') throw new Error('Room must start with create');
      white = actor;
    } else if (m.action === 'join') {
      if (black || actor === white || sequence !== 1) throw new Error('Invalid room join');
      black = actor;
    } else {
      if (!black || ![white, black].includes(actor) || result)
        throw new Error('Match is not playable by this wallet');
      if (m.action === 'move') {
        if (actor !== (game.turn() === 'w' ? white : black)) throw new Error('Not your turn');
        game.move({
          from: m.data.slice(0, 2),
          to: m.data.slice(2, 4),
          ...(m.data[4] ? { promotion: m.data[4] } : {}),
        });
        drawOffer = '';
        if (game.isCheckmate()) result = game.turn() === 'w' ? black : white;
        else if (game.isDraw()) result = 'draw';
      } else if (m.action === 'resign') result = actor === white ? black : white;
      else if (m.action === 'draw-offer') drawOffer = actor;
      else if (m.action === 'draw-accept' && drawOffer && drawOffer !== actor) result = 'draw';
      else throw new Error('Invalid Chess action');
    }
    previousHash = chessMessageHash(envelope);
  });
  return { game, white, black, previousHash, result, drawOffer };
}
