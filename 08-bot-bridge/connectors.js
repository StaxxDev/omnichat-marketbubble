'use strict';
// connectors.js — Twitch (anon IRC), Kick (Pusher), X (polling), plus DEMO MODE.
// Every connector emits the unified message schema via the provided `emit(msg)` callback:
//   { id, source, channel, author, text, color, ts }
//
// Connectors are resilient: reconnect-with-backoff on socket drops, never throw out
// to the caller. Missing creds simply skip that source.

const WebSocket = require('ws');

// ---- Source label metadata (also used by the web UI) ----
const SOURCES = {
  twitch: { label: 'TWITCH', emoji: '🎮', color: '#9146FF' },
  x: { label: 'X', emoji: '𝕏', color: '#1D9BF0' },
  kick: { label: 'KICK', emoji: '⚡', color: '#53FC18' },
};

function csv(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function clean(text) {
  // strip newlines for single-line UIs
  return String(text == null ? '' : text).replace(/[\r\n]+/g, ' ').trim();
}

function randId(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// Exponential backoff helper with cap + jitter.
function backoffMs(attempt) {
  const base = Math.min(30000, 1000 * Math.pow(2, attempt));
  return base + Math.floor(Math.random() * 500);
}

// ============================================================
// TWITCH — anonymous IRC over WebSocket (no API key)
// ============================================================
function startTwitch(channels, emit, log) {
  if (!channels.length) return { stop() {} };
  let ws = null;
  let attempt = 0;
  let stopped = false;
  let reconnectTimer = null;

  function connect() {
    if (stopped) return;
    ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');

    ws.on('open', () => {
      attempt = 0;
      log('[twitch] connected, joining: ' + channels.join(', '));
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands\r\n');
      ws.send('NICK justinfan' + Math.floor(Math.random() * 1e6) + '\r\n');
      for (const ch of channels) {
        ws.send('JOIN #' + ch.toLowerCase() + '\r\n');
      }
    });

    ws.on('message', (raw) => {
      const data = raw.toString('utf8');
      // A frame may contain multiple IRC lines separated by \r\n
      for (const line of data.split('\r\n')) {
        if (!line) continue;
        if (line.startsWith('PING')) {
          try { ws.send('PONG :tmi.twitch.tv\r\n'); } catch (_) {}
          continue;
        }
        if (line.indexOf(' PRIVMSG ') === -1) continue;
        const msg = parseTwitchLine(line);
        if (msg) emit(msg);
      }
    });

    ws.on('close', () => { scheduleReconnect(); });
    ws.on('error', (e) => { log('[twitch] error: ' + (e && e.message)); try { ws.close(); } catch (_) {} });
  }

  function scheduleReconnect() {
    if (stopped) return;
    const wait = backoffMs(attempt++);
    log('[twitch] disconnected, reconnecting in ' + wait + 'ms');
    reconnectTimer = setTimeout(connect, wait);
  }

  connect();
  return {
    stop() {
      stopped = true;
      clearTimeout(reconnectTimer);
      try { ws && ws.close(); } catch (_) {}
    },
  };
}

function parseTwitchLine(line) {
  let tags = {};
  let rest = line;
  if (line[0] === '@') {
    const sp = line.indexOf(' ');
    const tagStr = line.slice(1, sp);
    rest = line.slice(sp + 1);
    for (const pair of tagStr.split(';')) {
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      tags[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
  // rest looks like: :alice!alice@alice.tmi.twitch.tv PRIVMSG #chan :hello world
  const pm = rest.indexOf(' PRIVMSG ');
  if (pm === -1) return null;
  const afterPm = rest.slice(pm + ' PRIVMSG '.length); // "#chan :hello world"
  const colon = afterPm.indexOf(' :');
  if (colon === -1) return null;
  const channel = afterPm.slice(0, colon).replace(/^#/, '');
  const text = afterPm.slice(colon + 2); // everything after the first " :" following PRIVMSG
  // author fallback: prefix nick before '!'
  let author = tags['display-name'];
  if (!author) {
    const bang = rest.indexOf('!');
    if (rest[0] === ':' && bang !== -1) author = rest.slice(1, bang);
  }
  return {
    id: tags['id'] || randId('tw_' + channel),
    source: 'twitch',
    channel,
    author: author || 'anon',
    text: clean(text),
    color: tags['color'] || '',
    ts: Date.now(),
  };
}

// ============================================================
// KICK — Pusher WebSocket (no API key)
// ============================================================
const KICK_WS =
  'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function resolveKickChatroom(slug) {
  const res = await fetch('https://kick.com/api/v2/channels/' + encodeURIComponent(slug), {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  if (!json || !json.chatroom || !json.chatroom.id) throw new Error('no chatroom id');
  return { id: json.chatroom.id, slug };
}

async function startKick(slugs, idOverrides, emit, log) {
  if (!slugs.length) return { stop() {} };

  // Build chatroomId -> slug map. Prefer explicit overrides aligned by index.
  const rooms = []; // { id, slug }
  for (let i = 0; i < slugs.length; i++) {
    const slug = slugs[i];
    if (idOverrides[i]) {
      rooms.push({ id: idOverrides[i], slug });
      continue;
    }
    try {
      const r = await resolveKickChatroom(slug);
      rooms.push(r);
      log('[kick] resolved ' + slug + ' -> chatroom ' + r.id);
    } catch (e) {
      log('[kick] could not resolve "' + slug + '" (' + (e && e.message) + '). ' +
        'Set KICK_CHATROOM_IDS to bypass Cloudflare.');
    }
  }
  if (!rooms.length) {
    log('[kick] no chatrooms resolved — kick disabled.');
    return { stop() {} };
  }

  let ws = null;
  let attempt = 0;
  let stopped = false;
  let reconnectTimer = null;

  function connect() {
    if (stopped) return;
    ws = new WebSocket(KICK_WS);

    ws.on('open', () => { attempt = 0; log('[kick] connected'); });

    ws.on('message', (raw) => {
      let frame;
      try { frame = JSON.parse(raw.toString('utf8')); } catch (_) { return; }
      if (frame.event === 'pusher:ping') {
        try { ws.send(JSON.stringify({ event: 'pusher:pong', data: {} })); } catch (_) {}
        return;
      }
      if (frame.event === 'pusher:connection_established') {
        for (const r of rooms) {
          ws.send(JSON.stringify({
            event: 'pusher:subscribe',
            data: { auth: '', channel: 'chatrooms.' + r.id + '.v2' },
          }));
        }
        log('[kick] subscribed to ' + rooms.length + ' chatroom(s)');
        return;
      }
      if (frame.event === 'App\\Events\\ChatMessage') {
        let payload;
        try { payload = JSON.parse(frame.data); } catch (_) { return; }
        // channel looks like "chatrooms.{id}.v2"
        const m = /chatrooms\.(\d+)\./.exec(frame.channel || '');
        const roomId = m ? m[1] : '';
        const room = rooms.find((r) => String(r.id) === roomId);
        const sender = payload.sender || {};
        emit({
          id: payload.id ? String(payload.id) : randId('kk'),
          source: 'kick',
          channel: room ? room.slug : (roomId || 'kick'),
          author: sender.username || 'anon',
          text: clean(payload.content),
          color: (sender.identity && sender.identity.color) || '',
          ts: Date.now(),
        });
      }
    });

    ws.on('close', () => { scheduleReconnect(); });
    ws.on('error', (e) => { log('[kick] error: ' + (e && e.message)); try { ws.close(); } catch (_) {} });
  }

  function scheduleReconnect() {
    if (stopped) return;
    const wait = backoffMs(attempt++);
    log('[kick] disconnected, reconnecting in ' + wait + 'ms');
    reconnectTimer = setTimeout(connect, wait);
  }

  connect();
  return {
    stop() {
      stopped = true;
      clearTimeout(reconnectTimer);
      try { ws && ws.close(); } catch (_) {}
    },
  };
}

// ============================================================
// X / TWITTER — API v2 recent search polling (bearer token)
// ============================================================
function startX(opts, emit, log) {
  const { token, mode, target } = opts;
  if (!token || !target) {
    if (token && !target) log('[x] X_BEARER_TOKEN set but X_TARGET missing — skipping X.');
    return { stop() {} };
  }
  let q;
  if (mode === 'replies') q = 'conversation_id:' + target;
  else if (mode === 'mentions') q = '@' + target + ' -is:retweet';
  else q = '#' + target + ' -is:retweet'; // hashtag (default)

  let sinceId = null;
  let stopped = false;
  let timer = null;
  let interval = 12000;

  async function poll() {
    if (stopped) return;
    try {
      const url =
        'https://api.twitter.com/2/tweets/search/recent?query=' +
        encodeURIComponent(q) +
        '&max_results=100&tweet.fields=created_at,author_id&expansions=author_id&user.fields=username' +
        (sinceId ? '&since_id=' + sinceId : '');
      const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
      if (res.status === 429) {
        interval = Math.min(120000, interval * 2);
        log('[x] 429 rate-limited, backing off to ' + interval + 'ms');
      } else if (!res.ok) {
        log('[x] HTTP ' + res.status);
      } else {
        interval = 12000;
        const json = await res.json();
        const users = {};
        if (json.includes && json.includes.users) {
          for (const u of json.includes.users) users[u.id] = u.username;
        }
        const tweets = (json.data || []).slice().reverse(); // newest-first -> chronological
        for (const t of tweets) {
          if (!sinceId || BigInt(t.id) > BigInt(sinceId)) sinceId = t.id;
          emit({
            id: t.id,
            source: 'x',
            channel: (mode === 'replies' ? 'conv:' : mode === 'mentions' ? '@' : '#') + target,
            author: users[t.author_id] || t.author_id || 'unknown',
            text: clean(t.text),
            color: '',
            ts: t.created_at ? Date.parse(t.created_at) : Date.now(),
          });
        }
      }
    } catch (e) {
      log('[x] poll error: ' + (e && e.message));
    } finally {
      if (!stopped) timer = setTimeout(poll, interval);
    }
  }

  log('[x] polling recent search: ' + q);
  poll();
  return {
    stop() { stopped = true; clearTimeout(timer); },
  };
}

// ============================================================
// DEMO MODE — synthetic merged feed, zero config
// ============================================================
const DEMO_AUTHORS = {
  twitch: ['cryptoCarl', 'degenDana', 'satoshiSam', 'pumpPriya'],
  x: ['ansem_fan', 'onchain_owl', 'blueChipBob', 'altSeasonAl'],
  kick: ['greenCandleGuy', 'wenLamboWendy', 'hodlHank', 'fomoFiona'],
};
const DEMO_TEXTS = [
  'gm, this dip is a gift 📈', 'ser is this financial advice?', 'longing here, tight stop',
  'liquidity grab incoming', 'ansem cooking again 🔥', 'rotate into majors imo',
  'that was a clean fakeout', 'who is still in the trade?', 'funding flipped negative 👀',
  'send it to the moon', 'paper hands ngmi', 'scaling in on this level',
];
const DEMO_COLORS = ['#FF4500', '#1E90FF', '#9ACD32', '#FF69B4', '#FFD700', '#00CED1'];

function startDemo(emit) {
  const sources = ['twitch', 'x', 'kick'];
  let i = 0;
  const timer = setInterval(() => {
    const source = sources[i % sources.length];
    i++;
    const authors = DEMO_AUTHORS[source];
    emit({
      id: randId('demo'),
      source,
      channel: source === 'x' ? '#ansem' : 'ansem',
      author: authors[Math.floor(Math.random() * authors.length)],
      text: DEMO_TEXTS[Math.floor(Math.random() * DEMO_TEXTS.length)],
      color: DEMO_COLORS[Math.floor(Math.random() * DEMO_COLORS.length)],
      ts: Date.now(),
    });
  }, 800);
  return { stop() { clearInterval(timer); } };
}

// ============================================================
// ORCHESTRATOR — read env, start everything, return stop()
// ============================================================
function startAll(env, emit, log) {
  log = log || (() => {});
  const twitchChannels = csv(env.TWITCH_CHANNELS);
  const kickSlugs = csv(env.KICK_CHANNELS);
  const kickIds = csv(env.KICK_CHATROOM_IDS);
  const xToken = env.X_BEARER_TOKEN;
  const xTarget = env.X_TARGET;
  const xMode = env.X_MODE || 'hashtag';

  const nothingConfigured =
    !twitchChannels.length && !kickSlugs.length && !(xToken && xTarget);
  const demo = env.DEMO === '1' || nothingConfigured;

  const stoppers = [];
  if (demo) {
    log('[demo] DEMO MODE active — injecting synthetic Twitch/X/Kick messages.');
    stoppers.push(startDemo(emit));
  } else {
    stoppers.push(startTwitch(twitchChannels, emit, log));
    // Kick resolves async; fire and forget, push stopper when ready.
    startKick(kickSlugs, kickIds, emit, log).then((s) => stoppers.push(s)).catch(() => {});
    stoppers.push(startX({ token: xToken, mode: xMode, target: xTarget }, emit, log));
  }

  return {
    demo,
    stop() { for (const s of stoppers) { try { s.stop(); } catch (_) {} } },
  };
}

module.exports = { startAll, SOURCES, csv, clean };
