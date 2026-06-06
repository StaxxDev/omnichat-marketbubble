'use strict';

const { makeMessage } = require('../schema');

const SEARCH_URL = 'https://api.twitter.com/2/tweets/search/recent';
const POLL_MS = 12000;

// X / Twitter polling connector. No live chat — we poll recent search and stream new tweets.
// mode = replies | mentions | hashtag ; target = conversation id / handle / tag.
function startX({ bearer, mode, target }, emit, log) {
  if (!bearer) {
    log('x: no X_BEARER_TOKEN — connector skipped.');
    return () => {};
  }
  if (!target) {
    log('x: no X_TARGET configured — connector skipped.');
    return () => {};
  }

  let closed = false;
  let sinceId = null;
  let timer = null;

  function buildQuery() {
    if (mode === 'mentions') return `@${target} -is:retweet`;
    if (mode === 'hashtag') return `#${target} -is:retweet`;
    return `conversation_id:${target}`; // default: replies
  }

  async function poll() {
    if (closed) return;
    const params = new URLSearchParams({
      query: buildQuery(),
      max_results: '100',
      'tweet.fields': 'created_at,author_id',
      expansions: 'author_id',
      'user.fields': 'username',
    });
    if (sinceId) params.set('since_id', sinceId);

    let nextDelay = POLL_MS;
    try {
      const res = await fetch(`${SEARCH_URL}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${bearer}` },
      });

      if (res.status === 429) {
        nextDelay = 60000; // rate limited — back off, keep running
        log('x: 429 rate-limited, backing off 60s');
      } else if (!res.ok) {
        nextDelay = 30000;
        log(`x: search returned ${res.status}, retrying in 30s`);
      } else {
        const json = await res.json();
        const tweets = (json && json.data) || [];
        const users = {};
        const inc = json && json.includes && json.includes.users;
        if (inc) for (const u of inc) users[u.id] = u.username;

        // data[] is newest-first -> reverse to chronological
        const chrono = tweets.slice().reverse();
        for (const t of chrono) {
          if (!sinceId || BigInt(t.id) > BigInt(sinceId)) sinceId = t.id;
          emit(
            makeMessage({
              id: `x-${t.id}`,
              source: 'x',
              channel: `${mode || 'replies'}:${target}`,
              author: users[t.author_id] || t.author_id || 'unknown',
              text: t.text,
              color: '',
              ts: t.created_at ? Date.parse(t.created_at) || Date.now() : Date.now(),
            })
          );
        }
        if (chrono.length) log(`x: +${chrono.length} new tweet(s) (since_id=${sinceId})`);
      }
    } catch (err) {
      nextDelay = 30000;
      log(`x: poll error ${err.message}, retrying in 30s`);
    }

    if (!closed) timer = setTimeout(poll, nextDelay);
  }

  log(`x: polling every ${POLL_MS / 1000}s — mode=${mode || 'replies'} target=${target}`);
  poll();

  return function stop() {
    closed = true;
    if (timer) clearTimeout(timer);
  };
}

module.exports = { startX };
