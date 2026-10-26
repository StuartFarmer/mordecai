import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoom, joinRoom } from './rooms.js';
import { watchRoomLink } from './room-link.js';
import { watchFunding } from './funding.js';
import WalletPicker, { downloadWallet } from './WalletPicker.jsx';
import {
  SIZE,
  fetchConfig,
  fetchGame,
  fetchPot,
  gameIdFromCode,
  play,
  stake,
  wallet,
  winningPath,
} from './chain.js';

const DEFAULT_STAKE = 100_000;

// ------------------------------------------------------------ board maths

const HEX_R = 17;
const HEX_W = Math.sqrt(3) * HEX_R;
const PAD = 30;

const center = (r, c) => [PAD + HEX_W * (c + r / 2) + HEX_W / 2, PAD + 1.5 * HEX_R * r + HEX_R];

function hexPoints(cx, cy) {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 180) * (60 * i - 30);
    return `${(cx + HEX_R * 0.94 * Math.cos(a)).toFixed(1)},${(cy + HEX_R * 0.94 * Math.sin(a)).toFixed(1)}`;
  }).join(' ');
}

function edgePath(cells, [dx, dy]) {
  return cells
    .map(([r, c], i) => {
      const [x, y] = center(r, c);
      return `${i === 0 ? 'M' : 'L'} ${(x + dx).toFixed(1)} ${(y + dy).toFixed(1)}`;
    })
    .join(' ');
}

const ROW0 = Array.from({ length: SIZE }, (_, c) => [0, c]);
const ROW10 = Array.from({ length: SIZE }, (_, c) => [SIZE - 1, c]);
const COL0 = Array.from({ length: SIZE }, (_, r) => [r, 0]);
const COL10 = Array.from({ length: SIZE }, (_, r) => [r, SIZE - 1]);
const BOARD_W = PAD * 2 + HEX_W * (SIZE + SIZE / 2);
const BOARD_H = PAD * 2 + 1.5 * HEX_R * SIZE + HEX_R;

const short = (addr) => (addr ? `${addr.slice(0, 10)}…` : '—');
const fmtClock = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const noSubscribe = () => () => {};
const noPlayer = () => null;

export default function App({ session, initialConfig } = {}) {
  const [config, setConfig] = useState(initialConfig ?? null);
  const [fatal, setFatal] = useState(null);
  const [legacy] = useState(() => (session ? null : wallet()));
  const [localPlayer, setPlayer] = useState(null);
  const sharedPlayer = useSyncExternalStore(
    session?.subscribe ?? noSubscribe,
    session?.getSnapshot ?? noPlayer,
  );
  const player = session ? sharedPlayer : localPlayer;
  const [backedUp, setBackedUp] = useState(false);
  const [balance, setBalance] = useState(null);
  const [funding, setFunding] = useState(false);
  const [status, setStatus] = useState(null);
  const storageKey = initialConfig
    ? `hex-game-code:${initialConfig.chainId}:${initialConfig.hex}`
    : 'hex-game-code';
  const roomLink = () =>
    session ? new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('room') : null;
  const [code, setCode] = useState(() => roomLink() ?? localStorage.getItem(storageKey) ?? '');
  const [entered, setEntered] = useState(() => roomLink() ?? localStorage.getItem(storageKey));
  const [stakeAmount, setStakeAmount] = useState(DEFAULT_STAKE);
  const [game, setGame] = useState(null);
  const [pot, setPot] = useState(null);
  const [busy, setBusy] = useState(false);
  const [proving, setProving] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [log, setLog] = useState([]);
  const provingRef = useRef(false);
  const claimedRef = useRef(0);
  const logRef = useRef(log);
  logRef.current = log;

  const gameId = entered ? gameIdFromCode(entered) : null;
  const gameIdRef = useRef(gameId);
  const codeRef = useRef(code);
  gameIdRef.current = gameId;
  codeRef.current = code;

  useEffect(() => {
    if (!session) return;
    return watchRoomLink((room) => {
      setCode(room);
      setEntered(room);
      setGame(null);
      setPot(null);
    });
  }, [session]);

  const addLog = useCallback((ok, text) => {
    setLog([{ time: new Date().toLocaleTimeString(), ok, text }, ...logRef.current].slice(0, 10));
  }, []);

  // -------------------------------------------------- config + faucet

  useEffect(() => {
    const warn = (event) => {
      if (!session && player && !backedUp) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [player, backedUp, session]);

  useEffect(() => {
    if (initialConfig) return;
    fetchConfig()
      .then(setConfig)
      .catch((e) => setFatal(`${e.message || e} — is the host running scripts/hex-demo.mjs?`));
  }, [initialConfig]);

  useEffect(
    () =>
      watchFunding(
        player,
        config,
        (update) => {
          if ('balance' in update) setBalance(update.balance);
          if ('funding' in update) setFunding(update.funding);
          if ('status' in update) setStatus(update.status);
        },
        () =>
          addLog(
            true,
            config.manualFunding
              ? 'App-chain fee funding requested'
              : 'faucet funded this account on both chains',
          ),
      ),
    [config, player, addLog],
  );

  // -------------------------------------------------- game state polling

  const refreshGame = useCallback(async () => {
    if (!config || gameId === null) return;
    try {
      const [g, p] = await Promise.all([fetchGame(config, gameId), fetchPot(config, gameId)]);
      if (gameIdRef.current !== gameId) return;
      setGame(g);
      setPot(p);
    } catch {
      /* transient */
    }
  }, [config, gameId]);

  useEffect(() => {
    if (!config || gameId === null) return undefined;
    refreshGame();
    const t = setInterval(refreshGame, 1000);
    return () => clearInterval(t);
  }, [config, gameId, refreshGame]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  // -------------------------------------------------- derived game facts

  const me = player?.address;
  const iAmCreator = game && game.creator === me;
  const iAmOpponent = game && game.phase > 0 && game.opponent === me;
  const iPlay = iAmCreator || iAmOpponent;
  const mySide = iAmCreator ? 0 : 1;
  const toMove = game?.phase === 1 ? (game.turn === 0 ? game.creator : game.opponent) : null;
  const myTurn = toMove === me && pot?.phase === 1;
  const msLeft = game?.phase === 1 ? game.deadline - now : 0;

  // -------------------------------------------------- automatic actions

  // Auto-prove: when my stones connect my edges, walk the contract along
  // the path (prove_start + prove_steps). The chain checks every step.
  useEffect(() => {
    if (!config || !game || game.phase !== 1 || pot?.phase !== 1 || !iPlay || provingRef.current)
      return;
    const path = winningPath(game.board, mySide);
    if (!path) return;
    provingRef.current = true;
    (async () => {
      try {
        setProving({ done: 0, total: path.length });
        const [r0, c0] = path[0];
        await play(player, config, { prove_start: { game_id: gameId, r: r0, c: c0 } });
        for (let i = 1; i < path.length; i++) {
          const [r, c] = path[i];
          await play(player, config, { prove_step: { game_id: gameId, r, c } });
          setProving({ done: i, total: path.length });
        }
        addLog(true, 'winning path proven on-chain');
      } catch (e) {
        addLog(false, `proof failed: ${e.message || e}`);
      } finally {
        provingRef.current = false;
        setProving(null);
        refreshGame();
      }
    })();
  }, [config, game, pot, gameId, iPlay, mySide, player, addLog, refreshGame]);

  // Auto-forfeit: when the player to move blows the 3-minute deadline,
  // the other player's browser claims the win.
  useEffect(() => {
    if (!config || !game || game.phase !== 1 || pot?.phase !== 1 || !iPlay || myTurn) return;
    if (now <= game.deadline + 1500 || claimedRef.current === game.deadline) return;
    claimedRef.current = game.deadline;
    play(player, config, { claim_timeout: { game_id: gameId } })
      .then(() => addLog(true, 'opponent timed out — win claimed'))
      .catch(() => {
        claimedRef.current = 0; // clock skew; retry on a later tick
      })
      .finally(refreshGame);
  }, [config, game, pot, gameId, iPlay, myTurn, now, player, addLog, refreshGame]);

  // -------------------------------------------------- user actions

  async function run(label, fn) {
    setBusy(true);
    try {
      await fn();
      addLog(true, label);
    } catch (e) {
      addLog(false, `${label} — ${e.message || e}`);
    }
    await refreshGame();
    setBusy(false);
  }

  function enter(newCode) {
    localStorage.setItem(storageKey, newCode);
    if (session)
      window.history.replaceState(null, '', `#/demos/hex?room=${encodeURIComponent(newCode)}`);
    setEntered(newCode);
    setGame(null);
    setPot(null);
  }

  const createGame = () =>
    run(`created game “${code}” and escrowed ${stakeAmount}`, async () => {
      await createRoom(player, config, code, stakeAmount);
      if (codeRef.current === code) enter(code);
    });

  const joinGame = () =>
    run(`joined game “${code}”`, async () => {
      await joinRoom(player, config, code);
      if (codeRef.current === code) enter(code);
    });

  const placeStone = (r, c) =>
    run(`placed at ${r},${c}`, () => play(player, config, { place: { game_id: gameId, r, c } }));

  const leave = () => {
    localStorage.removeItem(storageKey);
    if (session) window.history.replaceState(null, '', '#/demos/hex');
    setEntered(null);
    setGame(null);
    setPot(null);
  };

  // -------------------------------------------------- rendering

  if (fatal) return <div className="fatal">⚠️ {fatal}</div>;
  if (!config) return <div className="fatal">connecting to the gateway…</div>;
  if (!player && session)
    return (
      <p className="fatal">
        Open an account in the <a href="#/account">Account tab</a>, then return to Hex.
      </p>
    );
  if (!player)
    return (
      <WalletPicker
        legacy={legacy}
        onLoad={(loaded, saved) => {
          setPlayer(loaded);
          setBackedUp(saved);
        }}
      />
    );

  const header = (
    <header>
      <h1>⬡ hex</h1>
      <span className="chain-meta">
        {status
          ? `L1 block ${status.l1Height} · game block ${status.appHeight} · anchor epoch ${status.anchor?.epoch ?? '—'}`
          : 'syncing…'}
      </span>
      <span className="wallet" title={me}>
        <b>{balance ?? '…'}</b> 🪙 · {short(me)}
        {funding && ' · faucet…'}
      </span>
      {!session && (
        <button
          onClick={() => {
            downloadWallet(player);
            setBackedUp(true);
          }}
        >
          Download account backup
        </button>
      )}
      {!session && !backedUp && (
        <span className="hint">Download your key before leaving this tab.</span>
      )}
      {session && <a href="#/account">Manage account</a>}
      {config.manualFunding && balance !== null && balance < 2_500_000 && (
        <p className="hint">
          New accounts receive test CAI automatically. Check your <a href="#/account">Account</a>{' '}
          before creating or joining a room.
        </p>
      )}
    </header>
  );

  if (!entered || (game === null && pot === null)) {
    const waiting = entered && game === null;
    return (
      <div className="app">
        {header}
        <div className="lobby">
          <h2>winner-takes-all hex</h2>
          <p className="hint">
            Pick any code and share it with your opponent. Creating a game escrows your stake on L1;
            the winner takes the whole pot. The game itself runs on a player-run app chain — every
            stone, rule, and the 3-minute forfeit clock is enforced by consensus.
          </p>
          <div className="code-form">
            <input
              placeholder="game code, e.g. crimson-otter-42"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              maxLength={64}
            />
            <label>
              stake{' '}
              <input
                type="number"
                min="1"
                step="1"
                max={Number.MAX_SAFE_INTEGER}
                value={stakeAmount}
                onChange={(e) => setStakeAmount(Math.max(1, Number(e.target.value)))}
              />{' '}
              🪙
            </label>
          </div>
          <div className="code-actions">
            <button
              disabled={busy || funding || !code.trim() || (balance ?? 0) < stakeAmount + 500000}
              onClick={createGame}
            >
              create game (escrows {stakeAmount} 🪙)
            </button>
            <button
              disabled={busy || funding || (balance ?? 0) <= 500000 || !code.trim()}
              onClick={joinGame}
            >
              join game (matches the creator's stake)
            </button>
          </div>
          {waiting && <p className="hint">looking up “{entered}”…</p>}
          <Log log={log} />
        </div>
      </div>
    );
  }

  const winnerName = game?.phase === 2 ? (game.winner === me ? 'you' : 'your opponent') : null;
  const potLine = !pot
    ? 'no stake escrowed yet'
    : pot.phase === 0
      ? `waiting for the opponent to match ${pot.stake} 🪙`
      : pot.phase === 1
        ? game?.phase === 2
          ? `pot of ${2 * pot.stake} 🪙 settling via the next anchor…`
          : `pot: ${2 * pot.stake} 🪙 escrowed on L1`
        : `pot paid out on L1 ✓`;

  return (
    <div className="app">
      {header}
      <div className="columns">
        <div className="board-wrap">
          <svg viewBox={`0 0 ${BOARD_W} ${BOARD_H}`} className="board">
            <path d={edgePath(ROW0, [0, -HEX_R * 1.1])} className="edge red" />
            <path d={edgePath(ROW10, [0, HEX_R * 1.1])} className="edge red" />
            <path d={edgePath(COL0, [-HEX_W * 0.62, 0])} className="edge blue" />
            <path d={edgePath(COL10, [HEX_W * 0.62, 0])} className="edge blue" />
            {game?.board.map((row, r) =>
              row.map((cell, c) => {
                const [cx, cy] = center(r, c);
                const cls = cell
                  ? cell.side === 0
                    ? 'cell red'
                    : 'cell blue'
                  : `cell empty${game.phase === 1 && myTurn && !busy ? ' playable' : ''}`;
                return (
                  <polygon
                    key={`${r}-${c}`}
                    points={hexPoints(cx, cy)}
                    className={cls}
                    onClick={() => !cell && game.phase === 1 && myTurn && !busy && placeStone(r, c)}
                  >
                    <title>{`${r},${c}`}</title>
                  </polygon>
                );
              }),
            )}
          </svg>
        </div>

        <div className="panel">
          <h3>game “{entered}”</h3>
          {session && (
            <button
              onClick={async () => {
                try {
                  const url = new URL(window.location.href);
                  url.hash = `/demos/hex?room=${encodeURIComponent(entered)}`;
                  await navigator.clipboard.writeText(url.href);
                  addLog(true, 'Room link copied');
                } catch {
                  addLog(false, 'Copy the room code and share this site with your opponent.');
                }
              }}
            >
              Copy room link
            </button>
          )}
          <p className="pot">{potLine}</p>

          {game?.phase === 0 && iAmCreator && !pot && (
            <button disabled={busy || funding} onClick={createGame}>
              Complete room stake
            </button>
          )}
          {game?.phase === 1 && iAmOpponent && pot?.phase === 0 && (
            <>
              <p className="hint">
                Your game join is recorded, but your stake still needs funding. Check Account if
                needed, then complete it here.
              </p>
              <button disabled={busy || funding} onClick={joinGame}>
                Complete room stake
              </button>
            </>
          )}
          {game?.phase === 0 && (
            <>
              <p>
                waiting for an opponent — share the code <b>“{entered}”</b> (and this site's
                address) with them.
              </p>
              {!iAmCreator && pot?.phase === 0 && (
                <button
                  disabled={busy || funding || (balance ?? 0) < pot.stake + 500000}
                  onClick={joinGame}
                >
                  Join this room
                </button>
              )}
              {iAmCreator && (
                <button
                  disabled={busy}
                  onClick={() =>
                    run('cancelled the game and refunded the stake', async () => {
                      await play(player, config, { cancel: { game_id: gameId } });
                      if (pot && pot.phase === 0) {
                        await stake(player, config, { cancel: { game_id: gameId } });
                      }
                    })
                  }
                >
                  cancel + refund stake
                </button>
              )}
            </>
          )}

          {game?.phase === 1 && (
            <>
              <p>
                you play{' '}
                <b className={mySide === 0 ? 'red-text' : 'blue-text'}>
                  {mySide === 0 ? 'red (top ↕ bottom)' : 'blue (left ↔ right)'}
                </b>
              </p>
              <p className={myTurn ? 'turn mine' : 'turn'}>
                {myTurn ? 'your move' : iPlay ? "opponent's move" : `${short(toMove)} to move`}
                <span className={`clock${msLeft < 30_000 ? ' low' : ''}`}>
                  {' '}
                  ⏱ {fmtClock(msLeft)}
                </span>
              </p>
              <p className="hint">
                the player to move forfeits if the clock runs out — the claim is automatic.
              </p>
              {proving && (
                <p className="proving">
                  proving your winning path on-chain… {proving.done}/{proving.total}
                </p>
              )}
              {iPlay && (
                <button
                  disabled={busy}
                  onClick={() =>
                    run('resigned', () => play(player, config, { resign: { game_id: gameId } }))
                  }
                >
                  resign
                </button>
              )}
            </>
          )}

          {game?.phase === 2 && (
            <>
              <p className={`result ${game.winner === me ? 'won' : 'lost'}`}>
                {winnerName === 'you' ? '🏆 you won' : `${winnerName} won`}
                {pot?.phase === 2 && pot && ` — ${2 * pot.stake} 🪙 paid to the winner on L1`}
              </p>
              <button onClick={leave}>back to the lobby</button>
            </>
          )}

          {game?.phase === 3 && (
            <>
              <p>game cancelled.</p>
              <button onClick={leave}>back to the lobby</button>
            </>
          )}

          {game && game.phase < 2 && (
            <button className="ghost" onClick={leave}>
              leave (game keeps running)
            </button>
          )}

          <Log log={log} />
        </div>
      </div>
    </div>
  );
}

function Log({ log }) {
  return (
    <div className="log">
      {log.map((entry, i) => (
        <div key={i} className={entry.ok ? 'ok' : 'err'}>
          <span className="t">{entry.time}</span> {entry.text}
        </div>
      ))}
    </div>
  );
}
