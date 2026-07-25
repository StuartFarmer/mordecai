import React, { useCallback, useEffect, useRef, useState } from 'react';
import { act, connect, fetchBalance, fetchConfig, fetchHeight, fetchWorld } from './chain.js';

const GRID = 12; // show tiles 0..143 of the map
const RESOURCE_ICON = { wood: '🪵', wheat: '🌾' };
const BUILDING_ICON = { farm: '🌾', lumbermill: '🪵' };

export default function App() {
  const [config, setConfig] = useState(null);
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
  }, []);

  const refresh = useCallback(async () => {
    if (!config) return;
    try {
      const [w, h] = await Promise.all([fetchWorld(config), fetchHeight()]);
      setWorld(w);
      setHeight(h);
      const b = {};
      for (const p of Object.values(players)) b[p.name] = await fetchBalance(p);
      setBalances(b);
    } catch (e) {
      setError(String(e.message || e));
    }
  }, [config, players]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, [refresh]);

  const player = players[current];
  const me = player?.address;
  const account = (me && world.accounts[me]) || { wood: 0, wheat: 0 };
  const nameOf = (addr) =>
    Object.values(players).find((p) => p.address === addr)?.name || addr.slice(0, 12) + '…';

  async function run(label, msg) {
    setBusy(true);
    try {
      const res = await act(player, config, msg);
      addLog({ ok: true, text: `${current}: ${label} (block ${res.height}, fee ${res.gasUsed})` });
    } catch (e) {
      const m = String(e.message || e);
      addLog({ ok: false, text: `${current}: ${label} — ${m}` });
    }
    await refresh();
    setBusy(false);
  }

  if (error) return <div className="fatal">⚠️ {error}</div>;
  if (!config || !player) return <div className="fatal">connecting to gateway…</div>;

  const tile = selected != null ? world.tiles[selected] : undefined;
  const mine = tile && tile.owner === me;
  const other = Object.values(players).find((p) => p.name !== current);
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
            <h3>market</h3>
            <div className="place-form">
              <span>sell</span>
              <input
                type="number"
                min="1"
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
                value={form.wantAmount}
                onChange={(e) => setForm({ ...form, wantAmount: Number(e.target.value) })}
              />
              <span>
                {RESOURCE_ICON[form.want]} {form.want}
              </span>
              <button
                disabled={
                  busy ||
                  (account[form.give] ?? 0) < form.giveAmount ||
                  form.giveAmount < 1 ||
                  form.wantAmount < 1
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
                        disabled={busy}
                        onClick={() =>
                          run(`cancel order #${id}`, { cancel_order: { order_id: Number(id) } })
                        }
                      >
                        cancel
                      </button>
                    ) : (
                      <button
                        disabled={busy || !canAfford(o)}
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
              <b>{account.wood}</b> 🪵 wood
            </div>
            <div>
              <b>{account.wheat}</b> 🌾 wheat
            </div>
            <div>
              <b>{balances[current] ?? '…'}</b> 🪙 CAI
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
                    disabled={busy}
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
                      disabled={busy || account.wood < 10}
                      onClick={() =>
                        run(`build farm on ${selected}`, {
                          build: { tile_id: selected, kind: 'farm' },
                        })
                      }
                    >
                      build farm 🌾 (−10 🪵)
                    </button>
                    <button
                      disabled={busy || account.wood < 10}
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
                    disabled={busy}
                    onClick={() =>
                      run(`harvest tile ${selected}`, { harvest: { tile_id: selected } })
                    }
                  >
                    harvest {BUILDING_ICON[tile.building]}
                  </button>
                )}
                {mine && other && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      run(`transfer ${selected} to ${other.name}`, {
                        transfer_tile: { tile_id: selected, to: other.address },
                      })
                    }
                  >
                    give to {other.name}
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
