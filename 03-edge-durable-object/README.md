# OmniChat Edge

Unified **Twitch + X + Kick** chat aggregator for Ansem's (@blknoiz06) live trading show — one real-time feed with clear per-message **SOURCE LABELS** and source-filter toggles. Built for the MarketBubble $10,000 Vibe Code Challenge.

## What it is

A Cloudflare Worker fronts a **single Durable Object** that acts as the fan-in hub. The DO holds the upstream connections — Twitch anonymous IRC (WebSocket), Kick Pusher (WebSocket), and X v2 recent-search polling (driven by the DO's alarm) — normalizes everything to one unified message schema, and fans messages out to every connected browser WebSocket. The Worker routes `/` to a static feed UI and `/ws` to a DO WebSocket upgrade; if nothing is configured it runs in **demo mode** so it works instantly.

## Architecture (2-3 sentences)

`worker.js` routes requests: `/ws` upgrades to the one global `Hub` Durable Object, everything else serves the static `public/` UI. `hub.js` (the DO) owns the upstream sockets + X alarm poll, keeps a capped 500-message ring buffer, and broadcasts unified `{id, source, channel, author, text, color, ts}` messages to all browser clients. The browser renders one vertical auto-scrolling feed with source badges (🎮 TWITCH / 𝕏 X / ⚡ KICK), three filter toggles, and reconnect-with-backoff on both the browser↔Worker and DO↔upstream legs.

## Install + run (Windows-friendly)

```powershell
cd 03-edge-durable-object
npm install
npx wrangler dev
```

Then open the URL wrangler prints (usually `http://localhost:8787`). With no config it starts in **demo mode** immediately — synthetic Twitch/X/Kick messages stream in so you can see the labeled, filterable feed working.

> First run will ask you to log in to Cloudflare (`wrangler login`) only if you `deploy`; `wrangler dev` runs locally without an account.

## Point it at real channels

Edit `[vars]` in **`wrangler.toml`** (or copy `.env.example` to `.dev.vars` for local dev — wrangler auto-loads it):

- `TWITCH_CHANNELS` — csv of channel logins, lowercase (e.g. `ansem,xqc`). No API key — anonymous IRC.
- `KICK_CHANNELS` — csv of channel slugs (e.g. `trainwreckstv,xqc`). No API key — public Pusher app. If `kick.com`'s channel API is Cloudflare-blocked in your region, set `KICK_CHATROOM_IDS` (csv aligned to `KICK_CHANNELS`).
- **X** uses a bearer token (Basic tier). Set it as a **secret**, not in the toml:
  ```powershell
  npx wrangler secret put X_BEARER_TOKEN
  ```
  For local dev put `X_BEARER_TOKEN=...` in `.dev.vars`. Then set `X_MODE` (`replies` / `mentions` / `hashtag`) and `X_TARGET` (conversation id / handle / tag). X is polled every ~12s; 429s back off and keep running; if no token, X is skipped (no crash).

Set `DEMO=1` to force synthetic messages even with real channels configured.

## Deploy to Cloudflare

```powershell
npx wrangler deploy
npx wrangler secret put X_BEARER_TOKEN   # if using X
```

The `[[migrations]]` block in `wrangler.toml` registers the `Hub` Durable Object class on first deploy.

## Source labels

| source | label | emoji | color |
|--------|-------|-------|-------|
| twitch | TWITCH | 🎮 | `#9146FF` |
| x | X | 𝕏 | `#1D9BF0` |
| kick | KICK | ⚡ | `#53FC18` |

Every row shows: **badge | #channel | author (in author color) | text | time**. The three toggle buttons in the header show/hide each source live.
