# OmniChat Bridge

Unified **Twitch + X + Kick** chat aggregator for Ansem's (@blknoiz06) live trading show.
One Node service runs all three connectors and fans every message — clearly tagged with its
**SOURCE LABEL** — to (a) a live web **table view** at `/` over SSE, and (b) optionally a
**Telegram** chat and/or a **Discord** webhook. Built for the MarketBubble $10,000 Vibe Code Challenge.

## Architecture (2-3 sentences)

`connectors.js` opens an anonymous Twitch IRC WebSocket, a Kick Pusher WebSocket, and polls the
X API v2 recent-search endpoint, normalizing all three into one unified message schema
(`{id, source, channel, author, text, color, ts}`). `index.js` fans each message to three sinks:
a Server-Sent-Events stream that powers the live web table at `/`, plus an outbound queue that
throttles to ~1 msg/s (batching bursts) before forwarding to Telegram and/or Discord. All
sources reconnect with exponential backoff, retained messages are capped at 500, and with zero
config the app runs in **DEMO MODE** with a synthetic merged feed.

## Install + Run (Windows-friendly)

Requires **Node.js 18+** (uses built-in `fetch`).

```powershell
cd 08-bot-bridge
npm install
npm start
```

Then open **http://localhost:8088** — you'll immediately see the labeled, filterable feed
running in DEMO MODE (no config needed). Source-filter toggles (🎮 Twitch / 𝕏 X / ⚡ Kick) are
in the header; the feed auto-scrolls and pauses when you scroll up.

## Point it at real channels

Copy `.env.example` to `.env` and set any of these (all optional, mix and match):

```ini
# Twitch — CSV of channel logins (no API key needed)
TWITCH_CHANNELS=xqc,kaicenat

# Kick — CSV of channel slugs (no API key needed)
KICK_CHANNELS=xqc,trainwreckstv
# If Kick's API is Cloudflare-blocked, supply chatroom ids aligned to the slugs:
KICK_CHATROOM_IDS=668,12826

# X / Twitter — needs a bearer token; polled every ~12s
X_BEARER_TOKEN=AAAA...
X_MODE=hashtag          # replies | mentions | hashtag
X_TARGET=bitcoin        # conversation id / handle / tag
```

As soon as **any** real source is configured, DEMO MODE turns off automatically (or force it
back on with `DEMO=1`).

### Enable the outbound sinks (both optional & independent)

```ini
# Telegram — both required to send
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=987654321

# Discord — webhook URL from Server Settings -> Integrations -> Webhooks
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

Every forwarded message is prefixed with its source label, e.g. `🎮 TWITCH #xqc alice: gm`.
Outbound is throttled to ~1 msg/s and batches up to 12 lines per message to stay inside
Telegram/Discord rate limits. If a sink's creds are absent it's simply skipped — the web view
always works.

## Files

- `index.js` — HTTP server (web view + SSE + `/meta`), the rate-limited outbound queue, sinks.
- `connectors.js` — the three connectors, the unified schema, and DEMO MODE.
- `public/index.html` — the live table view (badges, filter toggles, auto-scroll).
- `package.json`, `.env.example`, `README.md`.
