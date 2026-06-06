// ---------------------------------------------------------------------------
// Shared connector implementations: Twitch (anon IRC), Kick (Pusher), X (poll).
// Each connector calls onMessage(unifiedMessage) and self-reconnects with backoff.
// Unified message schema:
//   { id, source, channel, author, text, color, ts }
// ---------------------------------------------------------------------------
const WebSocket = require("ws");

const SOURCE_META = {
  twitch: { label: "TWITCH", emoji: "\u{1F3AE}", color: "#9146FF" },
  x: { label: "X", emoji: "\u{1D54F}", color: "#1D9BF0" },
  kick: { label: "KICK", emoji: "⚡", color: "#53FC18" },
};

function uid() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function clean(text) {
  return String(text == null ? "" : text).replace(/[\r\n]+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Twitch — anonymous IRC over WebSocket. No API key.
// ---------------------------------------------------------------------------
function startTwitch(channels, onMessage, log) {
  const logins = channels.map((c) => c.trim().toLowerCase()).filter(Boolean);
  if (!logins.length) return () => {};
  let ws = null;
  let closed = false;
  let backoff = 1000;

  function connect() {
    if (closed) return;
    ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");

    ws.on("open", () => {
      backoff = 1000;
      log && log("twitch connected");
      ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands\r\n");
      ws.send("NICK justinfan" + Math.floor(Math.random() * 1e6) + "\r\n");
      for (const login of logins) ws.send("JOIN #" + login + "\r\n");
    });

    ws.on("message", (raw) => {
      const lines = raw.toString().split("\r\n");
      for (const line of lines) {
        if (!line) continue;
        if (line.startsWith("PING")) {
          ws.send("PONG :tmi.twitch.tv\r\n");
          continue;
        }
        if (line.indexOf(" PRIVMSG ") === -1) continue;
        parsePrivmsg(line, onMessage);
      }
    });

    ws.on("close", () => scheduleReconnect());
    ws.on("error", () => {
      try { ws.close(); } catch (e) {}
    });
  }

  function scheduleReconnect() {
    if (closed) return;
    log && log("twitch reconnect in " + backoff + "ms");
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
  }

  connect();
  return () => {
    closed = true;
    try { ws && ws.close(); } catch (e) {}
  };
}

function parsePrivmsg(line, onMessage) {
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
  // rest: :nick!nick@nick.tmi.twitch.tv PRIVMSG #chan :message
  const pm = rest.indexOf(" PRIVMSG ");
  if (pm === -1) return;
  const afterPm = rest.slice(pm + " PRIVMSG ".length); // "#chan :message"
  const firstColon = afterPm.indexOf(" :");
  if (firstColon === -1) return;
  const channelPart = afterPm.slice(0, firstColon).trim(); // "#chan"
  const text = afterPm.slice(firstColon + 2);
  const channel = channelPart.replace(/^#/, "");

  let author = tags["display-name"];
  if (!author) {
    const bang = rest.indexOf("!");
    author = bang > 1 ? rest.slice(1, bang) : channel;
  }

  onMessage({
    id: tags["id"] || channel + "-" + Date.now() + "-" + uid(),
    source: "twitch",
    channel,
    author: author || "anon",
    text: clean(text),
    color: tags["color"] || "",
    ts: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Kick — Pusher WebSocket. No API key. Resolve chatroom id via REST (Cloudflare).
// ---------------------------------------------------------------------------
const KICK_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function resolveKickChatroom(slug) {
  const res = await fetch("https://kick.com/api/v2/channels/" + slug, {
    headers: {
      "User-Agent": KICK_UA,
      Accept: "application/json",
    },
  });
  if (!res.ok) throw new Error("kick channel fetch " + res.status);
  const json = await res.json();
  if (!json || !json.chatroom || !json.chatroom.id)
    throw new Error("kick chatroom id missing");
  return String(json.chatroom.id);
}

function startKick(slugs, chatroomIdsCsv, onMessage, log) {
  const channels = slugs.map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!channels.length) return () => {};
  const overrides = (chatroomIdsCsv || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  let ws = null;
  let closed = false;
  let backoff = 1000;
  // map chatroomId -> slug, for labeling
  const idToSlug = {};

  async function resolveAll() {
    const ids = [];
    for (let i = 0; i < channels.length; i++) {
      let id = overrides[i];
      if (!id) {
        try {
          id = await resolveKickChatroom(channels[i]);
        } catch (e) {
          log && log("kick resolve failed for " + channels[i] + ": " + e.message);
          continue;
        }
      }
      idToSlug[id] = channels[i];
      ids.push(id);
    }
    return ids;
  }

  async function connect() {
    if (closed) return;
    const ids = await resolveAll();
    if (!ids.length) {
      log && log("kick: no chatroom ids resolved; retrying");
      return scheduleReconnect();
    }
    ws = new WebSocket(
      "wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false"
    );

    ws.on("open", () => {
      backoff = 1000;
      log && log("kick connected");
    });

    ws.on("message", (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch (e) {
        return;
      }
      if (frame.event === "pusher:connection_established") {
        for (const id of ids) {
          ws.send(
            JSON.stringify({
              event: "pusher:subscribe",
              data: { auth: "", channel: "chatrooms." + id + ".v2" },
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
        let data;
        try {
          data = JSON.parse(frame.data);
        } catch (e) {
          return;
        }
        // chatrooms.{id}.v2
        const chId = String(frame.channel || "").split(".")[1];
        const slug = idToSlug[chId] || chId || "kick";
        const sender = data.sender || {};
        onMessage({
          id: data.id || "kick-" + Date.now() + "-" + uid(),
          source: "kick",
          channel: slug,
          author: sender.username || "anon",
          text: clean(data.content),
          color: (sender.identity && sender.identity.color) || "",
          ts: Date.now(),
        });
      }
    });

    ws.on("close", () => scheduleReconnect());
    ws.on("error", () => {
      try { ws.close(); } catch (e) {}
    });
  }

  function scheduleReconnect() {
    if (closed) return;
    log && log("kick reconnect in " + backoff + "ms");
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30000);
  }

  connect();
  return () => {
    closed = true;
    try { ws && ws.close(); } catch (e) {}
  };
}

// ---------------------------------------------------------------------------
// X / Twitter — API v2 recent search polling. Bearer token. Skips if no token.
// ---------------------------------------------------------------------------
function buildXQuery(mode, target) {
  const t = String(target || "").trim();
  if (!t) return "";
  if (mode === "replies") return "conversation_id:" + t;
  if (mode === "mentions") return "@" + t.replace(/^@/, "") + " -is:retweet";
  // hashtag default
  return "#" + t.replace(/^#/, "") + " -is:retweet";
}

function startX(mode, target, bearer, onMessage, log) {
  const token = bearer || process.env.X_BEARER_TOKEN || "";
  const query = buildXQuery(mode, target);
  if (!token || !query) {
    log && log("x: skipped (no token or target)");
    return () => {};
  }
  let closed = false;
  let sinceId = null;
  let timer = null;
  let delay = 12000;

  async function poll() {
    if (closed) return;
    try {
      const params = new URLSearchParams({
        query,
        max_results: "100",
        "tweet.fields": "created_at,author_id",
        expansions: "author_id",
        "user.fields": "username",
      });
      if (sinceId) params.set("since_id", sinceId);
      const res = await fetch(
        "https://api.twitter.com/2/tweets/search/recent?" + params.toString(),
        { headers: { Authorization: "Bearer " + token } }
      );
      if (res.status === 429) {
        log && log("x: 429 rate-limited, backing off");
        delay = Math.min(delay * 2, 120000);
        return schedule();
      }
      delay = 12000;
      if (!res.ok) {
        log && log("x: http " + res.status);
        return schedule();
      }
      const json = await res.json();
      const users = {};
      if (json.includes && json.includes.users) {
        for (const u of json.includes.users) users[u.id] = u.username;
      }
      const data = (json.data || []).slice().reverse(); // chronological
      for (const tw of data) {
        if (!sinceId || BigInt(tw.id) > BigInt(sinceId)) sinceId = tw.id;
        onMessage({
          id: tw.id,
          source: "x",
          channel: (mode || "hashtag") + ":" + target,
          author: users[tw.author_id] || "user",
          text: clean(tw.text),
          color: "",
          ts: tw.created_at ? Date.parse(tw.created_at) : Date.now(),
        });
      }
    } catch (e) {
      log && log("x: poll error " + e.message);
    }
    schedule();
  }

  function schedule() {
    if (closed) return;
    timer = setTimeout(poll, delay);
  }

  poll();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
  };
}

// ---------------------------------------------------------------------------
// Demo — synthetic crypto-stream-flavored messages from all three sources.
// ---------------------------------------------------------------------------
const DEMO_AUTHORS = {
  twitch: ["degenmike", "chartwizard", " serpentftw".trim(), "liqd_again", "gm_gn"],
  kick: ["kickwhale", "greencandle", "apebrain", "wenmoon", "based_dev"],
  x: ["ansemtrades", "cryptokyle", "0xframe", "satoshigirl", "blknoiz_fan"],
};
const DEMO_TEXTS = [
  "Ansem just called the top again 😂",
  "longing here, stop under the wick",
  "this candle is printing, lfg",
  "who's still holding from $0.02?",
  "funding flipped negative, squeeze incoming",
  "gm degens, what are we trading today",
  "that liq cluster at 64k is magnetic",
  "x feed vs twitch chat is night and day",
  "kick chat going crazy rn ⚡",
  "size up or stay poor 🫡",
  "ngmi if you sold there",
  "RSI cooked, scalp it",
];

function startDemo(onMessage) {
  let closed = false;
  const sources = ["twitch", "x", "kick"];
  let i = 0;
  const timer = setInterval(() => {
    if (closed) return;
    const source = sources[i % sources.length];
    i++;
    const authors = DEMO_AUTHORS[source];
    const author = authors[Math.floor(Math.random() * authors.length)];
    const text = DEMO_TEXTS[Math.floor(Math.random() * DEMO_TEXTS.length)];
    const channel =
      source === "twitch" ? "ansem" : source === "kick" ? "ansem" : "hashtag:ansem";
    onMessage({
      id: "demo-" + uid(),
      source,
      channel,
      author,
      text,
      color:
        source === "twitch" ? "#9146FF" : source === "kick" ? "#53FC18" : "#1D9BF0",
      ts: Date.now(),
    });
  }, 800);
  return () => {
    closed = true;
    clearInterval(timer);
  };
}

module.exports = {
  SOURCE_META,
  startTwitch,
  startKick,
  startX,
  startDemo,
  buildXQuery,
  resolveKickChatroom,
};
