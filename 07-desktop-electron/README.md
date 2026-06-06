# OmniChat Desktop ◎

**Unified live-chat aggregator — Twitch + X + Kick in one real-time feed with source labels.**
A local-first **Electron desktop app** built for Ansem's (@blknoiz06) live trading show
(MarketBubble $10,000 Vibe Code Challenge).

Runs entirely on the streamer's own machine: your tokens never leave your computer, there's no
server to host, and latency is as low as it gets. Just `npm install` then `npm start`.

## Architecture (in 3 sentences)
The **Electron main process** (`main.js` + `connectors.js`) runs the three connectors directly in
Node — Twitch anonymous IRC over WebSocket, Kick's public Pusher WebSocket, and X/Twitter API v2
recent-search polling — normalizing every event into one unified message schema. It forwards those
messages and connection-status events to the **renderer** (`renderer/`) over a sandboxed IPC bridge
(`preload.js`), where the feed UI draws source badges, applies the three filter toggles, and
auto-scrolls. Channels and the X token are edited in an in-app settings panel and persisted to a
local JSON file under `app.getPath('userData')`, so nothing is ever sent to a backend.

## Features
- **Three real connectors**, no keys required for Twitch or Kick (X uses your bearer token).
- **Multiple channels per platform** (csv) — built for multi-streamer co-stream aggregation.
- **Clear SOURCE LABELS** on every row: 🎮 TWITCH (purple), 𝕏 X, ⚡ KICK (green).
- **Source-filter toggles** — show/hide each platform with one click.
- **Demo Mode** with zero config: synthetic crypto-stream chatter from all three sources so it
  visibly works the instant you launch it.
- **Reconnect with exponential backoff** on socket drops; X handles 429 rate limits gracefully.
- **Capped feed** (500 messages) to bound memory; **auto-scroll** that pauses when you scroll up.
- **Local-first settings** — channels + X mode/target/token persisted to your machine only.

## Install & Run (Windows-friendly)
```powershell
cd 07-desktop-electron
npm install
npm start
```
That's it. With no `.env` it launches straight into **Demo Mode** so judges can see the merged,
labeled, filterable feed immediately.

## Point it at real channels
Two ways — both stay local:

**A) In-app (easiest):** click the **⚙ gear** (top-right), fill in channels / X target / token,
hit **Save & Reconnect**. Settings persist across restarts.

**B) Via `.env`:** copy `.env.example` to `.env` and edit:
```ini
TWITCH_CHANNELS=ansem,xqc          # csv of Twitch logins (no key needed)
KICK_CHANNELS=trainwreckstv        # csv of Kick slugs   (no key needed)
KICK_CHATROOM_IDS=                 # optional, only if Kick's Cloudflare blocks slug lookup
X_BEARER_TOKEN=AAAA...             # X API v2 token; blank = X feed skipped
X_MODE=hashtag                     # hashtag | mentions | replies
X_TARGET=bitcoin                   # the #tag / @handle / conversation_id
DEMO=                              # set to 1 to force the synthetic feed
```

### Notes
- **Twitch** connects as an anonymous `justinfan` read-only user — no account or key.
- **Kick** resolves each slug's chatroom id via `kick.com/api/v2/channels/{slug}`. If Cloudflare
  blocks that from your machine, paste the ids into `KICK_CHATROOM_IDS` (aligned to `KICK_CHANNELS`).
- **X** has no live chat API, so it **polls** recent search every ~12s and streams new tweets into
  the feed (deduped via `since_id`). No token → X is simply skipped, the app keeps running.

## Files
- `main.js` — Electron main: settings persistence, engine lifecycle, IPC, tiny `.env` loader.
- `connectors.js` — shared `ChatEngine`: the three connectors + demo mode + backoff (the real logic).
- `preload.js` — contextIsolated IPC bridge (`window.omni`).
- `renderer/index.html` · `renderer.js` · `styles.css` — the feed UI, filters, settings panel.
