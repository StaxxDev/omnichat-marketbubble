// OmniChat Edge — the Hub Durable Object.
//
// One instance is the fan-in hub. It:
//   * accepts browser WebSocket connections on /ws and fans messages out to them
//   * opens & maintains the upstream Twitch IRC WebSocket (anonymous, no key)
//   * opens & maintains the upstream Kick Pusher WebSocket (public key, no key)
//   * polls the X / Twitter v2 recent-search API on an alarm (~12s)
//   * falls back to DEMO MODE when nothing is configured (or DEMO=1)
//
// Every emitted message follows the unified schema:
//   { id, source, channel, author, text, color, ts }

const MAX_RETAINED = 500; // bound memory: keep at most this many recent messages
const X_POLL_MS = 12_000; // X polling cadence
const DEMO_TICK_MS = 800; // demo message cadence

// ---- upstream constants (from the shared connector spec) -------------------
const TWITCH_WS = "wss://irc-ws.chat.twitch.tv:443";
const KICK_WS =
  "wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false";
const KICK_API = (slug) => `https://kick.com/api/v2/channels/${slug}`;
const X_SEARCH = "https://api.twitter.com/2/tweets/search/recent";

// Source label metadata mirrored on the client for badges.
const SOURCE_META = {
  twitch: { label: "TWITCH", emoji: "🎮", color: "#9146FF" },
  x: { label: "X", emoji: "𝕏", color: "#1D9BF0" },
  kick: { label: "KICK", emoji: "⚡", color: "#53FC18" },
};

function uid() {
  return (
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  );
}

function csv(v) {
  return String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export class Hub {
  constructor(state, env) {
    this.state = state;
    this.env = env;

    /** @type {Set<WebSocket>} browser clients */
    this.clients = new Set();
    /** @type {Array} ring buffer of recent unified messages */
    this.buffer = [];

    // upstream sockets
    this.twitch = null;
    this.kick = null;

    // backoff bookkeeping per upstream
    this.backoff = { twitch: 1000, kick: 1000 };

    // X polling state
    this.xSinceId = null;
    this.xUserCache = new Map();

    // demo timer handle
    this.demoTimer = null;

    // config derived from env
    this.cfg = this.readConfig(env);

    // started flag so we only boot upstreams once per DO lifetime
    this.booted = false;
  }

  readConfig(env) {
    const twitch = csv(env.TWITCH_CHANNELS).map((c) => c.toLowerCase());
    const kick = csv(env.KICK_CHANNELS).map((c) => c.toLowerCase());
    const kickIds = csv(env.KICK_CHATROOM_IDS);
    const xToken = env.X_BEARER_TOKEN || "";
    const xMode = (env.X_MODE || "hashtag").toLowerCase();
    const xTarget = (env.X_TARGET || "").trim();
    const forceDemo = String(env.DEMO || "") === "1";

    const hasReal =
      twitch.length > 0 ||
      kick.length > 0 ||
      (xToken && xTarget);

    return {
      twitch,
      kick,
      kickIds,
      xToken,
      xMode,
      xTarget,
      demo: forceDemo || !hasReal,
    };
  }

  // --------------------------------------------------------------------------
  // HTTP / WebSocket entry
  // --------------------------------------------------------------------------
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/ws") {
      return new Response("hub: not found", { status: 404 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.addClient(server);

    // Boot upstreams lazily on first connection so the DO stays cheap.
    await this.boot();

    return new Response(null, { status: 101, webSocket: client });
  }

  addClient(ws) {
    this.clients.add(ws);

    // Send a hello with config + label metadata + the recent backlog so a
    // freshly-joined browser sees immediate history.
    this.sendTo(ws, {
      type: "hello",
      meta: SOURCE_META,
      demo: this.cfg.demo,
      channels: {
        twitch: this.cfg.twitch,
        kick: this.cfg.kick,
        x: this.cfg.xTarget ? [this.cfg.xTarget] : [],
      },
      backlog: this.buffer,
    });

    ws.addEventListener("close", () => this.clients.delete(ws));
    ws.addEventListener("error", () => this.clients.delete(ws));
    ws.addEventListener("message", (evt) => {
      // The UI is read-only; we accept a ping for liveness only.
      try {
        const m = JSON.parse(evt.data);
        if (m && m.type === "ping") this.sendTo(ws, { type: "pong" });
      } catch (_) {}
    });
  }

  sendTo(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (_) {}
  }

  // Fan a unified message out to every browser + retain in the ring buffer.
  emit(msg) {
    if (!msg.id) msg.id = uid();
    if (!msg.ts) msg.ts = Date.now();
    this.buffer.push(msg);
    if (this.buffer.length > MAX_RETAINED) {
      this.buffer.splice(0, this.buffer.length - MAX_RETAINED);
    }
    const frame = JSON.stringify({ type: "msg", msg });
    for (const ws of this.clients) {
      try {
        ws.send(frame);
      } catch (_) {
        this.clients.delete(ws);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Boot upstreams once
  // --------------------------------------------------------------------------
  async boot() {
    if (this.booted) return;
    this.booted = true;

    if (this.cfg.demo) {
      this.startDemo();
      return;
    }

    if (this.cfg.twitch.length) this.connectTwitch();
    if (this.cfg.kick.length) this.connectKick();
    if (this.cfg.xToken && this.cfg.xTarget) {
      // Kick off the X poll loop via the DO alarm.
      await this.state.storage.setAlarm(Date.now() + 500);
    }
  }

  // --------------------------------------------------------------------------
  // DEMO MODE — synthetic messages from all three sources every ~800ms
  // --------------------------------------------------------------------------
  startDemo() {
    const authors = {
      twitch: ["xqcL", "moonboy42", "degenDan", "chartWizard", "pumpItPaul"],
      kick: ["kickKing", "greenCandle", "apeMode", "liquidatedLuke", "wenLambo"],
      x: ["@blknoiz06", "@cobie", "@hsaka", "@gainzy", "@inversebrah"],
    };
    const lines = [
      "ANSEM CALLED THE TOP AGAIN ABSOLUTE LEGEND",
      "up only from here ser",
      "who's buying this dip with me",
      "liquidity looking thin, careful",
      "this candle is sending me to valhalla",
      "100x or homeless, no in between",
      "RSI says oversold, sending it",
      "gm to everyone except the shorts",
      "my portfolio is a comedy show today",
      "wen airdrop fren",
      "chart pattern = bull flag, trust",
      "got rugged but i respect the hustle",
      "diamond hands activated",
      "this is financial advice (it is not)",
    ];
    const colors = ["#FF4500", "#1E90FF", "#9ACD32", "#FF69B4", "#FFD700", ""];
    const channels = {
      twitch: ["ansem", "xqc"],
      kick: ["trainwreckstv", "xqc"],
      x: ["#crypto"],
    };
    const sources = ["twitch", "x", "kick"];

    const pick = (a) => a[Math.floor(Math.random() * a.length)];

    this.demoTimer = setInterval(() => {
      const source = pick(sources);
      this.emit({
        id: uid(),
        source,
        channel: pick(channels[source]),
        author: pick(authors[source]),
        text: pick(lines),
        color: pick(colors),
        ts: Date.now(),
      });
    }, DEMO_TICK_MS);
  }

  // --------------------------------------------------------------------------
  // TWITCH — anonymous IRC over WebSocket (no API key)
  // --------------------------------------------------------------------------
  connectTwitch() {
    let ws;
    try {
      ws = new WebSocket(TWITCH_WS);
    } catch (e) {
      return this.scheduleReconnect("twitch", () => this.connectTwitch());
    }
    this.twitch = ws;

    ws.addEventListener("open", () => {
      this.backoff.twitch = 1000; // reset backoff on success
      const nick = "justinfan" + Math.floor(Math.random() * 1_000_000);
      ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands\r\n");
      ws.send("NICK " + nick + "\r\n");
      for (const ch of this.cfg.twitch) {
        ws.send("JOIN #" + ch + "\r\n");
      }
    });

    ws.addEventListener("message", (evt) => {
      const raw = typeof evt.data === "string" ? evt.data : "";
      // A frame may contain multiple IRC lines.
      for (const line of raw.split("\r\n")) {
        if (!line) continue;
        if (line.startsWith("PING")) {
          ws.send("PONG :tmi.twitch.tv\r\n");
          continue;
        }
        if (line.indexOf(" PRIVMSG ") === -1) continue;
        const msg = this.parseTwitch(line);
        if (msg) this.emit(msg);
      }
    });

    const reconnect = () =>
      this.scheduleReconnect("twitch", () => this.connectTwitch());
    ws.addEventListener("close", reconnect);
    ws.addEventListener("error", reconnect);
  }

  parseTwitch(line) {
    try {
      let tags = {};
      let rest = line;
      if (line[0] === "@") {
        const sp = line.indexOf(" ");
        const tagStr = line.slice(1, sp);
        rest = line.slice(sp + 1);
        for (const kv of tagStr.split(";")) {
          const eq = kv.indexOf("=");
          if (eq === -1) continue;
          tags[kv.slice(0, eq)] = kv.slice(eq + 1);
        }
      }
      // rest: :alice!alice@alice.tmi.twitch.tv PRIVMSG #chan :hello world
      const pi = rest.indexOf(" PRIVMSG #");
      if (pi === -1) return null;
      const afterChan = rest.slice(pi + " PRIVMSG #".length);
      const colon = afterChan.indexOf(" :");
      if (colon === -1) return null;
      const channel = afterChan.slice(0, colon);
      const text = afterChan.slice(colon + 2).replace(/[\r\n]+/g, " ").trim();

      // author from display-name tag, else from the nick prefix.
      let author = tags["display-name"];
      if (!author) {
        const bang = rest.indexOf("!");
        if (rest[0] === ":" && bang > 1) author = rest.slice(1, bang);
      }
      return {
        id: tags["id"] || channel + "-" + Date.now() + "-" + uid(),
        source: "twitch",
        channel,
        author: author || "anon",
        text,
        color: tags["color"] || "",
        ts: Date.now(),
      };
    } catch (_) {
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // KICK — Pusher WebSocket (public app key, no API key)
  // --------------------------------------------------------------------------
  async connectKick() {
    // Resolve chatroom ids first (slug -> chatroom.id), with env override.
    const ids = [];
    for (let i = 0; i < this.cfg.kick.length; i++) {
      const slug = this.cfg.kick[i];
      let id = this.cfg.kickIds[i] || null;
      if (!id) {
        id = await this.resolveKickChatroom(slug);
      }
      if (id) ids.push({ slug, id: String(id) });
    }
    if (!ids.length) {
      // Nothing resolvable; retry later with backoff.
      return this.scheduleReconnect("kick", () => this.connectKick());
    }
    this.kickRooms = ids; // {slug,id}[]

    let ws;
    try {
      ws = new WebSocket(KICK_WS);
    } catch (e) {
      return this.scheduleReconnect("kick", () => this.connectKick());
    }
    this.kick = ws;

    ws.addEventListener("open", () => {
      this.backoff.kick = 1000;
    });

    ws.addEventListener("message", (evt) => {
      const raw = typeof evt.data === "string" ? evt.data : "";
      let frame;
      try {
        frame = JSON.parse(raw);
      } catch (_) {
        return;
      }
      if (frame.event === "pusher:connection_established") {
        for (const r of this.kickRooms) {
          ws.send(
            JSON.stringify({
              event: "pusher:subscribe",
              data: { auth: "", channel: "chatrooms." + r.id + ".v2" },
            })
          );
        }
        return;
      }
      if (frame.event === "pusher:ping") {
        ws.send(JSON.stringify({ event: "pusher:pong", data: {} }));
        return;
      }
      if (frame.event === "App\\Events\\ChatMessage") {
        const msg = this.parseKick(frame);
        if (msg) this.emit(msg);
      }
    });

    const reconnect = () =>
      this.scheduleReconnect("kick", () => this.connectKick());
    ws.addEventListener("close", reconnect);
    ws.addEventListener("error", reconnect);
  }

  async resolveKickChatroom(slug) {
    try {
      const res = await fetch(KICK_API(slug), {
        headers: {
          // Kick sits behind Cloudflare — send a browser-like UA.
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          Accept: "application/json",
        },
      });
      if (!res.ok) return null;
      const json = await res.json();
      return json && json.chatroom && json.chatroom.id
        ? json.chatroom.id
        : null;
    } catch (_) {
      return null;
    }
  }

  parseKick(frame) {
    try {
      const data =
        typeof frame.data === "string" ? JSON.parse(frame.data) : frame.data;
      const sender = data.sender || {};
      // map the pusher channel "chatrooms.{id}.v2" back to a slug
      let channel = "kick";
      if (frame.channel && this.kickRooms) {
        const m = frame.channel.match(/chatrooms\.(\d+)\.v2/);
        if (m) {
          const found = this.kickRooms.find((r) => r.id === m[1]);
          if (found) channel = found.slug;
        }
      }
      return {
        id: data.id ? "kick-" + data.id : uid(),
        source: "kick",
        channel,
        author: sender.username || "anon",
        text: String(data.content || "").replace(/[\r\n]+/g, " ").trim(),
        color: (sender.identity && sender.identity.color) || "",
        ts: Date.now(),
      };
    } catch (_) {
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // X / TWITTER — recent-search polling driven by the DO alarm
  // --------------------------------------------------------------------------
  async alarm() {
    // Defensive: only poll if configured.
    if (!this.cfg.xToken || !this.cfg.xTarget) return;
    let nextDelay = X_POLL_MS;
    try {
      await this.pollX();
    } catch (e) {
      // On failure (incl. 429) back off but keep the loop alive.
      nextDelay = X_POLL_MS * 2;
    }
    await this.state.storage.setAlarm(Date.now() + nextDelay);
  }

  buildXQuery() {
    const t = this.cfg.xTarget;
    switch (this.cfg.xMode) {
      case "replies":
        return "conversation_id:" + t;
      case "mentions":
        return "@" + t + " -is:retweet";
      case "hashtag":
      default:
        return "#" + t + " -is:retweet";
    }
  }

  async pollX() {
    const params = new URLSearchParams({
      query: this.buildXQuery(),
      max_results: "100",
      "tweet.fields": "created_at,author_id",
      expansions: "author_id",
      "user.fields": "username",
    });
    if (this.xSinceId) params.set("since_id", this.xSinceId);

    const res = await fetch(X_SEARCH + "?" + params.toString(), {
      headers: { Authorization: "Bearer " + this.cfg.xToken },
    });
    if (res.status === 429) {
      throw new Error("rate-limited"); // alarm() backs off
    }
    if (!res.ok) return;
    const json = await res.json();
    const data = json.data || [];
    if (!data.length) return;

    // Map author_id -> username from includes.
    const users = (json.includes && json.includes.users) || [];
    for (const u of users) this.xUserCache.set(u.id, u.username);

    // newest-first -> chronological
    const chrono = data.slice().reverse();
    let maxId = this.xSinceId;
    for (const tw of chrono) {
      if (!maxId || BigInt(tw.id) > BigInt(maxId)) maxId = tw.id;
      const username = this.xUserCache.get(tw.author_id) || "user";
      this.emit({
        id: "x-" + tw.id,
        source: "x",
        channel: this.cfg.xTarget,
        author: "@" + username,
        text: String(tw.text || "").replace(/[\r\n]+/g, " ").trim(),
        color: "",
        ts: tw.created_at ? Date.parse(tw.created_at) : Date.now(),
      });
    }
    this.xSinceId = maxId;
  }

  // --------------------------------------------------------------------------
  // Reconnect with exponential backoff (capped at 30s)
  // --------------------------------------------------------------------------
  scheduleReconnect(which, fn) {
    if (which === "twitch") this.twitch = null;
    if (which === "kick") this.kick = null;
    const delay = this.backoff[which] || 1000;
    this.backoff[which] = Math.min(delay * 2, 30_000);
    setTimeout(() => {
      try {
        fn();
      } catch (_) {}
    }, delay);
  }
}
