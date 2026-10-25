import React, { useEffect, useRef, useState } from 'react';
import { microblogPostId, verifyMicroblogPost } from '@mordecai/wallet/microblog';
import { persistAndSubmitTip } from './tip-flow.js';

async function api(path, body) {
  const response = await fetch(path, {
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
    ...(body
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'This node is unavailable. Please retry.');
  return data;
}
function selectedPost() {
  const [route, query = ''] = location.hash.split('?');
  const id = route === '#/demos/microblog' ? new URLSearchParams(query).get('post') : '';
  return /^[a-f0-9]{64}$/.test(id || '') ? id : '';
}
const short = (address) => `${address.slice(0, 10)}…${address.slice(-6)}`;
export default function App({ session, config }) {
  const [player, setPlayer] = useState(() => session.getSnapshot()),
    [text, setText] = useState('');
  const [feed, setFeed] = useState(null),
    [selected, setSelected] = useState(selectedPost),
    [error, setError] = useState('');
  const [busy, setBusy] = useState(false),
    [pendingPost, setPendingPost] = useState(null),
    [tipPost, setTipPost] = useState(null);
  const [amount, setAmount] = useState('100'),
    [review, setReview] = useState(null),
    [notice, setNotice] = useState('');
  const lock = useRef(false),
    reviewRef = useRef(null);
  const current = () => {
    if (!player || session.getSnapshot() !== player)
      throw new Error('Wallet changed. Open the current wallet to continue.');
    return player;
  };
  const verify = (post) => {
    if (
      !post.hidden &&
      (verifyMicroblogPost(post.envelope) !== post.author ||
        microblogPostId(post.envelope) !== post.id ||
        post.envelope.message.chainId !== config.chainId ||
        post.envelope.message.feedId !== config.feedId ||
        post.text !== post.envelope.message.text)
    )
      throw new Error('Invalid signed post received from this node');
    return post;
  };
  const read = async () => {
    const data = selected
      ? { posts: [await api(`${config.api}/posts/${selected}`)], next: null }
      : await api(`${config.api}/feed`);
    data.posts.forEach(verify);
    return data;
  };
  useEffect(
    () =>
      session.subscribe(() => {
        setPlayer(session.getSnapshot());
        setReview(null);
        reviewRef.current = null;
        setTipPost(null);
        setPendingPost(null);
        setNotice('');
      }),
    [session],
  );
  useEffect(() => {
    const changed = () => setSelected(selectedPost());
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  useEffect(() => {
    let live = true;
    const refresh = async () => {
      try {
        const data = await read();
        if (live)
          setFeed((previous) =>
            !selected && previous?.posts.length > 20
              ? {
                  ...previous,
                  posts: [
                    ...data.posts,
                    ...previous.posts.filter(
                      (p) => p.sequence < (data.posts.at(-1)?.sequence ?? 0),
                    ),
                  ],
                }
              : data,
          );
      } catch (e) {
        if (live) setError(e.message);
      }
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [selected, config]);
  useEffect(
    () => () => {
      const saved = reviewRef.current;
      if (saved) saved.player.cancelMicroblogTip(saved.prepared);
    },
    [],
  );
  const run = async (fn) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const publish = async () => {
    const signer = current();
    const envelope =
      pendingPost ||
      (await signer.signMicroblogPost({
        version: 1,
        chainId: config.chainId,
        feedId: config.feedId,
        nonce: Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
          b.toString(16).padStart(2, '0'),
        ).join(''),
        text,
      }));
    current();
    setPendingPost(envelope);
    await api(`${config.api}/posts`, envelope);
    current();
    setPendingPost(null);
    setText('');
    setNotice('Signed post accepted by this node.');
    setFeed(await read());
  };
  const cancel = () => {
    if (review) review.player.cancelMicroblogTip(review.prepared);
    reviewRef.current = null;
    setReview(null);
    setTipPost(null);
  };
  const prepare = async () => {
    const signer = current(),
      prepared = await signer.prepareMicroblogTip(tipPost.author, amount);
    current();
    const draft = { prepared, player: signer, post: tipPost };
    reviewRef.current = draft;
    setReview(draft);
  };
  const send = async () => {
    const receipt = await persistAndSubmitTip({
      player: current(),
      prepared: review.prepared,
      postId: review.post.id,
      config,
      current,
      request: api,
      onSubmitting: () => {
        setNotice(
          `Payment ${review.prepared.hash} is submitted or awaiting confirmation. Check Wallet for its status; an uncertain payment must be retried there using the same bytes.`,
        );
        reviewRef.current = null;
        setReview(null);
        setTipPost(null);
      },
    });
    current();
    setNotice(
      `Tip transaction ${receipt.hash} confirmed. This node will refresh its linked total after verification.`,
    );
    setFeed(await read());
  };
  const hide = async (post) => {
    const envelope = await current().signMicroblogHide({
      version: 1,
      chainId: config.chainId,
      feedId: config.feedId,
      postId: post.id,
    });
    current();
    await api(`${config.api}/posts/${post.id}/hide`, envelope);
    setFeed(await read());
  };
  return (
    <main>
      <header>
        <p className="eyebrow">THIS NODE’S FEED · TEST TOKENS</p>
        <h1>Microblog</h1>
        <p>Share a thought. Send a little CAI to a post you appreciate.</p>
      </header>
      <p className="wallet">
        {player ? (
          <>
            Wallet <span title={player.address}>{short(player.address)}</span>
          </>
        ) : (
          'Read freely. Open a wallet to publish or tip.'
        )}{' '}
        · <a href="#/wallet">Wallet</a> · <a href="#/faucet">Faucet</a>
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {!selected && (
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            run(publish);
          }}
        >
          <label htmlFor="post-text">What’s on your mind?</label>
          <textarea
            id="post-text"
            rows="3"
            value={text}
            disabled={!!pendingPost}
            onChange={(event) => setText(event.target.value)}
            placeholder="A small idea worth sharing…"
          />
          <div className="row">
            <span>{[...text].length}/280 · Signed post · Free</span>
            <button disabled={!player || busy || !text.trim() || [...text].length > 280}>
              {pendingPost ? 'Retry identical signed post' : 'Publish post'}
            </button>
          </div>
          <small>Public plain text. Do not post secrets or private information.</small>
        </form>
      )}
      {selected && (
        <p>
          <a href="#/demos/microblog">← All posts</a>
        </p>
      )}
      {!feed && <p role="status">Loading this node’s feed…</p>}
      {feed?.posts.length === 0 && (
        <section className="empty">
          <h2>A fresh page</h2>
          <p>Be the first to share a signed post on this node.</p>
        </section>
      )}
      {feed?.posts.map((post) => (
        <article key={post.id}>
          <div className="row">
            <span title={post.author} className="author">
              {short(post.author)}
            </span>
            <a href={`#/demos/microblog?post=${post.id}`}>
              <time dateTime={post.acceptedAt}>{new Date(post.acceptedAt).toLocaleString()}</time>
            </a>
          </div>
          <p className="post">
            {post.hidden ? 'This post has been hidden. Its payment history remains.' : post.text}
          </p>
          <details>
            <summary>Author address</summary>
            <code>{post.author}</code>
          </details>
          <div className="row">
            <strong>
              {post.confirmedAmount} CAI <small>confirmed</small>
            </strong>
            {!post.hidden && (
              <button
                disabled={!player || busy || !!tipPost || post.author === player?.address}
                onClick={() => {
                  setTipPost(post);
                  setAmount('100');
                  setError('');
                }}
              >
                Tip
              </button>
            )}
          </div>
          {post.author === player?.address && !post.hidden && (
            <details>
              <summary>Manage your post</summary>
              <p>
                Hiding removes text from this node’s public feed. Copies, backups and payments
                remain.
              </p>
              <button disabled={busy || !!review} onClick={() => run(() => hide(post))}>
                Sign and hide post
              </button>
            </details>
          )}
          {post.author === player?.address && <small>You cannot tip your own posts.</small>}
          {post.tips.length > 0 && (
            <details>
              <summary>
                {post.tipCount} linked payment{post.tipCount === 1 ? '' : 's'}
              </summary>
              <ul>
                {post.tips.map((tip) => (
                  <li key={tip.hash}>
                    {tip.amount} CAI · {tip.status} ·{' '}
                    <a href={`/api/tx/${tip.hash}`} target="_blank" rel="noreferrer">
                      Receipt {tip.hash.slice(0, 10)}
                    </a>
                  </li>
                ))}
              </ul>
              <small>
                Latest 50 links shown. Pending links may not have been broadcast. No automatic
                payment is sent on reload.
              </small>
            </details>
          )}
        </article>
      ))}
      {tipPost && (
        <section className="tip" role="region" aria-label="Review tip">
          <h2>{review ? 'Review your tip' : 'Tip this post'}</h2>
          <p className="post">{tipPost.text}</p>
          <p>
            Post <code>{tipPost.id}</code>
          </p>
          <p>
            Recipient <code>{tipPost.author}</code>
          </p>
          {review ? (
            <>
              <p>Network: {review.prepared.chainId}</p>
              <p>
                Amount: <strong>{review.prepared.amount} CAI base units</strong>
              </p>
              <p>Maximum network fee: {review.prepared.maxFee} CAI base units (separate)</p>
              <p>A direct payment to this author. Tips cannot be refunded here.</p>
              <button disabled={busy} onClick={() => run(send)}>
                Send tip
              </button>
            </>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                run(prepare);
              }}
            >
              <label>
                Amount (whole CAI base units)
                <input
                  inputMode="numeric"
                  pattern="[0-9]+"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  required
                />
              </label>
              <button disabled={busy}>Review tip</button>
            </form>
          )}
          <button className="secondary" disabled={busy} onClick={cancel}>
            Cancel
          </button>
        </section>
      )}
      {feed?.next && !selected && (
        <button
          disabled={busy}
          onClick={() =>
            run(async () => {
              const older = await api(`${config.api}/feed?before=${feed.next}`);
              older.posts.forEach(verify);
              setFeed({ ...older, posts: [...feed.posts, ...older.posts] });
            })
          }
        >
          Older posts
        </button>
      )}
      {busy && <p role="status">Waiting for this node…</p>}
      <footer>
        Confirmed tips linked on this node. Publishing is signed off-chain; payments use CAI test
        tokens. This feed is hosted and moderated by its node operator.
      </footer>
    </main>
  );
}
