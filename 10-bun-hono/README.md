# ⚡ OmniChat Lite

**Unified chat aggregator — Twitch + X + Kick in one real-time feed, with source labels.**
Built for the MarketBubble $10,000 Vibe Code Challenge (Ansem's live trading show).

One vertical feed. Every message wears a clear **SOURCE BADGE** (🎮 TWITCH / 𝕏 X / ⚡ KICK),
its channel, the author (in their chat color), and the text. Three toggle buttons show/hide
each source live. Supports **multiple channels per platform**. Runs out of the box in **DEMO
MODE** with zero config.

## Architecture (in 3 sentences)

A single `server.ts` runs on **Bun** and uses **Hono** to serve the inline static UI plus a
tiny config endpoint, while **`Bun.serve`'s native WebSocket** server fans messages out to
every open browser tab. Three connectors run in the same process — **Twitch** (anonymous IRC
over WebSocket, no key), **Kick** (Pusher WebSocket, no key), and **X** (API v2 recent-search
polling with a bearer token) — each normalizing into one unified `{id, source, channel, author,
text, color, ts}` schema that gets merged into a 500-message ring buffer. The browser renders,
labels, filters, and auto-scrolls; both server connectors and the browser socket reconnect with
capped exponential backoff.

## Install & run (Windows-friendly)

This entry uses **Bun**. Install it once (PowerShell):

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
```

Then, from this folder:

```powershell
bun install
bun run server.ts
```

Open **http://localhost:8787**. With no `.env`, it boots straight into **DEMO MODE** — you'll
see labeled Twitch/X/Kick messages streaming immediately, and the three filter toggles work.

> **Not using Bun?** This entry depends on Bun-native APIs (`Bun.serve`, Bun's bundled
> WebSocket/`.env` loading), so Bun is required to run it. Bun installs cleanly on Windows via
> the one-liner above and on macOS/Linux via `curl -fsSL https://bun.sh/install | bash`.

## Point it at real channels

Copy `.env.example` to `.env` and fill in any subset (Bun auto-loads `.env`):

```powershell
copy .env.example .env
```

- **Twitch** (no key): `TWITCH_CHANNELS=ansem,xqc` — comma-separated logins, lowercase.
- **Kick** (no key): `KICK_CHANNELS=trainwreckstv,adin` — comma-separated slugs. If Kick's API
  is blocked by Cloudflare (403), set `KICK_CHATROOM_IDS=` to a comma list of chatroom ids in
  the same order as `KICK_CHANNELS`.
- **X** (bearer token): set `X_BEARER_TOKEN`, then `X_MODE=replies|mentions|hashtag` and
  `X_TARGET` (a conversation id / handle / tag). X has no live chat, so it polls recent search
  every ~12s and streams new tweets; 429 rate limits back off automatically.

As soon as **any** real source is configured, demo mode turns off (set `DEMO=1` to force it
back on). Each platform accepts multiple channels, so you can co-stream-aggregate several
streamers at once.

Restart after editing `.env`:

```powershell
bun run server.ts
```

## Files

- `server.ts` — the whole backend: Hono routes, `Bun.serve` WebSocket fan-out, all three
  connectors, demo mode, reconnect/backoff, 500-message cap.
- `public/index.html` — inline single-file UI (badges, toggles, auto-scroll, reconnect).
- `package.json` — Bun scripts + Hono dep.
- `.env.example` — every knob, documented.
