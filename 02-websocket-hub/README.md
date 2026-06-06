# OmniChat Hub 📡

**Unified chat aggregator — Twitch + X + Kick in one real-time feed with source labels.**
Built for the MarketBubble $10,000 Vibe Code Challenge (Ansem / @blknoiz06 live trading show).

Watch every channel in one place: anonymous Twitch IRC, Kick's Pusher chat, and a polled X
search feed, all merged into a single labeled, filterable, auto-scrolling stream.

## Architecture (2-3 sentences)

A **Node backend** (`server/`, Express + `ws`) runs three connectors — Twitch anonymous IRC over
WebSocket, Kick over the public Pusher socket, and X via API-v2 recent-search polling — normalizes
every event into one unified message schema and fans it out to browsers over a `/ws` WebSocket.
A small **React + Vite frontend** (`web/`) connects to that socket, renders the merged feed with
per-source badges, three source-filter toggles, auto-scroll, and reconnect-with-backoff. With no
config it runs in **DEMO MODE**, injecting synthetic crypto-stream chatter so it works instantly.

```
Twitch IRC  ─┐
Kick Pusher ─┤→  Node server (merge → unified schema → ring buffer)  ──/ws──►  React feed (badges + filters)
X polling   ─┘                         (DEMO mode when unconfigured)
```

## Install + Run (Windows-friendly)

From this folder (`02-websocket-hub`):

```bash
npm install            # installs server deps + (via postinstall) web deps
```

### Option A — one-command dev (server + Vite, hot reload)

```bash
npm run dev
```

- Server: http://localhost:3848  (WebSocket at `/ws`)
- UI (Vite dev, proxies `/ws` + `/api` to the server): **http://localhost:5180**

Open **http://localhost:5180**. With no `.env`, you'll immediately see the DEMO feed.

### Option B — built static fallback (single server, no Vite)

```bash
npm run build          # builds web/ into web/dist
npm start              # Node serves the built UI + WebSocket on one port
```

Open **http://localhost:3848**.

> If `npm install` ever skips the web deps, run `npm --prefix web install` once, then re-run.

## Point it at real channels

Copy `.env.example` to `.env` (this folder) and fill in what you want — every field is optional:

```env
TWITCH_CHANNELS=ansem,xqc            # channel logins, no '#'
KICK_CHANNELS=ansem,trainwreckstv    # channel slugs
# KICK_CHATROOM_IDS=123456,789012    # only if Cloudflare blocks the slug lookup
X_BEARER_TOKEN=AAAA...               # X API v2 bearer (omit to skip X)
X_MODE=mentions                      # replies | mentions | hashtag
X_TARGET=blknoiz06                   # convo id | handle | tag (no @/#)
PORT=3848
DEMO=                                # set to 1 to force demo even when configured
```

The server also reads the shared `../.env` in the challenge root automatically, so the provided
keys work without copying. Multiple channels per platform are fully supported (comma-separated).
If **nothing** is configured (or `DEMO=1`), it falls back to DEMO mode.

## How it works (per the connector spec)

- **Twitch** — connects to `wss://irc-ws.chat.twitch.tv:443`, sends `CAP REQ`, an anonymous
  `justinfan####` `NICK`, and one `JOIN #channel` per channel; replies to `PING` with `PONG`;
  parses tagged `PRIVMSG` lines (display-name → author, color tag → color).
- **Kick** — resolves `chatroom.id` from `kick.com/api/v2/channels/{slug}` with a browser UA
  (or `KICK_CHATROOM_IDS` override), connects to Pusher (`ws-us2`, public app key), subscribes
  `chatrooms.{id}.v2`, and decodes `App\Events\ChatMessage` (the `data` field is a JSON string).
- **X** — polls `GET /2/tweets/search/recent` every ~12s with `since_id`, builds the query from
  `X_MODE`/`X_TARGET`, reverses newest-first results to chronological, maps `author_id` →
  username, and backs off on HTTP 429.

Every message is `{ id, source, channel, author, text, color, ts }`. The feed caps retained
messages at **500** on both server and client.
