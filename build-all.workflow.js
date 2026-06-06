export const meta = {
  name: 'build-10-chat-aggregators',
  description: 'Build 10 distinct unified Twitch+X+Kick chat-aggregator architectures in parallel',
  phases: [
    { title: 'Build', detail: '10 agents, one runnable app each (distinct stack)' },
    { title: 'Index', detail: 'top-level README comparing all 10 + run-all guide' },
  ],
}

// ---------------------------------------------------------------------------
// SHARED CONNECTOR SPEC — every agent receives this verbatim. These are the
// real, tested mechanics for reading live chat from all three platforms.
// ---------------------------------------------------------------------------
const SPEC = `
# CHALLENGE
MarketBubble $10,000 Vibe Code Challenge (deadline June 11 2026). For Ansem's (@blknoiz06)
live trading show. BUILD: "Unified chat aggregator — Twitch + X + Kick in one real-time feed
with source labels." Judges reward: it actually works, real-time, clear per-message SOURCE
LABELS, source-filter toggles, polish. A competitor is already doing multi-streamer co-stream
aggregation — so support MULTIPLE channels per platform.

# UNIFIED MESSAGE SCHEMA (every connector emits this exact shape)
{
  id: string,          // unique per message
  source: "twitch" | "x" | "kick",
  channel: string,     // which stream/target it came from
  author: string,      // display name / username
  text: string,        // message body (strip newlines for single-line UIs)
  color: string,       // hex accent for the author (optional, may be "")
  ts: number           // epoch ms
}

# SOURCE LABELS (REQUIRED — render a clear badge on every message)
twitch -> label "TWITCH", emoji 🎮, color #9146FF (purple)
x      -> label "X",      emoji 𝕏,  color #1D9BF0 (or white on dark)
kick   -> label "KICK",   emoji ⚡, color #53FC18 (green)

# ---- TWITCH CONNECTOR (anonymous IRC over WebSocket — NO API KEY) ----
URL: wss://irc-ws.chat.twitch.tv:443
On open, send these lines (each terminated with \\r\\n):
  CAP REQ :twitch.tv/tags twitch.tv/commands
  NICK justinfan{randomInt}        // anonymous read-only login, no PASS needed
  JOIN #{channelLoginLowercase}    // one JOIN per channel
Handle keepalive: if a line starts with "PING", reply "PONG :tmi.twitch.tv\\r\\n".
Parsing a chat line (with tags enabled it looks like):
  @badge-info=;color=#FF0000;display-name=Alice;... :alice!alice@alice.tmi.twitch.tv PRIVMSG #chan :hello world
  - Only lines containing " PRIVMSG " are chat.
  - tags are the leading @...; split on ';' into k=v. display-name -> author, color -> color.
  - channel = substring between "PRIVMSG #" and " :". text = everything after the FIRST " :" that
    follows PRIVMSG (note the message itself may contain ':').
  - id: synthesize (tags 'id' if present, else channel+ts+random).

# ---- KICK CONNECTOR (Pusher WebSocket — NO API KEY) ----
1) Resolve chatroom id for a slug (server-side fetch; Kick is behind Cloudflare so send a
   browser-like User-Agent header):
     GET https://kick.com/api/v2/channels/{slug}  -> json.chatroom.id
   If that 403s, allow an env override KICK_CHATROOM_IDS (comma list aligned to KICK_CHANNELS).
2) Connect Pusher (public app key, cluster us2):
     wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false
3) On receiving event "pusher:connection_established", subscribe each chatroom:
     send JSON {"event":"pusher:subscribe","data":{"auth":"","channel":"chatrooms.{chatroomId}.v2"}}
4) Chat messages: frames are JSON { event, channel, data }. When event === "App\\\\Events\\\\ChatMessage"
   the data field is a JSON STRING -> JSON.parse it -> { content, sender:{ username, identity:{color} } }.
   author = sender.username, text = content, color = sender.identity?.color || "".
   Respond to "pusher:ping" with {"event":"pusher:pong","data":{}}.

# ---- X / TWITTER CONNECTOR (API v2 Basic tier — bearer token, POLLING) ----
X has no live "chat", so we poll recent search and stream the new tweets as the X feed.
Token: env X_BEARER_TOKEN (already provided). Header: Authorization: Bearer <token>.
Config (env): X_MODE = replies|mentions|hashtag, X_TARGET = the conversation id / handle / tag.
Build the query:
  replies  -> conversation_id:{X_TARGET}
  mentions -> @{X_TARGET} -is:retweet
  hashtag  -> #{X_TARGET} -is:retweet
Endpoint:
  GET https://api.twitter.com/2/tweets/search/recent
      ?query={urlencoded q}&max_results=100&tweet.fields=created_at,author_id
      &expansions=author_id&user.fields=username&since_id={lastSeenId}
Poll every ~12s. data[] is newest-first -> reverse to chronological. Map author_id via
includes.users[].username. Track since_id = max id seen so each poll only yields new tweets.
Handle 429 (rate limit) gracefully: back off, keep running. If no token, skip X (don't crash).

# DEMO MODE (REQUIRED so the app is demonstrable with zero config)
If no channels/targets are configured, OR env DEMO=1, inject synthetic messages from all three
sources every ~800ms (rotating authors + crypto-stream-flavored text) so the merged, labeled,
filterable feed visibly works out of the box.

# UX REQUIREMENTS for any visual app
- One vertical real-time feed, newest at bottom (auto-scroll, pausable on hover/scroll-up).
- Every row shows: source badge (emoji+label+color) | channel | author (in author color) | text.
- Source-filter toggles: three buttons (Twitch / X / Kick) to show/hide each source.
- Reconnect with backoff on socket drop. Cap retained messages (e.g. 500) to bound memory.

# ENV VARS (shared convention; read from process env / .env)
X_BEARER_TOKEN, TWITCH_CHANNELS (csv logins), KICK_CHANNELS (csv slugs),
KICK_CHATROOM_IDS (optional csv), X_MODE, X_TARGET, PORT, DEMO
`;

const COMMON = `
You are building ONE entry for a competition. Quality bar: it must actually run and visibly work.
WORK INSIDE the current working directory. Create your app in the subfolder named below and put
ALL files there. Use the shared connector spec EXACTLY (the mechanics are real and tested).
Requirements for your entry:
- Implement all THREE connectors (Twitch anon IRC, Kick Pusher, X polling) per the spec.
- Emit/merge the unified message schema; render clear per-message SOURCE LABELS.
- Support multiple channels per platform (csv env) and the three source-filter toggles.
- Include DEMO MODE so it works with zero config (so judges/the user can run it instantly).
- Reconnect-with-backoff; cap retained messages.
- Write a concise README.md in your folder: what it is, the architecture in 2-3 sentences,
  exact install + run commands (Windows-friendly), and how to point it at real channels.
- Write a .env.example in your folder.
- Keep dependencies minimal and pin nothing exotic. Prefer stacks that install/run cleanly on Windows.
- Do NOT run long-lived servers or installs yourself; just write the code and verify it reads correctly.
Return ONLY the structured object (the harness will collect it).
`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['folder', 'name', 'stack', 'files', 'runCommands', 'differentiator', 'status'],
  properties: {
    folder: { type: 'string' },
    name: { type: 'string' },
    stack: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    runCommands: { type: 'array', items: { type: 'string' } },
    differentiator: { type: 'string', description: 'one line: why a judge would pick this one' },
    status: { type: 'string', enum: ['complete', 'partial'] },
    notes: { type: 'string' },
  },
}

const APPS = [
  {
    folder: '01-browser-extension',
    name: 'OmniChat Extension',
    label: 'ext',
    brief: `Chrome Manifest V3 extension. A background service worker runs all three connectors
    (Twitch IRC WS, Kick Pusher WS directly from the worker, X polling with the bearer token stored
    in extension storage/options). A SidePanel (or popup) renders the merged, labeled, filterable feed.
    Do NOT scrape DOM — connect to the sources directly from the background worker; it is far more robust.
    Files: manifest.json (MV3, sidePanel + storage + alarms perms), background.js (connectors + message bus),
    sidepanel.html/js/css (feed UI + filter toggles), options.html/js (configure channels, X mode/target, token).
    Provide DEMO mode in the worker. README must explain chrome://extensions -> Load unpacked.`,
  },
  {
    folder: '02-websocket-hub',
    name: 'OmniChat Hub',
    label: 'ws-hub',
    brief: `Node backend + React (Vite) frontend, the robust classic. Backend (Node, 'ws' + Express)
    runs the three connectors, merges into one stream, and fans out to browsers over a WebSocket.
    Frontend = small React+Vite app that renders the feed with badges + filter toggles, auto-scroll,
    reconnect. Two packages or a simple monorepo (server/ and web/). Provide one 'npm run dev' path
    (e.g. concurrently) AND a built-static fallback. Demo mode in the server when unconfigured.`,
  },
  {
    folder: '03-edge-durable-object',
    name: 'OmniChat Edge',
    label: 'edge',
    brief: `Cloudflare Worker + Durable Object (the user has CF tokens). A single Durable Object is the
    fan-in hub: it holds the upstream connections (Twitch IRC WS + Kick Pusher WS via the DO's WebSocket
    client, X polling via a scheduled/alarm fetch) and fans out to connected browser WebSockets. Worker
    routes / (static HTML feed UI) and /ws (upgrade -> DO). Include wrangler.toml (compatibility_date,
    durable_objects binding + migration), src/worker.js, src/hub.js (the DO), and public/index.html UI with
    badges + toggles. Note in README: X token via 'wrangler secret put X_BEARER_TOKEN'; local run via
    'wrangler dev'. Demo mode when unconfigured.`,
  },
  {
    folder: '04-obs-overlay',
    name: 'OmniChat Overlay',
    label: 'overlay',
    brief: `THE show use-case: a transparent OBS Browser-Source overlay. A single static page connects
    directly from the browser to Twitch IRC WS and Kick Pusher WS (both allow browser WS). For X, include
    a tiny optional Node proxy (x-proxy.js, ~40 lines) that holds the bearer token and exposes
    GET /x?since=... returning new tweets as JSON (the page polls it); if the proxy/token is absent the
    overlay still runs Twitch+Kick (+demo). Styling: transparent background, large readable text with
    outline/shadow for legibility over video, smooth slide-in animation, source badges, auto-fade old
    messages, configurable via URL query (?twitch=a,b&kick=c&x=...&max=20). README: how to add as a
    Browser Source in OBS and the URL params. Demo mode via ?demo=1.`,
  },
  {
    folder: '05-go-sse',
    name: 'OmniChat Go',
    label: 'go',
    brief: `High-throughput Go service, single binary, Server-Sent Events. Use only the std lib +
    nhooyr.io/websocket OR gorilla/websocket for the upstream Twitch/Kick sockets (pick one, add go.mod).
    A goroutine per upstream source feeds a central hub channel; an /events SSE endpoint streams merged
    JSON messages to browsers; / serves an embedded (go:embed) static HTML feed UI with badges + toggles.
    X via a polling goroutine using net/http. go.mod + main.go + hub.go + connectors + static/index.html.
    README: 'go run .' Demo mode when unconfigured.`,
  },
  {
    folder: '06-ai-augmented',
    name: 'OmniChat AI',
    label: 'ai',
    brief: `Python FastAPI + a Claude AI layer (the AI angle several repliers asked for). FastAPI app
    runs the three connectors in asyncio tasks (websockets lib for Twitch/Kick, httpx for X polling),
    merges, and pushes to the browser over a WebSocket (/ws). The AI layer (using the Anthropic SDK,
    model claude-haiku-4-5-20251001 for speed/cost, key from env ANTHROPIC_API_KEY) does: per-message
    spam/toxicity flag + sentiment emoji, and a rolling 'what is chat talking about' summary every ~15s
    shown in a top banner. AI must DEGRADE GRACEFULLY: if no ANTHROPIC_API_KEY, skip AI and run plain.
    Files: main.py, connectors.py, ai.py, static/index.html (feed + toggles + summary banner),
    requirements.txt. README: 'pip install -r requirements.txt' then 'uvicorn main:app'. Demo mode.
    IMPORTANT: read the Anthropic API conventions from the claude-api reference before writing ai.py —
    use the current Messages API shape and the model id claude-haiku-4-5-20251001.`,
  },
  {
    folder: '07-desktop-electron',
    name: 'OmniChat Desktop',
    label: 'desktop',
    brief: `Local-first desktop app via Electron (runs on the streamer's machine, tokens stay local,
    lowest latency, no server to host). Electron main process runs the three connectors directly and
    forwards messages to the renderer via IPC; the renderer is the feed UI with badges + filter toggles
    + a settings panel (channels, X mode/target/token persisted to a local JSON via app.getPath('userData')).
    Files: package.json (electron dep + start script), main.js, preload.js, renderer/index.html + renderer.js + styles.css,
    connectors.js (shared). README: 'npm install' then 'npm start'. Demo mode when unconfigured.`,
  },
  {
    folder: '08-bot-bridge',
    name: 'OmniChat Bridge',
    label: 'bridge',
    brief: `The "webhooks -> table view" baseline, done well. A Node service runs the three connectors and
    (a) forwards every message to a Telegram chat (Bot API sendMessage, token+chat id from env) and/or a
    Discord webhook (env DISCORD_WEBHOOK_URL), each message prefixed with its source label, AND (b) serves a
    minimal live web "table view" at / (source | channel | author | text rows, with filter toggles) over SSE.
    Both sinks optional/independent. Throttle/queue outbound to respect Telegram/Discord rate limits (~1 msg/s,
    batch if needed). Files: index.js, connectors.js, public/index.html, package.json. README + .env.example.
    Demo mode when unconfigured (web view still demos; skip TG/Discord if creds absent).`,
  },
  {
    folder: '09-saas-nextjs',
    name: 'OmniChat Cloud',
    label: 'saas',
    brief: `The "own the tool everyone uses" SaaS. Next.js (app router) + Prisma + SQLite (file db, zero
    setup). Multi-tenant "rooms": create a room with a config (twitch/kick/x targets); a server-side
    aggregator per room runs the connectors, PERSISTS messages to the db, and streams live to room viewers
    over an SSE route (/api/rooms/[id]/stream). Pages: '/' create/list rooms, '/room/[id]' the live feed
    (badges + filter toggles) with a "load history" button reading persisted messages, and a tiny analytics
    strip (msgs/min per source). Prisma schema (Room, Message), seed/migrate steps. Keep it runnable with
    'npm install && npx prisma db push && npm run dev'. Demo room auto-created on first run.`,
  },
  {
    folder: '10-bun-hono',
    name: 'OmniChat Lite',
    label: 'bun',
    brief: `Ultra-light modern stack: Bun + Hono, basically one process. A single server.ts uses Bun's
    native WebSocket server (Bun.serve with websocket handler) for browser fan-out, runs the three
    connectors (Bun's global fetch + WebSocket for Twitch/Kick, fetch polling for X), and serves an inline
    static feed UI (badges + toggles) from the same process — minimal files, fastest cold start & deploy.
    Files: server.ts, public/index.html (or inlined), package.json (bun), README (install bun, 'bun run server.ts').
    Demo mode when unconfigured. Note for non-Bun users how to run.`,
  },
]

phase('Build')
log(`Building ${APPS.length} distinct chat-aggregator architectures in parallel...`)

const results = await parallel(APPS.map(app => () =>
  agent(
    `${COMMON}\n\nYOUR ENTRY: ${app.name}  (folder: ${app.folder})\n${app.brief}\n\n=== SHARED CONNECTOR SPEC ===\n${SPEC}`,
    { label: `build:${app.label}`, phase: 'Build', schema: SCHEMA }
  )
))

const built = results.filter(Boolean)
log(`${built.length}/${APPS.length} entries built. Writing comparison index...`)

phase('Index')
const summary = JSON.stringify(built, null, 2)
await agent(
  `Ten unified Twitch+X+Kick chat-aggregator apps were just built, each in its own subfolder of the
current working directory. Here is the structured manifest of what was built:\n\n${summary}\n\n
Write a single top-level file README.md in the current working directory that:
1. Explains the MarketBubble $10k challenge brief in 2 lines and that this repo offers 10 distinct
   architectures to choose from.
2. Has a comparison TABLE: # | folder | name | stack | differentiator | run command.
3. Has a "Quick start — try any of them" section: note the shared root .env (already present with the
   X token) and that each app reads TWITCH_CHANNELS / KICK_CHANNELS / X_MODE / X_TARGET, and that DEMO
   mode works with zero config.
4. A short "How the connectors work" section (Twitch anon IRC, Kick Pusher, X polling) — 3-4 lines each.
5. A "Which should I submit?" recommendation: rank the top 3 for the show use-case and say why.
Also write a .gitignore at the top level that ignores: node_modules, .env, dist, build, *.log, .wrangler,
.next, target, __pycache__, *.sqlite, db.sqlite.
Return a one-paragraph summary of what you wrote.`,
  { label: 'index', phase: 'Index' }
)

return { built: built.length, total: APPS.length, entries: built }
