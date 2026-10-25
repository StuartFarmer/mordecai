import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  connect,
  fundApp,
  fetchBalance,
  fetchConfig,
  fetchMarket,
  fetchStatus,
  fetchWorld,
  play,
  trade,
} from './chain.js';

const noSubscribe = () => () => {};
const noPlayer = () => null;
const GRID = 12;
const RESOURCE_ICON = { wood: '🪵', wheat: '🌾' };
const BUILDING_ICON = { farm: '🌾', lumbermill: '🪵' };

export default function App({ session, initialConfig }) {
  const sharedPlayer = useSyncExternalStore(
    session?.subscribe ?? noSubscribe,
    session?.getSnapshot ?? noPlayer,
  );
  const currentPlayer = useRef(sharedPlayer);
  currentPlayer.current = sharedPlayer;
  const [config, setConfig] = useState(initialConfig ?? null);
  const [error, setError] = useState(null);
  const [players, setPlayers] = useState({});
  const [current, setCurrent] = useState('alice');
  const [world, setWorld] = useState({ tiles: {}, accounts: {}, deliveries: {} });
  const [market, setMarket] = useState({});
  const [status, setStatus] = useState({ l1Height: 0, appHeight: 0, anchor: null });
  const [balances, setBalances] = useState({});
  const [appBalances, setAppBalances] = useState({});
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
        const cfg = initialConfig ?? (await fetchConfig());
        if (!cfg.market)
          throw new Error('gateway has no outpost config — run scripts/outpost-demo.mjs');
        setConfig(cfg);
        const conns = {};
        if (session) {
          const snapshot = sharedPlayer;
          if (snapshot) conns.you = { ...snapshot, name: 'you' };
          setCurrent('you');
        } else for (const account of cfg.accounts) conns[account.name] = connect(cfg, account);
        setPlayers(conns);
      } catch (e) {
        setError(String(e.message || e));
      }
    })();
  }, [session, initialConfig, sharedPlayer]);

  const refresh = useCallback(async () => {
    if (!config) return;
    const snapshot = sharedPlayer;
    try {
      const [w, m, s] = await Promise.all([
        fetchWorld(config),
        fetchMarket(config),
        fetchStatus(config),
      ]);
      if (session && snapshot !== currentPlayer.current) return;
      setWorld(w);
      setMarket(m);
      setStatus(s);
      const b = {};
      const fees = {};
      for (const p of Object.values(players)) {
        b[p.name] = await fetchBalance(p);
        fees[p.name] = await fetchBalance(p, config.appApi);
      }
      if (session && snapshot !== currentPlayer.current) return;
      setBalances(b);
      setAppBalances(fees);
    } catch (e) {
      setError(String(e.message || e));
    }
  }, [config, players, session, sharedPlayer]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);

  const player = session ? sharedPlayer && { ...sharedPlayer, name: 'you' } : players[current];
  const me = player?.address;
  const goods = (me && world.accounts[me]) || { wood: 0, wheat: 0 };
  const nameOf = (addr) =>
    Object.values(players).find((p) => p.address === addr)?.name || addr.slice(0, 12) + '…';

  async function run(label, fn) {
    const snapshot = sharedPlayer;
    setBusy(true);
    addLog({ ok: true, text: `${current}: ${label} — submitted; awaiting confirmation` });
    try {
      const res = await fn();
      if (session && snapshot !== currentPlayer.current) {
        setBusy(false);
        return;
      }
      addLog({ ok: true, text: `${current}: ${label} (block ${res.height})` });
    } catch (e) {
      if (session && snapshot !== currentPlayer.current) {
        setBusy(false);
        return;
      }
      addLog({ ok: false, text: `${current}: ${label} — ${String(e.message || e)}` });
    }
    await refresh();
    setBusy(false);
  }

  if (error) return <div className="fatal">⚠️ {error}</div>;
  if (session && !player)
    return (
      <div className="fatal">
        <a href="#/wallet">Open Wallet to trade on Outpost</a>
      </div>
    );
  if (!config || !player) return <div className="fatal">connecting to gateways…</div>;

  const tile = selected != null ? world.tiles[selected] : undefined;
  const mine = tile && tile.owner === me;
  const growing = tile?.building ? status.appHeight - tile.last_tick_height : 0;
  const orders = Object.entries(market).sort(([a], [b]) => Number(a) - Number(b));

  const orderStatus = (id, o) => {
    if (o.phase === 2) return { text: 'Cancelled · escrow refunded', cls: 'err' };
    if (o.phase === 1) {
      const d = world.deliveries[id];
      return {
        text: `Paid on L1 — ${d ? nameOf(d.seller) : 'seller'} paid ${o.price} 🪙`,
        cls: 'ok',
      };
    }
    if (world.deliveries[id]) {
      const d = world.deliveries[id];
      if (d.buyer !== o.buyer || d.good !== o.good || d.amount !== o.amount)
        return { text: 'delivery mismatch — buyer can cancel and place a new order', cls: 'err' };
      return {
        text: `Delivered by ${nameOf(world.deliveries[id].seller)} · awaiting verified anchor and L1 payment…`,
        cls: 'hint',
      };
    }
    return null; // open
  };

  return (
    <div className="app">
      <header>
        <div>
          <p className="eyebrow">Cross-chain goods exchange</p>
          <h1>Outpost</h1>
          <p className="intro">Buy goods. Fulfill orders. Get paid on L1.</p>
        </div>
        <span className="chain-meta">
          L1 block {status.l1Height} · app block {status.appHeight} · anchor epoch{' '}
          {status.anchor?.epoch ?? '—'} · one wallet, two chains
        </span>
      </header>

      <ol className="trade-flow" aria-label="How an order settles">
        <li>
          <b>1 · Buy</b>
          <span>Lock test CAI in an L1 order.</span>
        </li>
        <li>
          <b>2 · Fulfill</b>
          <span>A supplier delivers goods on the app chain.</span>
        </li>
        <li>
          <b>3 · Settle</b>
          <span>A verified anchor releases payment on L1.</span>
        </li>
      </ol>

      <div className="columns">
        <main className="exchange">
          <div className="market">
            <h2>Buy goods</h2>
            <p className="hint">
              Offer a total payment in test CAI. Your order holds it in escrow until settlement or
              cancellation.
            </p>
            <div className="place-form">
              <span>buy</span>
              <input
                aria-label="Quantity to buy"
                type="number"
                min="1"
                step="1"
                value={form.amount}
                onChange={(e) => setForm({ ...form, amount: Number(e.target.value) })}
              />
              <select
                aria-label="Goods to buy"
                value={form.good}
                onChange={(e) => setForm({ ...form, good: e.target.value })}
              >
                <option value="wood">🪵 wood</option>
                <option value="wheat">🌾 wheat</option>
              </select>
              <span>for</span>
              <input
                aria-label="Total payment in test CAI"
                type="number"
                min="1"
                step="1"
                value={form.price}
                onChange={(e) => setForm({ ...form, price: Number(e.target.value) })}
              />
              <span>🪙</span>
              <button
                disabled={
                  busy ||
                  (balances[current] ?? 0) < form.price + 500000 ||
                  !Number.isSafeInteger(form.amount) ||
                  !Number.isSafeInteger(form.price) ||
                  form.amount < 1 ||
                  form.price < 1
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
                Place buy order
              </button>
            </div>
            <p className="hint">Keep 500000 L1 fee units available in addition to your offer.</p>
          </div>
          <section className="market" aria-labelledby="orders-heading">
            <h2 id="orders-heading">Orders &amp; settlement</h2>
            <p className="hint">
              Supply an open order from your inventory. Delivered orders wait for an anchor; only
              confirmed L1 state means the supplier is paid.
            </p>
            {orders.length === 0 ? (
              <p className="hint">
                No orders yet. Place the first buy order, then use another wallet to fulfill it.
              </p>
            ) : (
              <div className="orders">
                {orders.map(([id, o]) => {
                  const st = orderStatus(id, o);
                  return (
                    <article key={id} className="order" aria-label={`Order ${id}`}>
                      <div className="order-heading">
                        <b>
                          #{id} · {o.amount} {RESOURCE_ICON[o.good]} {o.good}
                        </b>
                        <b>{o.price} test CAI</b>
                      </div>
                      <span className="hint">
                        Buyer: {nameOf(o.buyer)}
                        {o.buyer === me ? ' (you)' : ''}
                      </span>
                      <span className={`status ${st?.cls ?? 'open'}`}>
                        {st?.text ?? 'Open · payment escrowed, awaiting supplier'}
                      </span>
                      {o.phase === 0 && o.buyer === me ? (
                        <button
                          disabled={busy}
                          onClick={() =>
                            run(`cancel order #${id}`, () =>
                              trade(player, config, { cancel_order: { order_id: Number(id) } }),
                            )
                          }
                        >
                          Cancel & refund escrow
                        </button>
                      ) : st ? null : (
                        <button
                          disabled={
                            busy ||
                            (appBalances[current] ?? 0) < 500000 ||
                            (goods[o.good] ?? 0) < o.amount
                          }
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
                            ? `Fulfill order · deliver ${o.amount} ${o.good}`
                            : `need ${o.amount} ${RESOURCE_ICON[o.good]}`}
                        </button>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
            <p className="exchange-limit">
              MVP limitation: delivery and cancellation commit on separate chains. A cancellation
              racing a delivery can leave goods unpaid.
            </p>
          </section>
        </main>

        <aside className="panel">
          <h2>Your trading account</h2>
          <div className="player-switch">
            {session && (
              <>
                <a href="#/wallet">Manage wallet</a>
                <a href="#/faucet">L1 Faucet</a>
                <button
                  disabled={busy}
                  onClick={() => run('fund app fees', () => fundApp(player, config))}
                >
                  Fund app fees
                </button>
              </>
            )}
            {!session &&
              Object.values(players).map((p) => (
                <button
                  key={p.name}
                  className={`player-btn owner-${p.name} ${current === p.name ? 'active' : ''}`}
                  onClick={() => setCurrent(p.name)}
                >
                  {p.name}
                </button>
              ))}
          </div>

          <p className="hint">
            App fee balance: {appBalances[current] ?? '…'}. Each move reserves up to 500000 fee
            units.
          </p>
          <h3>Available inventory &amp; funds</h3>
          <div className="resources">
            <div>
              <b>{goods.wood}</b> 🪵 wood <small>(app chain)</small>
            </div>
            <div>
              <b>{goods.wheat}</b> 🌾 wheat <small>(app chain)</small>
            </div>
            <div>
              <b>{balances[current] ?? '…'}</b> 🪙 test CAI <small>(L1)</small>
            </div>
          </div>

          <p className="hint">
            Need stock to fulfill an order? Open Supply &amp; production below. Claim a tile for 25
            wood, or build and harvest more goods.
          </p>
          <h3>Transaction activity</h3>
          <div className="log" aria-live="polite">
            {log.map((entry, i) => (
              <div key={i} className={entry.ok ? 'ok' : 'err'}>
                <span className="t">{entry.time}</span> {entry.text}
              </div>
            ))}
          </div>
        </aside>
      </div>
      <details className="supply">
        <summary>
          Supply &amp; production <span>Grow inventory for your next delivery</span>
        </summary>
        <p className="hint">
          Claim land for starter wood, then build a farm or lumbermill. Production grows with
          app-chain blocks; harvest to add goods to your inventory.
        </p>
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
                    aria-label={`Tile ${id}: ${t ? `${nameOf(t.owner)}, ${t.building || 'no building'}` : 'unclaimed'}`}
                    aria-pressed={selected === id}
                    onClick={() => setSelected(id)}
                  >
                    {BUILDING_ICON[t?.building] || ''}
                  </button>
                );
              })}
            </div>
            <div className="legend">
              <span>
                <i className="swatch owner-alice" /> {session ? 'your land' : 'alice'}
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
          </div>
          <div className="supply-actions">
            {selected == null ? (
              <p className="hint">Select a tile to claim, build or harvest inventory.</p>
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
                        unharvested: ~{Math.max(growing, 0)}{' '}
                        {tile.building === 'farm' ? '🌾' : '🪵'}
                      </p>
                    )}
                  </>
                ) : (
                  <p>unclaimed wilderness</p>
                )}
                <div className="actions">
                  {!tile && (
                    <button
                      disabled={busy || (appBalances[current] ?? 0) < 500000}
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
                        disabled={busy || (appBalances[current] ?? 0) < 500000 || goods.wood < 10}
                        onClick={() =>
                          run(`build farm on ${selected}`, () =>
                            play(player, config, { build: { tile_id: selected, kind: 'farm' } }),
                          )
                        }
                      >
                        build farm 🌾 (−10 🪵)
                      </button>
                      <button
                        disabled={busy || (appBalances[current] ?? 0) < 500000 || goods.wood < 10}
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
                      disabled={busy || (appBalances[current] ?? 0) < 500000}
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
          </div>
        </div>
      </details>
    </div>
  );
}
