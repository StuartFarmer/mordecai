import React, { useEffect, useState, useRef } from 'react';
import { CHESS_ZERO_HASH, chessBytes, chessHex, replayChess } from '@mordecai/wallet/chess';
import { roomFromHash, roomHash, watchRoomLink, roomCheckpoint } from './room-link.js';
import { decodeBrowserAddress } from '@mordecai/wallet/browser';

const pieces = {
  w: { k: '♔', q: '♕', r: '♖', b: '♗', n: '♘', p: '♙' },
  b: { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' },
};
const u64 = (value) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(value), true);
  return b;
};
const addressArg = (bytes) => new Uint8Array([32, 0, 0, 0, ...bytes]);
async function api(path, data) {
  const response = await fetch(
    path,
    data
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(data),
        }
      : undefined,
  );
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Request failed');
  return body;
}
export default function App({ session, config }) {
  const [player, setPlayer] = useState(() => session.getSnapshot());
  const [roomId, setRoomId] = useState(() => roomFromHash(location.hash));
  const [room, setRoom] = useState(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [stake, setStake] = useState('100000'),
    [selected, setSelected] = useState(''),
    [promotion, setPromotion] = useState('q');
  const [pending, setPending] = useState(null);
  const [recoveryHash, setRecoveryHash] = useState('');
  const [navigation, setNavigation] = useState(0);
  const checkpoint = useRef(roomCheckpoint());
  const scope = checkpoint.current;
  useEffect(
    () =>
      watchRoomLink((id) => {
        checkpoint.current.revoke();
        checkpoint.current = roomCheckpoint();
        setNavigation((value) => value + 1);
        if (id !== undefined) {
          setRoomId(id);
          setRoom(null);
          setSelected('');
          setPending(null);
          setError('');
          setRecoveryHash('');
        }
        setBusy(false);
      }),
    [],
  );
  useEffect(() => () => checkpoint.current.revoke(), []);

  useEffect(
    () =>
      session.subscribe(() => {
        checkpoint.current.revoke();
        checkpoint.current = roomCheckpoint();
        setBusy(false);
        setPlayer(session.getSnapshot());
        setSelected('');
        setPending(null);
        setError('');
      }),
    [session],
  );
  useEffect(() => {
    let live = true;
    const readScope = checkpoint.current;
    const refresh = async () => {
      if (!roomId) {
        setRoom(null);
        return;
      }
      try {
        const data = await api(`${config.roomsApi}/${roomId}`);
        replayChess(data.messages, { ...config, roomId });
        if (live && readScope.valid()) setRoom(data);
      } catch (e) {
        if (live && readScope.valid()) setError(e.message);
      }
    };
    refresh();
    const timer = setInterval(refresh, 1500);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [roomId, config, player, navigation]);
  let state;
  try {
    state = replayChess(room?.roomId === roomId ? room.messages : [], {
      ...config,
      roomId: roomId || CHESS_ZERO_HASH,
    });
  } catch (e) {
    return <p role="alert">Untrusted room history: {e.message}</p>;
  }
  const wager = room?.wager;
  const mine = player && [state.white, state.black].includes(player.address);
  const current = () => {
    if (!scope.valid()) throw new Error('Room changed. Please retry.');
    if (!player || session.getSnapshot() !== player)
      throw new Error('Account changed. Please retry.');
    return player;
  };
  const run = async (fn) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      if (scope.valid() && session.getSnapshot() === player) setError(e.message);
    } finally {
      if (scope.valid() && session.getSnapshot() === player) setBusy(false);
    }
  };
  const checkFunding = async (value) => {
    const wallet = current();
    const account = await api(`/api/account/${wallet.address}`);
    current();
    if (BigInt(account.balance) < value + 500000n)
      throw new Error('Insufficient stake plus fee balance. Check your Account balance.');
    return wallet;
  };
  const send = async (action, args, value = 0n, fundedWallet) => {
    const wallet = fundedWallet || (await checkFunding(value));
    current();
    const receipt = await wallet.sendTransaction(
      '',
      config.chainId,
      { kind: 'execute_contract', contract: chessBytes(config.contract), action, args, value },
      500000n,
    );
    current();
    if (!receipt.success) throw new Error(receipt.error || 'Transaction failed');
    return receipt;
  };
  const post = async (action, data = '', id = roomId) => {
    const latest = await api(`${config.roomsApi}/${id}`);
    current();
    const history = replayChess(latest.messages, { ...config, roomId: id });
    const envelope = await current().signChessMessage({
      version: 1,
      chainId: config.chainId,
      contract: config.contract,
      roomId: id,
      sequence: latest.messages.length,
      previousHash: history.previousHash,
      action,
      data,
    });
    current();
    setPending({ id, envelope });
    const next = await api(`${config.roomsApi}/${id}`, envelope);
    current();
    setPending(null);
    setRoom(next);
  };
  const create = async () => {
    if (!/^[1-9][0-9]{0,14}$/.test(stake))
      throw new Error('Stake must be a positive integer of at most 15 digits.');
    const wallet = await checkFunding(BigInt(stake));
    const id = chessHex(crypto.getRandomValues(new Uint8Array(32)));
    // Retain the invitation before submission so an uncertain receipt cannot cause a duplicate stake.
    scope.navigate(id);
    setRoom(null);
    setRoomId(id);
    const receipt = await send('create_room', addressArg(chessBytes(id)), BigInt(stake), wallet);
    // Store only the public receipt hash for interrupted registration recovery.
    setRecoveryHash(receipt.hash);
    try {
      localStorage.setItem(`chess-create:${config.contract}:${id}`, receipt.hash);
    } catch {
      /* Account history also retains the public receipt. */
    }
    await post('create', receipt.hash, id);
  };
  const choose = (square) =>
    run(async () => {
      if (!selected) {
        setSelected(square);
        return;
      }
      const move = state.game
        .moves({ square: selected, verbose: true })
        .find((m) => m.to === square && (!m.promotion || m.promotion === promotion));
      if (!move) {
        setSelected(square);
        return;
      }
      await post('move', `${selected}${square}${move.promotion || ''}`);
      setSelected('');
    });
  const invite = new URL(location.href);
  invite.searchParams.delete('room');
  invite.hash = roomHash(roomId);
  const canMove =
    mine &&
    wager?.phase === 1 &&
    state.black &&
    !state.result &&
    player.address === (state.game.turn() === 'w' ? state.white : state.black);
  const myReport =
    player?.address === wager?.creator ? wager?.creatorReported : wager?.opponentReported;
  return (
    <main>
      <h1>Chess</h1>
      <p>
        Moves are account-signed and relayed by this node. Stakes settle on L1 only after both
        players report the same result.
      </p>
      <p className="warning">
        Active stakes can remain locked if a player abandons the match or refuses to report. There
        is no automatic dispute resolution.
      </p>
      <p>
        {player
          ? `Account: ${player.address}`
          : 'Load an account to play; spectators can read invitations.'}{' '}
        <a href="#/account">Manage account</a>
      </p>
      {error && <p role="alert">{error}</p>}
      {pending && (
        <button
          disabled={busy}
          onClick={() =>
            run(async () => {
              current();
              const next = await api(`${config.roomsApi}/${pending.id}`, pending.envelope);
              current();
              setRoom(next);
              setPending(null);
            })
          }
        >
          Retry identical signed message
        </button>
      )}
      {!roomId && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(create);
          }}
        >
          <label>
            Stake (base units){' '}
            <input value={stake} onChange={(e) => setStake(e.target.value)} inputMode="numeric" />
          </label>
          <button disabled={!player || busy}>Create wagered room</button>
        </form>
      )}
      {roomId && (
        <>
          <label>
            Invitation <input readOnly value={invite.href} />
          </label>
          <button onClick={() => run(() => navigator.clipboard.writeText(invite.href))}>
            Copy invitation
          </button>
          <p>
            <a href="#/demos/chess?new=1">New room</a>
          </p>
          {!state.white && (
            <p>Room awaiting its creator’s confirmed stake and signed registration.</p>
          )}
          {!state.white && wager?.creator === player?.address && (
            <div>
              <label>
                Confirmed creation transaction hash (from Account history)
                <input
                  value={recoveryHash}
                  onChange={(event) => setRecoveryHash(event.target.value)}
                />
              </label>
              <button
                disabled={busy}
                onClick={() =>
                  run(() => {
                    let hash = recoveryHash;
                    try {
                      hash ||=
                        localStorage.getItem(`chess-create:${config.contract}:${roomId}`) || '';
                    } catch {
                      /* Use the pasted public receipt hash. */
                    }
                    return post('create', hash);
                  })
                }
              >
                Recover room registration
              </button>
            </div>
          )}
          {state.white &&
            !state.black &&
            wager?.phase === 0 &&
            player &&
            player.address !== state.white && (
              <button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await send('join', u64(wager.matchId), BigInt(wager.stake));
                    await post('join');
                  })
                }
              >
                Join black — stake {wager.stake}
              </button>
            )}
          {state.white &&
            !state.black &&
            wager?.phase === 1 &&
            wager.opponent === player?.address && (
              <button disabled={busy} onClick={() => run(() => post('join'))}>
                Confirm room membership
              </button>
            )}
          {wager?.phase === 0 && wager.creator === player?.address && (
            <button disabled={busy} onClick={() => run(() => send('cancel', u64(wager.matchId)))}>
              Cancel and refund open stake
            </button>
          )}
          <p>
            White: {state.white || 'waiting'}
            <br />
            Black: {state.black || 'waiting'}
            <br />
            Stake: {wager?.stake || 'unconfirmed'}
          </p>
          <p>
            {state.result
              ? state.result === 'draw'
                ? 'Draw agreed or reached'
                : `Winner: ${state.result}`
              : `${state.game.turn() === 'w' ? 'White' : 'Black'} to move${state.game.isCheck() ? ' — check' : ''}`}
          </p>
          <div className="board" role="group" aria-label="Chess board">
            {state.game
              .board()
              .flat()
              .map((piece, i) => {
                const square = `${'abcdefgh'[i % 8]}${8 - Math.floor(i / 8)}`;
                return (
                  <button
                    key={square}
                    aria-label={`${square} ${piece ? `${piece.color === 'w' ? 'white' : 'black'} ${piece.type}` : 'empty'}`}
                    aria-pressed={selected === square}
                    className={(Math.floor(i / 8) + (i % 8)) % 2 ? 'dark' : 'light'}
                    disabled={!canMove || busy}
                    onClick={() => choose(square)}
                  >
                    {piece ? pieces[piece.color][piece.type] : ''}
                    <small>{square}</small>
                  </button>
                );
              })}
          </div>
          <label>
            Promotion{' '}
            <select value={promotion} onChange={(e) => setPromotion(e.target.value)}>
              <option value="q">Queen</option>
              <option value="r">Rook</option>
              <option value="b">Bishop</option>
              <option value="n">Knight</option>
            </select>
          </label>
          <p>Moves: {state.game.history().join(' ') || 'None yet'}</p>
          {mine && state.black && wager?.phase === 1 && !state.result && (
            <div>
              <button disabled={busy} onClick={() => run(() => post('resign'))}>
                Resign
              </button>
              <button disabled={busy} onClick={() => run(() => post('draw-offer'))}>
                Offer draw
              </button>
              {state.drawOffer && state.drawOffer !== player.address && (
                <button disabled={busy} onClick={() => run(() => post('draw-accept'))}>
                  Accept draw
                </button>
              )}
            </div>
          )}
          {wager?.phase === 1 && state.result && (
            <>
              <p>
                Settlement pending. White report: {wager.creatorReported ? 'submitted' : 'missing'};
                black report: {wager.opponentReported ? 'submitted' : 'missing'}. Matching reports
                are required.
              </p>
              {mine && (
                <button
                  disabled={busy}
                  onClick={() =>
                    run(() =>
                      send(
                        state.result === 'draw' ? 'draw' : 'report',
                        state.result === 'draw'
                          ? u64(wager.matchId)
                          : new Uint8Array([
                              ...u64(wager.matchId),
                              ...addressArg(decodeBrowserAddress(state.result)),
                            ]),
                      ),
                    )
                  }
                >
                  {myReport ? 'Resubmit matching result' : 'Report result on L1'}
                </button>
              )}
            </>
          )}
          {wager?.phase === 2 && <p>Wager closed on confirmed L1 state.</p>}
        </>
      )}
      {busy && <p role="status">Waiting for confirmation…</p>}
    </main>
  );
}
