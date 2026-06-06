// OmniChat — MV3 background service worker.
// Runs all three connectors (Twitch IRC WS, Kick Pusher WS, X polling) and
// broadcasts a unified message schema to any open side panels via chrome.runtime messaging.
//
// Unified schema:
//   { id, source: "twitch"|"x"|"kick", channel, author, text, color, ts }

const MAX_RETAINED = 500;

// ---------------------------------------------------------------------------
// State (note: MV3 workers can be killed; we re-hydrate config from storage and
// keep a short ring buffer so a freshly-opened panel can request a backfill).
// ---------------------------------------------------------------------------
const state = {
  cfg: null,
  buffer: [],            // ring buffer of recent unified messages
  twitch: { ws: null, retries: 0, timer: null, channels: [] },
  kick: { ws: null, retries: 0, timer: null, chatrooms: [] /* {id, slug} */ },
  x: { sinceId: null, alarmName: "omnichat-x-poll" },
  demo: { timer: null, running: false },
};

const SOURCE_META = {
  twitch: { label: "TWITCH", emoji: "🎮", color: "#9146FF" },
  x: { label: "X", emoji: "𝕏", color: "#1D9BF0" },
  kick: { label: "KICK", emoji: "⚡", color: "#53FC18" },
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DEFAULT_CFG = {
  twitchChannels: "",   // csv logins
  kickChannels: "",     // csv slugs
  kickChatroomIds: "",  // csv ids aligned to kickChannels (optional override)
  xBearerToken: "",
  xMode: "hashtag",     // replies | mentions | hashtag
  xTarget: "",
  demo: false,
  filters: { twitch: true, x: true, kick: true },
};

function csv(s) {
  return (s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

async function loadCfg() {
  const stored = await chrome.storage.local.get("cfg");
  state.cfg = Object.assign({}, DEFAULT_CFG, stored.cfg || {});
  return state.cfg;
}

// Decide whether we are effectively in demo mode (no real config OR demo flag).
function isDemo(cfg) {
  if (cfg.demo) return true;
  const hasTwitch = csv(cfg.twitchChannels).length > 0;
  const hasKick = csv(cfg.kickChannels).length > 0;
  const hasX = cfg.xBearerToken && cfg.xTarget;
  return !(hasTwitch || hasKick || hasX);
}

// ---------------------------------------------------------------------------
// Message bus
// ---------------------------------------------------------------------------
function pushMessage(msg) {
  // normalize
  const m = {
    id: msg.id || `${msg.source}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    source: msg.source,
    channel: msg.channel || "",
    author: msg.author || "anon",
    text: (msg.text || "").replace(/[\r\n]+/g, " ").trim(),
    color: msg.color || "",
    ts: msg.ts || Date.now(),
  };
  if (!m.text) return;
  state.buffer.push(m);
  if (state.buffer.length > MAX_RETAINED) state.buffer.splice(0, state.buffer.length - MAX_RETAINED);
  // broadcast (best-effort; no panel open -> ignore the error)
  chrome.runtime.sendMessage({ type: "omnichat:msg", msg: m }).catch(() => {});
}

function broadcastStatus() {
  chrome.runtime.sendMessage({ type: "omnichat:status", status: getStatus() }).catch(() => {});
}

function getStatus() {
  const cfg = state.cfg || DEFAULT_CFG;
  return {
    demo: isDemo(cfg),
    twitch: { connected: state.twitch.ws && state.twitch.ws.readyState === 1, channels: state.twitch.channels },
    kick: { connected: state.kick.ws && state.kick.ws.readyState === 1, chatrooms: state.kick.chatrooms },
    x: { active: !!(cfg.xBearerToken && cfg.xTarget && !isDemo(cfg)), mode: cfg.xMode, target: cfg.xTarget },
  };
}

// Exponential backoff helper.
function backoffMs(retries) {
  return Math.min(30000, 1000 * Math.pow(2, retries)) + Math.floor(Math.random() * 500);
}

// ---------------------------------------------------------------------------
// TWITCH connector (anonymous IRC over WebSocket)
// ---------------------------------------------------------------------------
function startTwitch() {
  stopTwitch();
  const channels = csv(state.cfg.twitchChannels).map((c) => c.toLowerCase());
  if (channels.length === 0) return;
  state.twitch.channels = channels;

  const ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
  state.twitch.ws = ws;

  ws.onopen = () => {
    state.twitch.retries = 0;
    ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands\r\n");
    ws.send(`NICK justinfan${Math.floor(Math.random() * 1e6)}\r\n`);
    for (const ch of channels) ws.send(`JOIN #${ch}\r\n`);
    broadcastStatus();
  };

  ws.onmessage = (ev) => {
    const lines = String(ev.data).split("\r\n");
    for (const line of lines) {
      if (!line) continue;
      if (line.startsWith("PING")) {
        ws.send("PONG :tmi.twitch.tv\r\n");
        continue;
      }
      if (line.indexOf(" PRIVMSG ") === -1) continue;
      const parsed = parseTwitchLine(line);
      if (parsed) pushMessage(parsed);
    }
  };

  ws.onclose = () => scheduleTwitchReconnect();
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
}

function parseTwitchLine(line) {
  // @tags :nick!user@host PRIVMSG #chan :message text
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
  // channel between "PRIVMSG #" and " :"
  const pidx = rest.indexOf("PRIVMSG #");
  if (pidx === -1) return null;
  const afterHash = rest.slice(pidx + "PRIVMSG #".length);
  const colon = afterHash.indexOf(" :");
  if (colon === -1) return null;
  const channel = afterHash.slice(0, colon);
  const text = afterHash.slice(colon + 2); // everything after first " :" following PRIVMSG
  // author: prefer display-name tag, else parse from prefix nick
  let author = tags["display-name"];
  if (!author) {
    const bang = rest.indexOf("!");
    if (rest[0] === ":" && bang !== -1) author = rest.slice(1, bang);
  }
  return {
    id: tags["id"] || `twitch-${channel}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    source: "twitch",
    channel,
    author: author || "anon",
    text,
    color: tags["color"] || "",
    ts: Date.now(),
  };
}

function scheduleTwitchReconnect() {
  if (state.twitch.ws) state.twitch.ws = null;
  broadcastStatus();
  if (csv(state.cfg.twitchChannels).length === 0) return;
  const wait = backoffMs(state.twitch.retries++);
  clearTimeout(state.twitch.timer);
  state.twitch.timer = setTimeout(startTwitch, wait);
}

function stopTwitch() {
  clearTimeout(state.twitch.timer);
  if (state.twitch.ws) {
    const ws = state.twitch.ws;
    state.twitch.ws = null;
    ws.onclose = null;
    try { ws.close(); } catch (e) {}
  }
}

// ---------------------------------------------------------------------------
// KICK connector (Pusher WebSocket)
// ---------------------------------------------------------------------------
const KICK_WS = "wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false";

async function resolveKickChatrooms() {
  const slugs = csv(state.cfg.kickChannels);
  const overrideIds = csv(state.cfg.kickChatroomIds);
  const out = [];
  for (let i = 0; i < slugs.length; i++) {
    const slug = slugs[i];
    if (overrideIds[i]) {
      out.push({ id: overrideIds[i], slug });
      continue;
    }
    try {
      const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
        headers: {
          // browser-like UA to get past Cloudflare
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "application/json",
        },
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const json = await res.json();
      const id = json && json.chatroom && json.chatroom.id;
      if (id) out.push({ id: String(id), slug });
    } catch (e) {
      // Cloudflare 403 etc — user must supply KICK_CHATROOM_IDS override.
      console.warn(`[kick] could not resolve chatroom for "${slug}":`, e.message);
    }
  }
  return out;
}

async function startKick() {
  stopKick();
  if (csv(state.cfg.kickChannels).length === 0) return;
  const chatrooms = await resolveKickChatrooms();
  state.kick.chatrooms = chatrooms;
  if (chatrooms.length === 0) return;

  const ws = new WebSocket(KICK_WS);
  state.kick.ws = ws;

  ws.onopen = () => { state.kick.retries = 0; };

  ws.onmessage = (ev) => {
    let frame;
    try { frame = JSON.parse(ev.data); } catch (e) { return; }
    if (frame.event === "pusher:connection_established") {
      for (const cr of chatrooms) {
        ws.send(JSON.stringify({
          event: "pusher:subscribe",
          data: { auth: "", channel: `chatrooms.${cr.id}.v2` },
        }));
      }
      broadcastStatus();
      return;
    }
    if (frame.event === "pusher:ping") {
      ws.send(JSON.stringify({ event: "pusher:pong", data: {} }));
      return;
    }
    if (frame.event === "App\\Events\\ChatMessage") {
      let data;
      try { data = JSON.parse(frame.data); } catch (e) { return; }
      const cr = chatrooms.find((c) => frame.channel === `chatrooms.${c.id}.v2`);
      pushMessage({
        id: data.id || `kick-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        source: "kick",
        channel: cr ? cr.slug : frame.channel,
        author: data.sender && data.sender.username ? data.sender.username : "anon",
        text: data.content || "",
        color: (data.sender && data.sender.identity && data.sender.identity.color) || "",
        ts: Date.now(),
      });
    }
  };

  ws.onclose = () => scheduleKickReconnect();
  ws.onerror = () => { try { ws.close(); } catch (e) {} };
}

function scheduleKickReconnect() {
  if (state.kick.ws) state.kick.ws = null;
  broadcastStatus();
  if (csv(state.cfg.kickChannels).length === 0) return;
  const wait = backoffMs(state.kick.retries++);
  clearTimeout(state.kick.timer);
  state.kick.timer = setTimeout(startKick, wait);
}

function stopKick() {
  clearTimeout(state.kick.timer);
  if (state.kick.ws) {
    const ws = state.kick.ws;
    state.kick.ws = null;
    ws.onclose = null;
    try { ws.close(); } catch (e) {}
  }
}

// ---------------------------------------------------------------------------
// X / TWITTER connector (polling via alarms — survives worker sleep)
// ---------------------------------------------------------------------------
function buildXQuery(cfg) {
  const t = cfg.xTarget;
  switch (cfg.xMode) {
    case "replies": return `conversation_id:${t}`;
    case "mentions": return `@${t} -is:retweet`;
    case "hashtag":
    default: return `#${t} -is:retweet`;
  }
}

async function pollX() {
  const cfg = state.cfg;
  if (!cfg || !cfg.xBearerToken || !cfg.xTarget) return;
  if (isDemo(cfg)) return;

  const q = encodeURIComponent(buildXQuery(cfg));
  let url =
    `https://api.twitter.com/2/tweets/search/recent?query=${q}` +
    `&max_results=100&tweet.fields=created_at,author_id&expansions=author_id&user.fields=username`;
  if (state.x.sinceId) url += `&since_id=${state.x.sinceId}`;

  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.xBearerToken}` } });
    if (res.status === 429) {
      console.warn("[x] rate limited (429), backing off");
      return; // alarm will fire again later
    }
    if (!res.ok) {
      console.warn("[x] HTTP", res.status);
      return;
    }
    const json = await res.json();
    if (!json.data || json.data.length === 0) return;

    const users = {};
    if (json.includes && json.includes.users) {
      for (const u of json.includes.users) users[u.id] = u.username;
    }
    // newest-first -> reverse to chronological
    const tweets = json.data.slice().reverse();
    for (const tw of tweets) {
      if (state.x.sinceId === null || BigInt(tw.id) > BigInt(state.x.sinceId)) {
        state.x.sinceId = tw.id;
      }
      pushMessage({
        id: `x-${tw.id}`,
        source: "x",
        channel: cfg.xTarget,
        author: users[tw.author_id] || tw.author_id || "x-user",
        text: tw.text || "",
        color: "",
        ts: tw.created_at ? Date.parse(tw.created_at) : Date.now(),
      });
    }
  } catch (e) {
    console.warn("[x] poll error:", e.message);
  }
}

function startX() {
  // 12s cadence. chrome.alarms minimum is 0.5 min in some channels, so we also
  // self-schedule a setTimeout loop while the worker is alive for true ~12s polling.
  stopX();
  if (!state.cfg.xBearerToken || !state.cfg.xTarget || isDemo(state.cfg)) return;
  const loop = () => {
    pollX().finally(() => {
      state.x.timer = setTimeout(loop, 12000);
    });
  };
  loop();
}

function stopX() {
  clearTimeout(state.x.timer);
  state.x.timer = null;
}

// ---------------------------------------------------------------------------
// DEMO MODE
// ---------------------------------------------------------------------------
const DEMO_AUTHORS = {
  twitch: ["degenmike", "chartwizard", "satoshilite", "pumpfiend", "wagmiwill"],
  kick: ["kickking", "greenscreen", "leveragelad", "apechad", "moonboi"],
  x: ["blknoiz06", "cobie", "hsaka", "GiganticRebirth", "0xMidwit"],
};
const DEMO_COLORS = {
  twitch: ["#FF4500", "#1E90FF", "#9ACD32", "#FF69B4", "#00FFFF"],
  kick: ["#53FC18", "#FFD700", "#FF6347", "#7FFFD4", ""],
  x: ["", "", ""],
};
const DEMO_TEXT = [
  " Ansem cooking again 🔥", " is this the top? asking for a friend",
  " SOL looking heavy here ngl", " buy the dip you cowards",
  " 100x or homeless, no in between", " who's still holding bags from last cycle",
  " liquidation cascade incoming 📉", " GM degens, send it",
  " chart says we pump, vibes say we dump", " bullish on absolutely nothing",
  " this candle is illegal", " new ATH or refund",
];
const DEMO_CHANNELS = {
  twitch: ["ansemtrades", "costreamer"],
  kick: ["ansem", "trenches"],
  x: ["AnsemLive"],
};

function startDemo() {
  stopDemo();
  state.demo.running = true;
  const sources = ["twitch", "kick", "x"];
  let i = 0;
  state.demo.timer = setInterval(() => {
    const src = sources[i % sources.length];
    i++;
    const authors = DEMO_AUTHORS[src];
    const colors = DEMO_COLORS[src];
    const chans = DEMO_CHANNELS[src];
    const ai = Math.floor(Math.random() * authors.length);
    pushMessage({
      source: src,
      channel: chans[Math.floor(Math.random() * chans.length)],
      author: authors[ai],
      text: DEMO_TEXT[Math.floor(Math.random() * DEMO_TEXT.length)],
      color: colors[ai % colors.length] || "",
      ts: Date.now(),
    });
  }, 800);
}

function stopDemo() {
  clearInterval(state.demo.timer);
  state.demo.timer = null;
  state.demo.running = false;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
async function restartAll() {
  await loadCfg();
  stopTwitch();
  stopKick();
  stopX();
  stopDemo();

  if (isDemo(state.cfg)) {
    startDemo();
  } else {
    startTwitch();
    startKick();
    startX();
  }
  broadcastStatus();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => { restartAll(); });
chrome.runtime.onStartup.addListener(() => { restartAll(); });

// open side panel when toolbar icon clicked
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

// Keepalive alarm: ensures the worker wakes periodically and re-polls X / heals sockets.
chrome.alarms.create("omnichat-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "omnichat-keepalive") return;
  if (!state.cfg) { restartAll(); return; }
  if (isDemo(state.cfg)) {
    if (!state.demo.running) startDemo();
    return;
  }
  // heal sockets if dropped
  if (csv(state.cfg.twitchChannels).length && (!state.twitch.ws || state.twitch.ws.readyState > 1)) startTwitch();
  if (csv(state.cfg.kickChannels).length && (!state.kick.ws || state.kick.ws.readyState > 1)) startKick();
  if (state.cfg.xBearerToken && state.cfg.xTarget && !state.x.timer) startX();
});

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.type === "omnichat:getBackfill") {
    sendResponse({ buffer: state.buffer, status: getStatus(), filters: (state.cfg || DEFAULT_CFG).filters });
    return true;
  }
  if (req.type === "omnichat:getStatus") {
    sendResponse({ status: getStatus() });
    return true;
  }
  if (req.type === "omnichat:setFilters") {
    (async () => {
      await loadCfg();
      state.cfg.filters = req.filters;
      await chrome.storage.local.set({ cfg: state.cfg });
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (req.type === "omnichat:reload") {
    restartAll().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

// React to options changes immediately.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.cfg) {
    // Only fully restart connectors if connection-relevant fields changed.
    const oldV = changes.cfg.oldValue || {};
    const newV = changes.cfg.newValue || {};
    const keys = ["twitchChannels", "kickChannels", "kickChatroomIds", "xBearerToken", "xMode", "xTarget", "demo"];
    const changed = keys.some((k) => oldV[k] !== newV[k]);
    if (changed) restartAll();
  }
});

// Kick things off as soon as the worker loads.
restartAll();
