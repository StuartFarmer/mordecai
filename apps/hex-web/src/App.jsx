import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  SIZE,
  fetchBalance,
  fetchConfig,
  fetchGame,
  fetchPot,
  fetchStatus,
  gameIdFromCode,
  play,
  requestFunds,
  stake,
  wallet,
  winningPath,
} from './chain.js';

const DEFAULT_STAKE = 1000;
const FUND_FLOOR = 5000; // ask the faucet when the L1 balance drops below this

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

export default function App() {
  const [config, setConfig] = useState(null);
  const [fatal, setFatal] = useState(null);
  const [player] = useState(() => wallet());
  const [balance, setBalance] = useState(null);
  const [funding, setFunding] = useState(false);
  const [status, setStatus] = useState(null);
  const [code, setCode] = useState(() => localStorage.getItem('hex-game-code') ?? '');
  const [entered, setEntered] = useState(() => localStorage.getItem('hex-game-code'));
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

  const addLog = useCallback((ok, text) => {
    setLog([{ time: new Date().toLocaleTimeString(), ok, text }, ...logRef.current].slice(0, 10));
  }, []);

  // -------------------------------------------------- config + faucet

  useEffect(() => {
    fetchConfig()
      .then(setConfig)
      .catch((e) => setFatal(`${e.message || e} — is the host running scripts/hex-demo.mjs?`));
  }, []);

  useEffect(() => {
    if (!config) return undefined;
    let stop = false;
    const tick = async () => {
      try {
        const b = await fetchBalance(player);
        if (stop) return;
        setBalance(b);
        if (b < FUND_FLOOR && !funding) {
          setFunding(true);
          try {
            await requestFunds(config, player);
            addLog(true, 'faucet funded this wallet on both chains');
          } finally {
            setFunding(false);
          }
        }
      } catch {
        /* gateway hiccups are retried on the next tick */
      }
      try {
        setStatus(await fetchStatus(config));
      } catch {
        /* ditto */
      }
    };
    tick();
    const t = setInterval(tick, 2500);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [config, player, funding, addLog]);

  // -------------------------------------------------- game state polling

  const refreshGame = useCallback(async () => {
    if (!config || gameId === null) return;
    try {
      const [g, p] = await Promise.all([fetchGame(config, gameId), fetchPot(config, gameId)]);
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

  const me = player.address;
  const iAmCreator = game && game.creator === me;
  const iAmOpponent = game && game.phase > 0 && game.opponent === me;
  const iPlay = iAmCreator || iAmOpponent;
  const mySide = iAmCreator ? 0 : 1;
  const toMove = game?.phase === 1 ? (game.turn === 0 ? game.creator : game.opponent) : null;
  const myTurn = toMove === me;
  const msLeft = game?.phase === 1 ? game.deadline - now : 0;

  // -------------------------------------------------- automatic actions

  // Auto-prove: when my stones connect my edges, walk the contract along
  // the path (prove_start + prove_steps). The chain checks every step.
  useEffect(() => {
    if (!config || !game || game.phase !== 1 || !iPlay || provingRef.current) return;
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
  }, [config, game, gameId, iPlay, mySide, player, addLog, refreshGame]);

  // Auto-forfeit: when the player to move blows the 3-minute deadline,
  // the other player's browser claims the win.
  useEffect(() => {
    if (!config || !game || game.phase !== 1 || !iPlay || myTurn) return;
    if (now <= game.deadline + 1500 || claimedRef.current === game.deadline) return;
    claimedRef.current = game.deadline;
    play(player, config, { claim_timeout: { game_id: gameId } })
      .then(() => addLog(true, 'opponent timed out — win claimed'))
      .catch(() => {
        claimedRef.current = 0; // clock skew; retry on a later tick
      })
      .finally(refreshGame);
  }, [config, game, gameId, iPlay, myTurn, now, player, addLog, refreshGame]);

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
    localStorage.setItem('hex-game-code', newCode);
    setEntered(newCode);
    setGame(null);
    setPot(null);
  }

  const createGame = () =>
    run(`created game “${code}” and escrowed ${stakeAmount}`, async () => {
      const id = gameIdFromCode(code);
      await play(player, config, { create: { game_id: id } });
      await stake(player, config, { create: { game_id: id } }, BigInt(stakeAmount));
      enter(code);
    });

  const joinGame = () =>
    run(`joined game “${code}”`, async () => {
      const id = gameIdFromCode(code);
      const g = await fetchGame(config, id);
      if (!g) throw new Error('no game with that code — ask the creator to check it');
      if (g.phase !== 0) throw new Error('that game has already started');
      const p = await fetchPot(config, id);
      await play(player, config, { join: { game_id: id } });
      if (p && p.phase === 0) {
        await stake(player, config, { join: { game_id: id } }, BigInt(p.stake));
      }
      enter(code);
    });

  const placeStone = (r, c) =>
    run(`placed at ${r},${c}`, () => play(player, config, { place: { game_id: gameId, r, c } }));

  const leave = () => {
    localStorage.removeItem('hex-game-code');
    setEntered(null);
    setGame(null);
    setPot(null);
  };

  // -------------------------------------------------- rendering

  if (fatal) return <div className="fatal">⚠️ {fatal}</div>;
  if (!config) return <div className="fatal">connecting to the gateway…</div>;

  const header = (
    <header>
      <h1>⬡ hex</h1>
      <span className="chain-meta">
        {status
          ? `L1 block ${status.l1Height} · game block ${status.appHeight} · anchor epoch ${status.anchor?.epoch ?? '—'}`
          : 'syncing…'}
      </span>
      <span className="wallet">
        <b>{balance ?? '…'}</b> 🪙 · {short(me)}
        {funding && ' · faucet…'}
      </span>
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
                value={stakeAmount}
                onChange={(e) => setStakeAmount(Math.max(1, Number(e.target.value)))}
              />{' '}
              🪙
            </label>
          </div>
          <div className="code-actions">
            <button
              disabled={busy || !code.trim() || (balance ?? 0) < stakeAmount}
              onClick={createGame}
            >
              create game (escrows {stakeAmount} 🪙)
            </button>
            <button disabled={busy || !code.trim()} onClick={joinGame}>
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
          <p className="pot">{potLine}</p>

          {game?.phase === 0 && (
            <>
              <p>
                waiting for an opponent — share the code <b>“{entered}”</b> (and this site's
                address) with them.
              </p>
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
