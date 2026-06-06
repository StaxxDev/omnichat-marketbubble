// connectors.js — shared connector engine for OmniChat Desktop
// Runs in the Electron MAIN process (Node). Uses `ws` for WebSockets and global fetch (Node 18+).
//
// Public API:
//   const engine = new ChatEngine(config, onMessage, onStatus);
//   engine.start();  engine.stop();
//
// Every connector emits the UNIFIED MESSAGE SCHEMA:
//   { id, source, channel, author, text, color, ts }

'use strict';

const WebSocket = require('ws');

// ---- source metadata (labels live in the renderer too, this is the source of truth) ----
const SOURCE_META = {
  twitch: { label: 'TWITCH', emoji: '🎮', color: '#9146FF' },
  x:      { label: 'X',      emoji: '𝕏',  color: '#1D9BF0' },
  kick:   { label: 'KICK',   emoji: '⚡', color: '#53FC18' },
};

function clean(text) {
  return String(text == null ? '' : text).replace(/[\r\n]+/g, ' ').trim();
}

function rand(n) {
  return Math.floor(Math.random() * n);
}

function mkId(source, channel) {
  return `${source}:${channel}:${Date.now()}:${rand(1e9).toString(36)}`;
}

// ---------------------------------------------------------------------------
// ChatEngine — owns all three connectors + demo mode, and the reconnect logic.
// ---------------------------------------------------------------------------
class ChatEngine {
  /**
   * @param {object} config  { twitchChannels[], kickChannels[], kickChatroomIds[],
   *                            xBearer, xMode, xTarget, demo }
   * @param {(msg)=>void} onMessage  called with a unified message
   * @param {(status)=>void} onStatus  called with {source, channel, state, detail}
   */
  constructor(config, onMessage, onStatus) {
    this.cfg = config || {};
    this.onMessage = onMessage || (() => {});
    this.onStatus = onStatus || (() => {});
    this._sockets = [];
    this._timers = [];
    this._stopped = false;
  }

  emit(msg) {
    if (this._stopped) return;
    this.onMessage(msg);
  }

  status(source, channel, state, detail) {
    this.onStatus({ source, channel, state, detail: detail || '' });
  }

  start() {
    this._stopped = false;
    const cfg = this.cfg;

    const hasTwitch = (cfg.twitchChannels || []).length > 0;
    const hasKick = (cfg.kickChannels || []).length > 0;
    const hasX = !!cfg.xBearer && !!cfg.xTarget;
    const nothingConfigured = !hasTwitch && !hasKick && !hasX;

    if (cfg.demo || nothingConfigured) {
      this.status('demo', '*', 'open', 'Demo mode — synthetic feed');
      this._startDemo();
      return; // demo mode is self-contained
    }

    if (hasTwitch) this._startTwitch(cfg.twitchChannels);
    if (hasKick) this._startKick(cfg.kickChannels, cfg.kickChatroomIds || []);
    if (hasX) this._startX();
    if (!hasX && cfg.xTarget && !cfg.xBearer) {
      this.status('x', cfg.xTarget, 'error', 'No X_BEARER_TOKEN — X feed skipped');
    }
  }

  stop() {
    this._stopped = true;
    for (const s of this._sockets) {
      try { s._intentionalClose = true; s.close(); } catch (_) {}
    }
    for (const t of this._timers) clearTimeout(t), clearInterval(t);
    this._sockets = [];
    this._timers = [];
  }

  // ---- generic reconnect-with-backoff socket wrapper ----
  _connectWS(name, url, opts, handlers) {
    let attempt = 0;
    const self = this;

    const open = () => {
      if (self._stopped) return;
      let ws;
      try {
        ws = new WebSocket(url, opts);
      } catch (e) {
        scheduleReconnect();
        return;
      }
      self._sockets.push(ws);

      ws.on('open', () => {
        attempt = 0;
        handlers.onOpen && handlers.onOpen(ws);
      });
      ws.on('message', (data) => {
        handlers.onMessage && handlers.onMessage(ws, data.toString());
      });
      ws.on('error', (err) => {
        handlers.onError && handlers.onError(err);
      });
      ws.on('close', () => {
        // drop from list
        self._sockets = self._sockets.filter((s) => s !== ws);
        if (ws._intentionalClose || self._stopped) return;
        handlers.onClose && handlers.onClose();
        scheduleReconnect();
      });
    };

    const scheduleReconnect = () => {
      if (self._stopped) return;
      attempt += 1;
      // exponential backoff capped at 30s, with jitter
      const delay = Math.min(30000, 1000 * Math.pow(2, attempt - 1)) + rand(500);
      handlers.onReconnect && handlers.onReconnect(attempt, delay);
      const t = setTimeout(open, delay);
      self._timers.push(t);
    };

    open();
  }

  // =========================================================================
  // TWITCH — anonymous IRC over WebSocket (no API key)
  // =========================================================================
  _startTwitch(channels) {
    const url = 'wss://irc-ws.chat.twitch.tv:443';
    const nick = 'justinfan' + (10000 + rand(89999));

    this._connectWS('twitch', url, undefined, {
      onOpen: (ws) => {
        ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands\r\n');
        ws.send(`NICK ${nick}\r\n`);
        for (const ch of channels) {
          ws.send(`JOIN #${ch.toLowerCase()}\r\n`);
          this.status('twitch', ch, 'open', 'joined');
        }
      },
      onMessage: (ws, raw) => {
        // raw may contain multiple \r\n-separated lines
        for (const line of raw.split('\r\n')) {
          if (!line) continue;
          if (line.startsWith('PING')) {
            ws.send('PONG :tmi.twitch.tv\r\n');
            continue;
          }
          if (line.indexOf(' PRIVMSG ') === -1) continue;
          const parsed = this._parseTwitch(line);
          if (parsed) this.emit(parsed);
        }
      },
      onClose: () => this.status('twitch', '*', 'reconnecting', 'socket closed'),
      onReconnect: (a, d) => this.status('twitch', '*', 'reconnecting', `attempt ${a} in ${Math.round(d / 1000)}s`),
      onError: () => {},
    });
  }

  _parseTwitch(line) {
    let tags = {};
    let rest = line;
    if (line[0] === '@') {
      const sp = line.indexOf(' ');
      const tagStr = line.slice(1, sp);
      rest = line.slice(sp + 1);
      for (const kv of tagStr.split(';')) {
        const eq = kv.indexOf('=');
        if (eq === -1) continue;
        tags[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
    }
    // rest: :alice!alice@alice.tmi.twitch.tv PRIVMSG #chan :hello world
    const pm = rest.indexOf(' PRIVMSG ');
    if (pm === -1) return null;
    const afterPm = rest.slice(pm + ' PRIVMSG '.length); // "#chan :hello world"
    const colon = afterPm.indexOf(' :');
    if (colon === -1) return null;
    const channel = afterPm.slice(0, colon).replace(/^#/, '');
    const text = afterPm.slice(colon + 2); // everything after first " :"

    // author: prefer display-name tag, else prefix nick
    let author = tags['display-name'];
    if (!author) {
      const bang = rest.indexOf('!');
      if (rest[0] === ':' && bang > 0) author = rest.slice(1, bang);
    }
    author = author || 'unknown';

    return {
      id: tags['id'] || mkId('twitch', channel),
      source: 'twitch',
      channel,
      author,
      text: clean(text),
      color: tags['color'] || '',
      ts: Date.now(),
    };
  }

  // =========================================================================
  // KICK — Pusher WebSocket (no API key). Resolve chatroom id, then subscribe.
  // =========================================================================
  async _startKick(slugs, overrideIds) {
    const ids = [];
    for (let i = 0; i < slugs.length; i++) {
      const slug = slugs[i];
      let id = overrideIds[i];
      if (!id) {
        id = await this._resolveKickChatroom(slug);
      }
      if (id) {
        ids.push({ slug, id: String(id) });
        this.status('kick', slug, 'open', `chatroom ${id}`);
      } else {
        this.status('kick', slug, 'error', 'could not resolve chatroom id (set KICK_CHATROOM_IDS)');
      }
    }
    if (ids.length === 0) return;

    const url = 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false';
    // map chatroom id -> slug so messages can be labeled by channel
    const idToSlug = {};
    for (const { slug, id } of ids) idToSlug[id] = slug;

    this._connectWS('kick', url, undefined, {
      onMessage: (ws, raw) => {
        let frame;
        try { frame = JSON.parse(raw); } catch (_) { return; }

        if (frame.event === 'pusher:ping') {
          ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
          return;
        }
        if (frame.event === 'pusher:connection_established') {
          for (const { id } of ids) {
            ws.send(JSON.stringify({
              event: 'pusher:subscribe',
              data: { auth: '', channel: `chatrooms.${id}.v2` },
            }));
          }
          return;
        }
        if (frame.event === 'App\\Events\\ChatMessage') {
          let data;
          try { data = JSON.parse(frame.data); } catch (_) { return; }
          // channel field looks like "chatrooms.{id}.v2"
          let slug = '';
          const m = /chatrooms\.(\d+)\.v2/.exec(frame.channel || '');
          if (m) slug = idToSlug[m[1]] || '';
          const sender = data.sender || {};
          this.emit({
            id: data.id || mkId('kick', slug || 'kick'),
            source: 'kick',
            channel: slug || 'kick',
            author: sender.username || 'unknown',
            text: clean(data.content),
            color: (sender.identity && sender.identity.color) || '',
            ts: Date.now(),
          });
        }
      },
      onClose: () => this.status('kick', '*', 'reconnecting', 'socket closed'),
      onReconnect: (a, d) => this.status('kick', '*', 'reconnecting', `attempt ${a} in ${Math.round(d / 1000)}s`),
      onError: () => {},
    });
  }

  async _resolveKickChatroom(slug) {
    try {
      const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Accept': 'application/json',
        },
      });
      if (!res.ok) {
        this.status('kick', slug, 'error', `channel fetch ${res.status} (Cloudflare?) — use KICK_CHATROOM_IDS`);
        return null;
      }
      const json = await res.json();
      return json && json.chatroom && json.chatroom.id;
    } catch (e) {
      this.status('kick', slug, 'error', 'channel fetch failed — use KICK_CHATROOM_IDS');
      return null;
    }
  }

  // =========================================================================
  // X / TWITTER — API v2 recent-search POLLING (bearer token)
  // =========================================================================
  _startX() {
    const cfg = this.cfg;
    const target = cfg.xTarget;
    const mode = cfg.xMode || 'hashtag';
    let q;
    if (mode === 'replies') q = `conversation_id:${target}`;
    else if (mode === 'mentions') q = `@${target} -is:retweet`;
    else q = `#${target} -is:retweet`;

    this.status('x', target, 'open', `polling ${mode}: ${q}`);

    let sinceId = null;
    let backoff = 12000; // base poll interval
    const self = this;

    const poll = async () => {
      if (self._stopped) return;
      const params = new URLSearchParams({
        query: q,
        max_results: '100',
        'tweet.fields': 'created_at,author_id',
        expansions: 'author_id',
        'user.fields': 'username',
      });
      if (sinceId) params.set('since_id', sinceId);

      try {
        const res = await fetch(`https://api.twitter.com/2/tweets/search/recent?${params.toString()}`, {
          headers: { Authorization: `Bearer ${cfg.xBearer}` },
        });

        if (res.status === 429) {
          backoff = Math.min(120000, backoff * 2);
          self.status('x', target, 'reconnecting', `rate limited (429) — backing off ${Math.round(backoff / 1000)}s`);
          schedule(backoff);
          return;
        }
        if (!res.ok) {
          self.status('x', target, 'error', `search ${res.status}`);
          schedule(30000);
          return;
        }

        backoff = 12000; // reset on success
        const json = await res.json();
        const users = {};
        if (json.includes && json.includes.users) {
          for (const u of json.includes.users) users[u.id] = u.username;
        }
        const data = (json.data || []).slice().reverse(); // newest-first -> chronological
        for (const tw of data) {
          if (!sinceId || BigInt(tw.id) > BigInt(sinceId)) sinceId = tw.id;
          self.emit({
            id: tw.id,
            source: 'x',
            channel: target,
            author: users[tw.author_id] || tw.author_id || 'unknown',
            text: clean(tw.text),
            color: '',
            ts: tw.created_at ? Date.parse(tw.created_at) : Date.now(),
          });
        }
      } catch (e) {
        self.status('x', target, 'error', 'poll failed: ' + (e && e.message));
        schedule(30000);
        return;
      }
      schedule(backoff);
    };

    const schedule = (ms) => {
      if (self._stopped) return;
      const t = setTimeout(poll, ms);
      self._timers.push(t);
    };

    poll();
  }

  // =========================================================================
  // DEMO MODE — synthetic crypto-stream-flavored feed from all three sources
  // =========================================================================
  _startDemo() {
    const sources = ['twitch', 'x', 'kick'];
    const channels = {
      twitch: ['ansem', 'blknoiz06_clips'],
      x: ['blknoiz06'],
      kick: ['ansem', 'trenches'],
    };
    const authors = ['degenSol', 'liquidatedLarry', 'jpegWhale', 'cryptoKaren', 'apeOrDie',
      'gmGary', 'rektRandy', 'moonMolly', 'sniperSteve', 'paperHandsPete', 'fomoFelix', 'dcaDarius'];
    const colors = ['#FF4500', '#1E90FF', '#9146FF', '#53FC18', '#FFD700', '#FF69B4', '#00CED1', ''];
    const texts = [
      'ANSEM up only 🚀', 'who is buying this dip', 'send it to 100k',
      'liquidity looking thin ser', 'this candle is insane', 'wen lambo',
      'longed the bottom finally', 'shorts getting cooked', 'best trading show on the internet',
      'chart is bullish af', 'i am so underwater rn', 'GM legends',
      'that entry was clean', 'ngmi if you sold', 'bubble map says accumulate',
      'whale just woke up 🐳', 'funding flipped negative', 'this is financial advice (it is not)',
    ];

    const tick = () => {
      if (this._stopped) return;
      const source = sources[rand(sources.length)];
      const chList = channels[source];
      const channel = chList[rand(chList.length)];
      this.emit({
        id: mkId(source, channel),
        source,
        channel,
        author: authors[rand(authors.length)],
        text: texts[rand(texts.length)],
        color: colors[rand(colors.length)],
        ts: Date.now(),
      });
    };

    // burst a few immediately so the feed isn't empty on launch
    for (let i = 0; i < 5; i++) this._timers.push(setTimeout(tick, i * 150));
    const interval = setInterval(tick, 800);
    this._timers.push(interval);
  }
}

module.exports = { ChatEngine, SOURCE_META };
