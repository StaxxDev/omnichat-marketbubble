// OmniChat Lite — Unified chat aggregator (Twitch + X + Kick) in one real-time feed.
// Ultra-light stack: Bun + Hono. A single process serves the UI, runs the three
// connectors, and fans messages out to browsers over Bun's native WebSocket server.
//
// Run:  bun run server.ts   (or: bun run dev)
// Open: http://localhost:8787
//
// Zero-config: with no channels set it boots in DEMO MODE.

import { Hono } from "hono";

// ---------------------------------------------------------------------------
// Unified message schema (every connector emits exactly this shape)
// ---------------------------------------------------------------------------
type Source = "twitch" | "x" | "kick";
interface Msg {
  id: string;
  source: Source;
  channel: string;
  author: string;
  text: string;
  color: string;
  ts: number;
}

// ---------------------------------------------------------------------------
// Config (env / .env). Bun auto-loads .env in the cwd.
// ---------------------------------------------------------------------------
const env = process.env;
const PORT = Number(env.PORT || 8787);

const csv = (s?: string): string[] =>
  (s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const TWITCH_CHANNELS = csv(env.TWITCH_CHANNELS);
const KICK_CHANNELS = csv(env.KICK_CHANNELS);
const KICK_CHATROOM_IDS = csv(env.KICK_CHATROOM_IDS);
const X_BEARER_TOKEN = (env.X_BEARER_TOKEN || "").trim();
const X_MODE = (env.X_MODE || "hashtag").trim() as "replies" | "mentions" | "hashtag";
const X_TARGET = (env.X_TARGET || "").trim();

// Demo mode when nothing is configured, or when DEMO=1 is forced.
const ANY_CONFIG =
  TWITCH_CHANNELS.length > 0 ||
  KICK_CHANNELS.length > 0 ||
  (X_BEARER_TOKEN.length > 0 && X_TARGET.length > 0);
const DEMO = env.DEMO === "1" || !ANY_CONFIG;

const SOURCE_META: Record<Source, { label: string; emoji: string; color: string }> = {
  twitch: { label: "TWITCH", emoji: "🎮", color: "#9146FF" },
  x: { label: "X", emoji: "𝕏", color: "#1D9BF0" },
  kick: { label: "KICK", emoji: "⚡", color: "#53FC18" },
};

const log = (...a: unknown[]) => console.log("[omnichat]", ...a);

// ---------------------------------------------------------------------------
// Fan-out: keep a ring buffer of recent messages, broadcast to all browsers.
// ---------------------------------------------------------------------------
const MAX_RETAINED = 500;
const history: Msg[] = [];
const clients = new Set<any>(); // Bun ServerWebSocket set

function emit(m: Msg) {
  history.push(m);
  if (history.length > MAX_RETAINED) history.splice(0, history.length - MAX_RETAINED);
  const payload = JSON.stringify({ type: "msg", msg: m });
  for (const ws of clients) {
    try {
      ws.send(payload);
    } catch {
      /* client gone; will be cleaned up on close */
    }
  }
}

let seq = 0;
const uid = () => `${Date.now().toString(36)}-${(seq++).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

// ---------------------------------------------------------------------------
// Reconnect-with-backoff helper. Wraps a "start one connection" function that
// resolves/rejects when the connection ends, and retries with capped backoff.
// ---------------------------------------------------------------------------
function withBackoff(name: string, connectOnce: () => Promise<void>) {
  let attempt = 0;
  const run = async () => {
    while (true) {
      try {
        await connectOnce();
        attempt = 0; // clean exit resets backoff
      } catch (e) {
        log(`${name} error:`, (e as Error)?.message || e);
      }
      attempt++;
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)) + Math.random() * 500;
      log(`${name} reconnecting in ${Math.round(delay)}ms (attempt ${attempt})`);
      await new Promise((r) => setTimeout(r, delay));
    }
  };
  run();
}

// ---------------------------------------------------------------------------
// TWITCH connector — anonymous IRC over WebSocket (no API key).
// ---------------------------------------------------------------------------
function startTwitch(channels: string[]) {
  if (channels.length === 0) return;
  withBackoff("twitch", () => {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      ws.addEventListener("open", () => {
        ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands\r\n");
        ws.send(`NICK justinfan${Math.floor(Math.random() * 1e6)}\r\n`);
        for (const ch of channels) ws.send(`JOIN #${ch.toLowerCase()}\r\n`);
        log("twitch connected, joined:", channels.join(", "));
      });

      ws.addEventListener("message", (ev: MessageEvent) => {
        const raw = String(ev.data);
        for (const line of raw.split("\r\n")) {
          if (!line) continue;
          if (line.startsWith("PING")) {
            ws.send("PONG :tmi.twitch.tv\r\n");
            continue;
          }
          if (!line.includes(" PRIVMSG ")) continue;

          // Parse tags (leading @...) if present.
          const tags: Record<string, string> = {};
          let rest = line;
          if (line.startsWith("@")) {
            const sp = line.indexOf(" ");
            const tagStr = line.slice(1, sp);
            rest = line.slice(sp + 1);
            for (const kv of tagStr.split(";")) {
              const i = kv.indexOf("=");
              if (i > 0) tags[kv.slice(0, i)] = kv.slice(i + 1);
            }
          }

          // channel = between "PRIVMSG #" and " :"
          const pm = rest.indexOf("PRIVMSG #");
          if (pm < 0) continue;
          const afterChan = rest.slice(pm + "PRIVMSG #".length);
          const colon = afterChan.indexOf(" :");
          if (colon < 0) continue;
          const channel = afterChan.slice(0, colon).trim();
          const text = afterChan.slice(colon + 2).replace(/[\r\n]+/g, " ").trim();
          if (!text) continue;

          const author = tags["display-name"] || rest.slice(1, rest.indexOf("!")) || "anon";
          emit({
            id: tags["id"] || `tw-${channel}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            source: "twitch",
            channel,
            author,
            text,
            color: tags["color"] || "",
            ts: Date.now(),
          });
        }
      });

      ws.addEventListener("close", () => done(resolve));
      ws.addEventListener("error", (e) => done(() => reject(new Error("twitch ws error"))));
    });
  });
}

// ---------------------------------------------------------------------------
// KICK connector — Pusher WebSocket (no API key). Resolve chatroom ids, then
// subscribe to chatrooms.{id}.v2 and parse ChatMessage events.
// ---------------------------------------------------------------------------
const KICK_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function resolveKickChatrooms(slugs: string[]): Promise<{ slug: string; id: string }[]> {
  const out: { slug: string; id: string }[] = [];
  for (let i = 0; i < slugs.length; i++) {
    const slug = slugs[i];
    // Explicit override wins (Kick is behind Cloudflare and may 403).
    if (KICK_CHATROOM_IDS[i]) {
      out.push({ slug, id: KICK_CHATROOM_IDS[i] });
      continue;
    }
    try {
      const r = await fetch(`https://kick.com/api/v2/channels/${slug}`, {
        headers: { "User-Agent": KICK_UA, Accept: "application/json" },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j: any = await r.json();
      const id = j?.chatroom?.id;
      if (id) out.push({ slug, id: String(id) });
      else log(`kick: no chatroom id for ${slug}`);
    } catch (e) {
      log(`kick: failed to resolve ${slug} (${(e as Error).message}); set KICK_CHATROOM_IDS to override`);
    }
  }
  return out;
}

function startKick(slugs: string[]) {
  if (slugs.length === 0) return;
  withBackoff("kick", async () => {
    const rooms = await resolveKickChatrooms(slugs);
    if (rooms.length === 0) throw new Error("no kick chatrooms resolved");
    const slugById = new Map(rooms.map((r) => [r.id, r.slug]));

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(
        "wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false"
      );
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      ws.addEventListener("message", (ev: MessageEvent) => {
        let frame: any;
        try {
          frame = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (frame.event === "pusher:connection_established") {
          for (const r of rooms) {
            ws.send(
              JSON.stringify({
                event: "pusher:subscribe",
                data: { auth: "", channel: `chatrooms.${r.id}.v2` },
              })
            );
          }
          log("kick connected, subscribed:", rooms.map((r) => r.slug).join(", "));
          return;
        }
        if (frame.event === "pusher:ping") {
          ws.send(JSON.stringify({ event: "pusher:pong", data: {} }));
          return;
        }
        if (frame.event === "App\\Events\\ChatMessage") {
          let data: any;
          try {
            data = typeof frame.data === "string" ? JSON.parse(frame.data) : frame.data;
          } catch {
            return;
          }
          // channel name looks like "chatrooms.{id}.v2"
          const m = String(frame.channel || "").match(/chatrooms\.(\d+)\./);
          const channel = (m && slugById.get(m[1])) || slugById.get(String(data?.chatroom_id)) || "kick";
          const text = String(data?.content || "").replace(/[\r\n]+/g, " ").trim();
          if (!text) return;
          emit({
            id: data?.id ? `kick-${data.id}` : `kick-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            source: "kick",
            channel,
            author: data?.sender?.username || "anon",
            text,
            color: data?.sender?.identity?.color || "",
            ts: Date.now(),
          });
        }
      });

      ws.addEventListener("close", () => done(resolve));
      ws.addEventListener("error", () => done(() => reject(new Error("kick ws error"))));
    });
  });
}

// ---------------------------------------------------------------------------
// X / TWITTER connector — API v2 recent search polling (bearer token).
// No live chat exists, so poll recent tweets and stream new ones as the X feed.
// ---------------------------------------------------------------------------
function buildXQuery(mode: string, target: string): string {
  if (mode === "replies") return `conversation_id:${target}`;
  if (mode === "mentions") return `@${target} -is:retweet`;
  return `#${target.replace(/^#/, "")} -is:retweet`; // hashtag (default)
}

function startX() {
  if (!X_BEARER_TOKEN || !X_TARGET) {
    if (!DEMO) log("x: no X_BEARER_TOKEN/X_TARGET — skipping X connector");
    return;
  }
  const query = buildXQuery(X_MODE, X_TARGET);
  let sinceId: string | undefined;
  let stop = false;

  const poll = async () => {
    while (!stop) {
      let waitMs = 12_000;
      try {
        const u = new URL("https://api.twitter.com/2/tweets/search/recent");
        u.searchParams.set("query", query);
        u.searchParams.set("max_results", "100");
        u.searchParams.set("tweet.fields", "created_at,author_id");
        u.searchParams.set("expansions", "author_id");
        u.searchParams.set("user.fields", "username");
        if (sinceId) u.searchParams.set("since_id", sinceId);

        const r = await fetch(u.toString(), {
          headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` },
        });

        if (r.status === 429) {
          waitMs = 60_000; // rate limited — back off, keep running
          log("x: 429 rate limited, backing off 60s");
        } else if (!r.ok) {
          waitMs = 30_000;
          log("x: HTTP", r.status, await r.text().catch(() => ""));
        } else {
          const j: any = await r.json();
          const users = new Map<string, string>();
          for (const u2 of j?.includes?.users || []) users.set(u2.id, u2.username);
          const data: any[] = j?.data || [];
          // newest-first -> chronological
          for (const t of [...data].reverse()) {
            if (!sinceId || BigInt(t.id) > BigInt(sinceId)) sinceId = t.id;
            const username = users.get(t.author_id) || t.author_id || "user";
            emit({
              id: `x-${t.id}`,
              source: "x",
              channel: X_TARGET,
              author: username,
              text: String(t.text || "").replace(/[\r\n]+/g, " ").trim(),
              color: "",
              ts: t.created_at ? Date.parse(t.created_at) : Date.now(),
            });
          }
        }
      } catch (e) {
        waitMs = 30_000;
        log("x: poll error", (e as Error).message);
      }
      await new Promise((res) => setTimeout(res, waitMs));
    }
  };
  log(`x connected, polling: ${X_MODE} "${X_TARGET}"`);
  poll();
}

// ---------------------------------------------------------------------------
// DEMO MODE — synthetic messages from all three sources every ~800ms.
// ---------------------------------------------------------------------------
function startDemo() {
  const demo: Record<Source, { channels: string[]; authors: { name: string; color: string }[] }> = {
    twitch: {
      channels: ["ansem", "blknoiz06"],
      authors: [
        { name: "degenmax", color: "#FF4500" },
        { name: "chartwizard", color: "#1E90FF" },
        { name: "liquidated_lou", color: "#FF69B4" },
      ],
    },
    kick: {
      channels: ["trainwreckstv", "adin"],
      authors: [
        { name: "greenCandleGod", color: "#53FC18" },
        { name: "apeStrong", color: "#FFD700" },
        { name: "rugpullrandy", color: "#FF6347" },
      ],
    },
    x: {
      channels: ["$SOL", "#crypto"],
      authors: [
        { name: "onchain_alpha", color: "" },
        { name: "moonboy42", color: "" },
        { name: "vc_vibes", color: "" },
      ],
    },
  };
  const texts = [
    "SOL breaking out again 🚀",
    "who's buying this dip",
    "Ansem called it first ngl",
    "liquidity looking thin here",
    "new ATH incoming??",
    "ser this is a casino",
    "long entry filled, lfg",
    "shorts about to get cooked",
    "wen lambo fr fr",
    "this candle is illegal",
    "bridged my bags over, all in",
    "funding flipped negative, bullish",
    "chat is this the bottom",
    "GM degens ☕",
    "paper hands ngmi",
  ];
  const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
  const sources: Source[] = ["twitch", "kick", "x"];

  log("DEMO MODE active — emitting synthetic messages every ~800ms");
  setInterval(() => {
    const source = pick(sources);
    const d = demo[source];
    const author = pick(d.authors);
    emit({
      id: uid(),
      source,
      channel: pick(d.channels),
      author: author.name,
      text: pick(texts),
      color: author.color,
      ts: Date.now(),
    });
  }, 800);
}

// ---------------------------------------------------------------------------
// HTTP app (Hono) — serves UI + config; WS upgrade handled by Bun.serve.
// ---------------------------------------------------------------------------
const indexHtml = await Bun.file(new URL("./public/index.html", import.meta.url)).text();

const app = new Hono();
app.get("/", (c) => c.html(indexHtml));
app.get("/api/config", (c) =>
  c.json({
    demo: DEMO,
    sources: SOURCE_META,
    channels: {
      twitch: TWITCH_CHANNELS,
      kick: KICK_CHANNELS,
      x: X_BEARER_TOKEN && X_TARGET ? [X_TARGET] : [],
    },
    max: MAX_RETAINED,
  })
);

// ---------------------------------------------------------------------------
// Bun.serve — native WebSocket fan-out + Hono fetch handler.
// ---------------------------------------------------------------------------
const server = Bun.serve({
  port: PORT,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (srv.upgrade(req)) return; // upgraded to WebSocket
      return new Response("expected websocket", { status: 426 });
    }
    return app.fetch(req);
  },
  websocket: {
    open(ws) {
      clients.add(ws);
      // Send config + recent history so a fresh tab isn't blank.
      ws.send(JSON.stringify({ type: "hello", demo: DEMO, sources: SOURCE_META, history: history.slice(-100) }));
    },
    close(ws) {
      clients.delete(ws);
    },
    message() {
      /* browser is read-only */
    },
  },
});

log(`listening on http://localhost:${server.port}`);
log(
  `config -> twitch:[${TWITCH_CHANNELS.join(",")}] kick:[${KICK_CHANNELS.join(",")}] x:${
    X_BEARER_TOKEN && X_TARGET ? `${X_MODE}:${X_TARGET}` : "off"
  } demo:${DEMO}`
);

// ---------------------------------------------------------------------------
// Boot connectors.
// ---------------------------------------------------------------------------
if (DEMO) {
  startDemo();
} else {
  startTwitch(TWITCH_CHANNELS);
  startKick(KICK_CHANNELS);
  startX();
}
