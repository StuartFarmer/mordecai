import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  connect,
  fetchBalance,
  fetchConfig,
  fetchMarket,
  fetchStatus,
  fetchWorld,
  play,
  trade,
} from './chain.js';

const GRID = 12;
const RESOURCE_ICON = { wood: '🪵', wheat: '🌾' };
const BUILDING_ICON = { farm: '🌾', lumbermill: '🪵' };

export default function App() {
  const [config, setConfig] = useState(null);
  const [error, setError] = useState(null);
  const [players, setPlayers] = useState({});
  const [current, setCurrent] = useState('alice');
  const [world, setWorld] = useState({ tiles: {}, accounts: {}, deliveries: {} });
  const [market, setMarket] = useState({});
  const [status, setStatus] = useState({ l1Height: 0, appHeight: 0, anchor: null });
  const [balances, setBalances] = useState({});
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState([]);
  const [form, setForm] = useState({ good: 'wood', amount: 10, price: 1000 });
  const logRef = useRef(log);
  logRef.current = log;

  const addLog = useCallback((entry) => {
    setLog([{ time: new Date().toLocaleTimeString(), ...entry }, ...logRef.current].slice(0, 12));
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await fetchConfig();
        if (!cfg.market)
          throw new Error('gateway has no outpost config — run scripts/outpost-demo.mjs');
        setConfig(cfg);
        const conns = {};
        for (const account of cfg.accounts) conns[account.name] = connect(cfg, account);
        setPlayers(conns);
      } catch (e) {
        setError(String(e.message || e));
      }
    })();
  }, []);

  const refresh = useCallback(async () => {
    if (!config) return;
    try {
      const [w, m, s] = await Promise.all([
        fetchWorld(config),
        fetchMarket(config),
        fetchStatus(config),
      ]);
      setWorld(w);
      setMarket(m);
      setStatus(s);
      const b = {};
      for (const p of Object.values(players)) b[p.name] = await fetchBalance(p);
      setBalances(b);
    } catch (e) {
      setError(String(e.message || e));
    }
  }, [config, players]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  const player = players[current];
  const me = player?.address;
  const goods = (me && world.accounts[me]) || { wood: 0, wheat: 0 };
  const nameOf = (addr) =>
    Object.values(players).find((p) => p.address === addr)?.name || addr.slice(0, 12) + '…';

  async function run(label, fn) {
    setBusy(true);
    try {
      const res = await fn();
      addLog({ ok: true, text: `${current}: ${label} (block ${res.height})` });
    } catch (e) {
      addLog({ ok: false, text: `${current}: ${label} — ${String(e.message || e)}` });
    }
    await refresh();
    setBusy(false);
  }

  if (error) return <div className="fatal">⚠️ {error}</div>;
  if (!config || !player) return <div className="fatal">connecting to gateways…</div>;

  const tile = selected != null ? world.tiles[selected] : undefined;
  const mine = tile && tile.owner === me;
  const growing = tile?.building ? status.appHeight - tile.last_tick_height : 0;
  const orders = Object.entries(market).sort(([a], [b]) => Number(a) - Number(b));

  const orderStatus = (id, o) => {
    if (o.phase === 2) return { text: 'cancelled', cls: 'err' };
    if (o.phase === 1) {
      const d = world.deliveries[id];
      return { text: `settled — ${d ? nameOf(d.seller) : 'seller'} paid ${o.price} 🪙`, cls: 'ok' };
    }
    if (world.deliveries[id]) {
      return {
        text: `delivered by ${nameOf(world.deliveries[id].seller)} — settling on next anchor…`,
        cls: 'hint',
      };
    }
    return null; // open
  };

  return (
    <div className="app">
      <header>
        <h1>outpost</h1>
        <span className="chain-meta">
          L1 block {status.l1Height} · game block {status.appHeight} · anchor epoch{' '}
          {status.anchor?.epoch ?? '—'} · one wallet, two chains
        </span>
      </header>

      <div className="columns">
        <div className="map">
          <div className="grid" style={{ gridTemplateColumns: `repeat(${GRID}, 1fr)` }}>
            {Array.from({ length: GRID * GRID }, (_, id) => {
              const t = world.tiles[id];
              const ownerName =
                t && Object.values(players).find((p) => p.address === t.owner)?.name;
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
              <i className="swatch owner-alice" /> alice
            </span>
            <span>
              <i className="swatch owner-bob" /> bob
            </span>
            <span>
              <i className="swatch unclaimed" /> unclaimed
            </span>
            <span>🌾 farm</span>
            <span>🪵 lumbermill</span>
          </div>

          <div className="market">
            <h3>goods market — in-game goods for L1 🪙</h3>
            <div className="place-form">
              <span>buy</span>
              <input
                type="number"
                min="1"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: Number(e.target.value) })}
              />
              <select
                value={form.good}
                onChange={(e) => setForm({ ...form, good: e.target.value })}
              >
                <option value="wood">🪵 wood</option>
                <option value="wheat">🌾 wheat</option>
              </select>
              <span>for</span>
              <input
                type="number"
                min="1"
                value={form.price}
                onChange={(e) => setForm({ ...form, price: Number(e.target.value) })}
              />
              <span>🪙</span>
              <button
                disabled={
                  busy || (balances[current] ?? 0) < form.price || form.amount < 1 || form.price < 1
                }
                onClick={() =>
                  run(
                    `escrow ${form.price} 🪙 for ${form.amount} ${RESOURCE_ICON[form.good]}`,
                    () =>
                      trade(
                        player,
                        config,
                        { place_order: { good: form.good, amount: form.amount } },
                        BigInt(form.price),
                      ),
                  )
                }
              >
                place order (escrows 🪙)
              </button>
            </div>
            {orders.length === 0 ? (
              <p className="hint">
                no orders — escrow L1 currency for goods someone grows in-game.
              </p>
            ) : (
              <div className="orders">
                {orders.map(([id, o]) => {
                  const st = orderStatus(id, o);
                  return (
                    <div key={id} className="order">
                      <span className={`owner-text owner-${nameOf(o.buyer)}`}>
                        {nameOf(o.buyer)}
                      </span>
                      <span>
                        buys {o.amount} {RESOURCE_ICON[o.good]} for {o.price} 🪙
                      </span>
                      {st ? (
                        <span className={`status ${st.cls}`}>{st.text}</span>
                      ) : o.buyer === me ? (
                        <button
                          disabled={busy}
                          onClick={() =>
                            run(`cancel order #${id}`, () =>
                              trade(player, config, { cancel_order: { order_id: Number(id) } }),
                            )
                          }
                        >
                          cancel
                        </button>
                      ) : (
                        <button
                          disabled={busy || (goods[o.good] ?? 0) < o.amount}
                          onClick={() =>
                            run(`deliver ${o.amount} ${o.good} to ${nameOf(o.buyer)}`, () =>
                              play(player, config, {
                                deliver: {
                                  order_id: Number(id),
                                  buyer: o.buyer,
                                  good: o.good,
                                  amount: o.amount,
                                },
                              }),
                            )
                          }
                        >
                          {(goods[o.good] ?? 0) >= o.amount
                            ? `deliver ${RESOURCE_ICON[o.good]} in-game`
                            : `need ${o.amount} ${RESOURCE_ICON[o.good]}`}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="panel">
          <div className="player-switch">
            {Object.values(players).map((p) => (
              <button
                key={p.name}
                className={`player-btn owner-${p.name} ${current === p.name ? 'active' : ''}`}
                onClick={() => setCurrent(p.name)}
              >
                {p.name}
              </button>
            ))}
          </div>

          <div className="resources">
            <div>
              <b>{goods.wood}</b> 🪵 wood <small>(game)</small>
            </div>
            <div>
              <b>{goods.wheat}</b> 🌾 wheat <small>(game)</small>
            </div>
            <div>
              <b>{balances[current] ?? '…'}</b> 🪙 CAI <small>(L1)</small>
            </div>
          </div>

          {selected == null ? (
            <p className="hint">Select a tile to play. Goods grow here; money lives on L1.</p>
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
                    disabled={busy}
                    onClick={() =>
                      run(`claim tile ${selected}`, () =>
                        play(player, config, { claim_tile: { tile_id: selected } }),
                      )
                    }
                  >
                    claim (+25 🪵)
                  </button>
                )}
                {mine && !tile.building && (
                  <>
                    <button
                      disabled={busy || goods.wood < 10}
                      onClick={() =>
                        run(`build farm on ${selected}`, () =>
                          play(player, config, { build: { tile_id: selected, kind: 'farm' } }),
                        )
                      }
                    >
                      build farm 🌾 (−10 🪵)
                    </button>
                    <button
                      disabled={busy || goods.wood < 10}
                      onClick={() =>
                        run(`build lumbermill on ${selected}`, () =>
                          play(player, config, {
                            build: { tile_id: selected, kind: 'lumbermill' },
                          }),
                        )
                      }
                    >
                      build lumbermill 🪵 (−10 🪵)
                    </button>
                  </>
                )}
                {mine && tile.building && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      run(`harvest tile ${selected}`, () =>
                        play(player, config, { harvest: { tile_id: selected } }),
                      )
                    }
                  >
                    harvest {BUILDING_ICON[tile.building]}
                  </button>
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
