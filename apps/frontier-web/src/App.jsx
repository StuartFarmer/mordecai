import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  act,
  connect,
  fetchBalance,
  fetchConfig,
  fetchHeight,
  fetchWorld,
  MAX_FEE,
  validAmount,
  validAddress,
} from './chain.js';

const GRID = 12; // show tiles 0..143 of the map
const RESOURCE_ICON = { wood: '🪵', wheat: '🌾' };
const BUILDING_ICON = { farm: '🌾', lumbermill: '🪵' };

const noSubscribe = () => () => {};
const noPlayer = () => null;
export default function App({ session, initialConfig } = {}) {
  const sharedPlayer = useSyncExternalStore(
    session?.subscribe ?? noSubscribe,
    session?.getSnapshot ?? noPlayer,
    session?.getSnapshot ?? noPlayer,
  );
  const [config, setConfig] = useState(initialConfig ?? null);
  const [recipient, setRecipient] = useState('');
  const [error, setError] = useState(null);
  const [players, setPlayers] = useState({}); // name -> {name, address, publicKey, seed}
  const [current, setCurrent] = useState('alice');
  const [world, setWorld] = useState({
    tiles: {},
    accounts: {},
    orders: {},
    meta: {},
    config: null,
  });
  const [height, setHeight] = useState(0);
  const [balances, setBalances] = useState({});
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState([]);
  const [form, setForm] = useState({ give: 'wheat', giveAmount: 5, want: 'wood', wantAmount: 10 });
  const logRef = useRef(log);
  logRef.current = log;

  const addLog = useCallback((entry) => {
    setLog([{ time: new Date().toLocaleTimeString(), ...entry }, ...logRef.current].slice(0, 12));
  }, []);

  // boot: load the gateway config, derive both dev accounts
  useEffect(() => {
    if (session) return;
    (async () => {
      try {
        const cfg = await fetchConfig();
        if (!cfg.contract)
          throw new Error('gateway has no frontier config — run scripts/frontier-demo.mjs');
        setConfig(cfg);
        const conns = {};
        for (const account of cfg.accounts) conns[account.name] = connect(cfg, account);
        setPlayers(conns);
      } catch (e) {
        setError(String(e.message || e));
      }
    })();
  }, [session]);

  const player = session ? sharedPlayer : players[current];
  const playerRef = useRef(player);
  playerRef.current = player;

  const refresh = useCallback(async () => {
    if (!config) return;
    const readingPlayer = player;
    try {
      const [w, h] = await Promise.all([fetchWorld(config), fetchHeight()]);

      const b = {};
      for (const p of session ? (player ? [player] : []) : Object.values(players))
        b[p.address] = await fetchBalance(p);
      if (playerRef.current !== readingPlayer) return;
      setWorld(w);
      setHeight(h);
      setBalances(b);
    } catch (e) {
      if (playerRef.current === readingPlayer) setError(String(e.message || e));
    }
  }, [config, players, player, session]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, [refresh]);

  const me = player?.address;
  const account = (me && world.accounts[me]) || { wood: 0, wheat: 0 };
  const nameOf = (addr) =>
    (session && addr === me
      ? 'you'
      : Object.values(players).find((p) => p.address === addr)?.name) || addr.slice(0, 12) + '…';

  async function run(label, msg) {
    const signingPlayer = player;
    setBusy(true);
    try {
      if (!player || (balances[player.address] ?? 0n) < MAX_FEE)
        throw new Error('Check your Account balance for transaction fees.');
      const res = await act(player, config, msg);
      if (playerRef.current !== signingPlayer) return;
      addLog({
        ok: true,
        text: `${session ? 'you' : current}: ${label} (block ${res.height}, fee ${res.gasUsed})`,
      });
    } catch (e) {
      if (playerRef.current !== signingPlayer) return;
      const m = String(e.message || e);
      addLog({ ok: false, text: `${session ? 'you' : current}: ${label} — ${m}` });
    } finally {
      setBusy(false);
    }
    await refresh();
  }

  if (error) return <div className="fatal">⚠️ {error}</div>;
  if (session && !player)
    return (
      <div className="fatal">
        Load an account to play Frontier. <a href="#/account">Account</a>
      </div>
    );
  if (!config || !player) return <div className="fatal">connecting to gateway…</div>;

  const tile = selected != null ? world.tiles[selected] : undefined;
  const mine = tile && tile.owner === me;
  const unavailable = busy || (balances[me] ?? 0n) < MAX_FEE;
  const growing = tile?.building ? height - tile.last_tick_height : 0;
  const openOrders = Object.entries(world.orders)
    .filter(([, o]) => o.open)
    .sort(([a], [b]) => Number(a) - Number(b));
  const canAfford = (o) => (account[o.want] ?? 0) >= o.want_amount;

  return (
    <div className="app">
      <header>
        <h1>frontier</h1>
        <span className="chain-meta">
          {config.chainId} · block {height} · contract {config.contract.slice(0, 14)}…
        </span>
      </header>

      <div className="columns">
        <div className="map">
          <div className="grid" style={{ gridTemplateColumns: `repeat(${GRID}, 1fr)` }}>
            {Array.from({ length: GRID * GRID }, (_, id) => {
              const t = world.tiles[id];
              const ownerName =
                t &&
                (session
                  ? t.owner === me
                    ? 'alice'
                    : 'other'
                  : Object.values(players).find((p) => p.address === t.owner)?.name);
              const cls = [
                'tile',
                t ? `owner-${ownerName || 'other'}` : 'unclaimed',
                selected === id ? 'selected' : '',
              ].join(' ');
              return (
                <button
                  key={id}
                  className={cls}
                  title={`tile ${id}`}
                  onClick={() => setSelected(id)}
                >
                  {BUILDING_ICON[t?.building] || ''}
                </button>
              );
            })}
          </div>
          <div className="legend">
            <span>
              <i className="swatch owner-alice" /> {session ? 'your tiles' : 'alice'}
            </span>
            <span>
              <i className={`swatch owner-${session ? 'other' : 'bob'}`} />{' '}
              {session ? 'other players' : 'bob'}
            </span>
            <span>
              <i className="swatch unclaimed" /> unclaimed
            </span>
            <span>🌾 farm</span>
            <span>🪵 lumbermill</span>
          </div>

          <div className="market">
            <h3>market</h3>
            <div className="place-form">
              <span>sell</span>
              <input
                type="number"
                min="1"
                max={Number.MAX_SAFE_INTEGER}
                step="1"
                value={form.giveAmount}
                onChange={(e) => setForm({ ...form, giveAmount: Number(e.target.value) })}
              />
              <select
                value={form.give}
                onChange={(e) =>
                  setForm({
                    ...form,
                    give: e.target.value,
                    want: e.target.value === 'wood' ? 'wheat' : 'wood',
                  })
                }
              >
                <option value="wheat">🌾 wheat</option>
                <option value="wood">🪵 wood</option>
              </select>
              <span>for</span>
              <input
                type="number"
                min="1"
                max={Number.MAX_SAFE_INTEGER}
                step="1"
                value={form.wantAmount}
                onChange={(e) => setForm({ ...form, wantAmount: Number(e.target.value) })}
              />
              <span>
                {RESOURCE_ICON[form.want]} {form.want}
              </span>
              <button
                disabled={
                  unavailable ||
                  (account[form.give] ?? 0) < form.giveAmount ||
                  !validAmount(form.giveAmount) ||
                  !validAmount(form.wantAmount)
                }
                onClick={() =>
                  run(`sell ${form.giveAmount} ${form.give} for ${form.wantAmount} ${form.want}`, {
                    place_order: {
                      give: form.give,
                      give_amount: form.giveAmount,
                      want: form.want,
                      want_amount: form.wantAmount,
                    },
                  })
                }
              >
                place order
              </button>
            </div>
            {openOrders.length === 0 ? (
              <p className="hint">no open orders — goods escrow when you place one.</p>
            ) : (
              <div className="orders">
                {openOrders.map(([id, o]) => (
                  <div key={id} className="order">
                    <span className={`owner-text owner-${nameOf(o.maker)}`}>{nameOf(o.maker)}</span>
                    <span>
                      sells {o.give_amount} {RESOURCE_ICON[o.give]} for {o.want_amount}{' '}
                      {RESOURCE_ICON[o.want]}
                    </span>
                    {o.maker === me ? (
                      <button
                        disabled={unavailable}
                        onClick={() =>
                          run(`cancel order #${id}`, { cancel_order: { order_id: Number(id) } })
                        }
                      >
                        cancel
                      </button>
                    ) : (
                      <button
                        disabled={unavailable || !canAfford(o)}
                        onClick={() =>
                          run(`fill order #${id}`, { fill_order: { order_id: Number(id) } })
                        }
                      >
                        {canAfford(o) ? 'fill' : `need ${o.want_amount} ${RESOURCE_ICON[o.want]}`}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="player-switch">
            {session ? (
              <span>
                {me.slice(0, 16)}… · <a href="#/account">Manage account</a>
              </span>
            ) : (
              <>
                {Object.values(players).map((p) => (
                  <button
                    key={p.name}
                    className={`player-btn owner-${p.name} ${current === p.name ? 'active' : ''}`}
                    onClick={() => setCurrent(p.name)}
                  >
                    {p.name}
                  </button>
                ))}
              </>
            )}
          </div>
          {(balances[me] ?? 0n) < MAX_FEE && (
            <p className="hint">
              Check your <a href="#/account">Account</a> for CAI fees.
            </p>
          )}
          {Object.keys(world.tiles).length >= 144 && (
            <p className="hint">
              All 144 tiles are claimed. Trade goods or ask an owner to transfer land.
            </p>
          )}
          <p className="hint">
            Buildings grow one resource per block. Waiting alone does not advance growth.
          </p>

          <div className="resources">
            <div>
              <b>{account.wood}</b> 🪵 wood
            </div>
            <div>
              <b>{account.wheat}</b> 🌾 wheat
            </div>
            <div>
              <b>{balances[me]?.toString() ?? '…'}</b> 🪙 CAI
            </div>
          </div>

          {selected == null ? (
            <p className="hint">Select a tile to play.</p>
          ) : (
            <div className="tile-info">
              <h3>tile {selected}</h3>
              {tile ? (
                <>
                  <p>
                    owner:{' '}
                    <span className={`owner-text owner-${nameOf(tile.owner)}`}>
                      {nameOf(tile.owner)}
                    </span>
                  </p>
                  <p>building: {tile.building || 'none'}</p>
                  {tile.building && (
                    <p>
                      unharvested: ~{Math.max(growing, 0)} {tile.building === 'farm' ? '🌾' : '🪵'}
                    </p>
                  )}
                </>
              ) : (
                <p>unclaimed wilderness</p>
              )}
              <div className="actions">
                {!tile && (
                  <button
                    disabled={unavailable}
                    onClick={() =>
                      run(`claim tile ${selected}`, { claim_tile: { tile_id: selected } })
                    }
                  >
                    claim (+25 🪵)
                  </button>
                )}
                {mine && !tile.building && (
                  <>
                    <button
                      disabled={unavailable || account.wood < 10}
                      onClick={() =>
                        run(`build farm on ${selected}`, {
                          build: { tile_id: selected, kind: 'farm' },
                        })
                      }
                    >
                      build farm 🌾 (−10 🪵)
                    </button>
                    <button
                      disabled={unavailable || account.wood < 10}
                      onClick={() =>
                        run(`build lumbermill on ${selected}`, {
                          build: { tile_id: selected, kind: 'lumbermill' },
                        })
                      }
                    >
                      build lumbermill 🪵 (−10 🪵)
                    </button>
                  </>
                )}
                {mine && tile.building && (
                  <button
                    disabled={unavailable}
                    onClick={() =>
                      run(`harvest tile ${selected}`, { harvest: { tile_id: selected } })
                    }
                  >
                    harvest {BUILDING_ICON[tile.building]}
                  </button>
                )}
                {mine && (
                  <>
                    <label>
                      Recipient account address
                      <input
                        aria-label="Recipient account address"
                        value={recipient}
                        onChange={(e) => setRecipient(e.target.value.trim())}
                      />
                    </label>
                    <button
                      disabled={unavailable || !validAddress(recipient) || recipient === me}
                      onClick={() =>
                        run(`transfer ${selected}`, {
                          transfer_tile: { tile_id: selected, to: recipient },
                        })
                      }
                    >
                      transfer tile
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          <div className="log">
            {log.map((entry, i) => (
              <div key={i} className={entry.ok ? 'ok' : 'err'}>
                <span className="t">{entry.time}</span> {entry.text}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
