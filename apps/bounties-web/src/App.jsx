import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { act, AWARD_WINDOW, encodeArgs, fetchBoard, MAX_FEE, phaseLabel } from './chain.js';

const empty = { bounties: {}, answers: {}, height: 0 };
export const DISCLOSURE =
  'Public and permanent. Do not include confidential sources, personal records, credentials or unpublished sensitive evidence.';

export default function App({ session, initialConfig: config }) {
  const wallet = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [board, setBoard] = useState(empty);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [lookup, setLookup] = useState('');
  const [form, setForm] = useState({ title: '', request: '', reward: '10000', duration: 5 });
  const [response, setResponse] = useState('');
  const [review, setReview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [receipt, setReceipt] = useState(null);
  const reviewButton = useRef(null);
  const refresh = useCallback(async () => {
    const next = await fetchBoard(config);
    setBoard(next);
    setLoaded(true);
    setError('');
    return next;
  }, [config]);
  useEffect(() => {
    let active = true;
    const poll = () =>
      refresh().catch((e) => {
        if (active) setError(e.message);
      });
    void poll();
    const timer = setInterval(poll, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    setReview(null);
  }, [wallet]);
  useEffect(() => {
    if (review) reviewButton.current?.focus();
  }, [review]);

  const bounty = board.bounties[selected];
  const answers = Object.values(board.answers).filter((a) => a.bounty_id === selected);
  const mine = bounty?.creator === wallet?.address;
  const available = wallet && loaded && !error && !busy;

  function prepare(action, fields, reward = '0', explanation = '') {
    try {
      encodeArgs(action, fields);
      if (!wallet) throw new Error('Open Wallet to continue.');
      if (
        action === 'create' &&
        (!/^[1-9][0-9]*$/.test(reward) || BigInt(reward) > 18446744073709551615n)
      )
        throw new Error('Reward must be a positive whole number of test CAI.');
      setReview({ action, fields, reward, explanation, wallet });
      setStatus('');
    } catch (e) {
      setStatus(e.message);
    }
  }

  async function confirm() {
    const draft = review;
    if (!draft || session.getSnapshot() !== draft.wallet || busy) {
      setReview(null);
      setStatus('Wallet changed. Review the action again.');
      return;
    }
    setBusy(true);
    setReceipt(null);
    setReview(null);
    setStatus(
      draft.action === 'create'
        ? 'Funding pending. Check Wallet for the transaction hash.'
        : 'Confirmation pending. Check Wallet for the transaction hash.',
    );
    try {
      const result = await act(draft.wallet, config, draft.action, draft.fields, draft.reward);
      if (!result.success) throw new Error('Transaction did not succeed. Check Wallet history.');
      setReceipt(result);
      let next;
      try {
        next = await refresh();
      } catch {
        setStatus(
          'Transaction confirmed; bounty status unavailable. Refresh before another action.',
        );
        return;
      }
      const id = draft.fields.bounty_id;
      if (draft.action === 'create') {
        const created = Object.values(next.bounties).find(
          (b) =>
            b.created_height === result.height &&
            b.creator === draft.wallet.address &&
            b.title === draft.fields.title &&
            b.request === draft.fields.request &&
            b.reward === draft.reward &&
            b.submit_end === draft.fields.submit_end,
        );
        if (!created) throw new Error('Transaction confirmed; matching funded bounty unavailable.');
        setSelected(created.id);
        setForm({ title: '', request: '', reward: '10000', duration: 5 });
        setStatus(`Bounty #${created.id} funded and confirmed.`);
      } else if (draft.action === 'respond') {
        const recorded = Object.values(next.answers).some(
          (a) =>
            a.bounty_id === id &&
            a.author === draft.wallet.address &&
            a.text === draft.fields.text &&
            a.submitted_height === result.height,
        );
        if (!recorded) throw new Error('Transaction confirmed; matching response unavailable.');
        setResponse('');
        setStatus('Response confirmed. No award is guaranteed.');
      } else {
        const expected = { award: 1, cancel: 2, refund: 3 }[draft.action];
        if (
          next.bounties[id]?.phase !== expected ||
          (draft.action === 'award' && next.bounties[id].winner !== draft.fields.response_id)
        )
          throw new Error('Transaction confirmed; settlement state unavailable.');
        setStatus(phaseLabel(next.bounties[id], next.height));
      }
    } catch (e) {
      setStatus(
        `${e.message} Check Wallet before retrying; an unknown confirmation is not a failed payment.`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="bounties-app">
      <header>
        <div>
          <p className="eyebrow">Public questions · funded rewards</p>
          <h1>Information bounties</h1>
        </div>
        <a href="#/wallet">{wallet ? 'Manage wallet' : 'Open Wallet'}</a>
      </header>
      <p>
        Fund a question. Share a public answer. The creator selects one response and pays its
        author.
      </p>
      <p className="policy">
        <strong>Test CAI only.</strong> Creator selection; no guaranteed award, even when useful
        answers exist. Unawarded rewards return to the creator after the award window. Fees are
        separate and never refunded.
      </p>
      <p className="network">
        Network: {config.chainId} · block {loaded ? board.height : '…'}
        <br />
        Contract: <code>{config.contract}</code>
      </p>
      <p>
        {wallet ? (
          <>
            Wallet: <code>{wallet.address}</code>
          </>
        ) : (
          <>
            Browse without a wallet. Open <a href="#/wallet">Wallet</a> to fund, respond, or settle.
          </>
        )}
      </p>
      {error && (
        <p role="alert">
          Could not refresh: {error}. Actions are disabled until chain state refreshes.{' '}
          <button onClick={() => refresh().catch((e) => setError(e.message))}>Retry</button>
        </p>
      )}
      <div role="status" aria-live="polite">
        {status}
        {receipt && (
          <p>
            Confirmed transaction:{' '}
            <a href={`/api/tx/${receipt.hash}`} target="_blank" rel="noreferrer">
              {receipt.hash}
            </a>{' '}
            · block {receipt.height} · fee {receipt.fee} test CAI
          </p>
        )}
      </div>
      {review && (
        <section className="review" aria-label="Review transaction">
          <h2>Review {review.action}</h2>
          <p>{review.explanation}</p>
          <p>
            Sender: <code>{review.wallet.address}</code>
            <br />
            Network: {config.chainId}
            <br />
            Contract: <code>{config.contract}</code>
            <br />
            Attached reward: {review.reward} test CAI. Fee limit: {MAX_FEE.toString()} test CAI.
          </p>
          {review.action === 'create' && (
            <>
              <h3>{review.fields.title}</h3>
              <p className="text">{review.fields.request}</p>
              <p>
                Submissions close at block {review.fields.submit_end}. Award window ends at block{' '}
                {review.fields.submit_end + AWARD_WINDOW}.
              </p>
            </>
          )}
          {review.action === 'respond' && (
            <>
              <p>
                Immutable payout address: <code>{review.wallet.address}</code>
              </p>
              <p className="text">{review.fields.text}</p>
            </>
          )}
          <p>{DISCLOSURE}</p>
          <button ref={reviewButton} onClick={confirm} disabled={busy || wallet !== review.wallet}>
            Confirm and send
          </button>{' '}
          <button onClick={() => setReview(null)}>Cancel review</button>
        </section>
      )}
      <div className="columns">
        <section aria-label="Bounty board">
          <h2>Funded requests</h2>
          <form
            className="lookup"
            onSubmit={(e) => {
              e.preventDefault();
              const id = Number(lookup);
              if (board.bounties[id]) setSelected(id);
              else setStatus('No confirmed bounty with that ID.');
            }}
          >
            <label>
              Bounty ID
              <input
                type="number"
                min="0"
                step="1"
                required
                value={lookup}
                onChange={(e) => setLookup(e.target.value)}
              />
            </label>
            <button disabled={!loaded}>Find</button>
          </form>
          {!loaded ? (
            <p>Loading confirmed requests…</p>
          ) : (
            !Object.keys(board.bounties).length && <p>No funded requests yet.</p>
          )}
          {Object.values(board.bounties)
            .reverse()
            .map((b) => (
              <button
                className={`card ${selected === b.id ? 'selected' : ''}`}
                key={b.id}
                onClick={() => {
                  setSelected(b.id);
                  setResponse('');
                  setReview(null);
                }}
              >
                <strong>
                  #{b.id} · {b.title}
                </strong>
                <span>
                  {b.reward} test CAI · {phaseLabel(b, board.height)}
                </span>
                <span>
                  {b.response_count} responses · submissions close at block {b.submit_end}
                </span>
                <span>Creator: {b.creator}</span>
              </button>
            ))}
        </section>
        <section aria-label="Bounty details">
          {bounty ? (
            <>
              <h2>
                #{bounty.id} · {bounty.title}
              </h2>
              <p>
                <strong>{bounty.reward} test CAI</strong> · {phaseLabel(bounty, board.height)}
              </p>
              <p className="text">{bounty.request}</p>
              <p>
                Creator: <code>{bounty.creator}</code>
              </p>
              <p>
                Funded at block {bounty.created_height}. Submissions close at block{' '}
                {bounty.submit_end}; selection ends at block {bounty.award_end}.
              </p>
              <p>
                Block heights enforce deadlines and advance with network activity. Waiting alone may
                not advance this demo chain. A stalled chain delays closure and refunds.
              </p>
              {!!bounty.phase && (
                <p>
                  Settlement confirmed in contract state at block {bounty.settled_height}.
                  {bounty.phase === 1 && (
                    <>
                      {' '}
                      Winner: response #{bounty.winner},{' '}
                      <code>{board.answers[bounty.winner]?.author}</code>.
                    </>
                  )}
                </p>
              )}
              {bounty.phase === 0 &&
                mine &&
                bounty.response_count === 0 &&
                board.height < bounty.submit_end && (
                  <button
                    disabled={!available}
                    onClick={() =>
                      prepare(
                        'cancel',
                        { bounty_id: bounty.id },
                        '0',
                        `Cancel bounty #${bounty.id} and return ${bounty.reward} test CAI to ${bounty.creator}.`,
                      )
                    }
                  >
                    Review cancellation
                  </button>
                )}
              {bounty.phase === 0 && board.height >= bounty.award_end && (
                <button
                  disabled={!available}
                  onClick={() =>
                    prepare(
                      'refund',
                      { bounty_id: bounty.id },
                      '0',
                      `Return ${bounty.reward} test CAI to creator ${bounty.creator}. The caller receives no reward.`,
                    )
                  }
                >
                  Review refund to creator
                </button>
              )}
              <h3>Responses ({answers.length})</h3>
              {answers.map((a) => (
                <article className="answer" key={a.id}>
                  <h4>
                    Response #{a.id}
                    {bounty.phase === 1 && bounty.winner === a.id ? ' · Award paid' : ''}
                  </h4>
                  <p>
                    <code>{a.author}</code> · block {a.submitted_height}
                  </p>
                  <p className="text">{a.text}</p>
                  {mine &&
                    bounty.phase === 0 &&
                    board.height >= bounty.submit_end &&
                    board.height < bounty.award_end && (
                      <button
                        disabled={!available}
                        onClick={() =>
                          prepare(
                            'award',
                            { bounty_id: bounty.id, response_id: a.id },
                            '0',
                            `Irreversibly award the full ${bounty.reward} test CAI to response #${a.id}, author ${a.author}. Non-winners receive nothing.`,
                          )
                        }
                      >
                        Review award to this response
                      </button>
                    )}
                </article>
              ))}
              {bounty.phase === 0 && board.height < bounty.submit_end && !mine && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    prepare(
                      'respond',
                      { bounty_id: bounty.id, text: response },
                      '0',
                      `Submit to bounty #${bounty.id}. Your wallet address is the immutable payout recipient.`,
                    );
                  }}
                >
                  <h3>Submit a public response</h3>
                  <p>{DISCLOSURE}</p>
                  <label>
                    Answer and public source URLs (8 KiB UTF-8 maximum)
                    <textarea
                      required
                      value={response}
                      onChange={(e) => setResponse(e.target.value)}
                    />
                  </label>
                  <button disabled={!available}>Review response</button>
                </form>
              )}
            </>
          ) : (
            <p>Select a request to read its criteria and responses.</p>
          )}
        </section>
      </div>
      <section className="create">
        <h2>Fund a new question</h2>
        <p>{DISCLOSURE}</p>
        <p>
          One winner, chosen by you during the {AWARD_WINDOW}-block award window. Cancel only before
          the first response and before submissions close. If you choose nobody, anyone can trigger
          the final refund to you.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            prepare(
              'create',
              {
                title: form.title,
                request: form.request,
                submit_end: board.height + Number(form.duration),
              },
              form.reward,
            );
          }}
        >
          <label>
            Title (160 UTF-8 bytes maximum)
            <input
              required
              maxLength="160"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </label>
          <label>
            Request, acceptance criteria, requested sources and any publication terms (8 KiB UTF-8
            maximum)
            <textarea
              required
              value={form.request}
              onChange={(e) => setForm({ ...form, request: e.target.value })}
            />
          </label>
          <div className="fields">
            <label>
              Reward (whole test CAI)
              <input
                required
                inputMode="numeric"
                pattern="[1-9][0-9]*"
                value={form.reward}
                onChange={(e) => setForm({ ...form, reward: e.target.value })}
              />
            </label>
            <label>
              Submission duration
              <select
                value={form.duration}
                onChange={(e) => setForm({ ...form, duration: Number(e.target.value) })}
              >
                <option value="5">5 blocks · quick demo</option>
                <option value="100">100 blocks</option>
                <option value="500">500 blocks</option>
                <option value="2000">2,000 blocks</option>
              </select>
            </label>
          </div>
          <button disabled={!available}>Review funding</button>
          <p>
            Funds stay in your wallet until you confirm. A draft is not a funded request. Get test
            tokens from <a href="#/faucet">Faucet</a>.
          </p>
        </form>
      </section>
      <footer>
        Plain text and public links only; no private evidence or uploads. Historical funding and
        settlement are recoverable by bounty ID and block height. Transaction hashes appear here for
        this session and in Wallet history; local history can be lost on reload.
      </footer>
    </main>
  );
}
