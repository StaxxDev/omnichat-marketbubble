# OmniChat Cloud

**Unified chat aggregator as a multi-tenant SaaS** — merges **Twitch + X + Kick**
into one real-time, source-labeled feed. Built for Ansem's (@blknoiz06) live trading
show, this is the "own the tool everyone uses" version: spin up a **room** with its own
config, a server-side aggregator runs the connectors, **persists every message to a
SQLite db**, and streams live to all viewers over SSE.

## Architecture (in brief)

- **Next.js (App Router) + Prisma + SQLite** (file db, zero external setup).
- One **per-room aggregator** (`lib/aggregator.js`) runs the three connectors
  (`lib/connectors.js`: Twitch anon IRC WS, Kick Pusher WS, X v2 polling), emits the
  **unified message schema**, persists to the db (deduped, capped at 500/room), and
  fans out to viewers over the SSE route `GET /api/rooms/[id]/stream`.
- The room page subscribes to SSE for live messages, has **source-filter toggles**,
  a **Load history** button (reads persisted messages), and a **msgs/min-per-source**
  analytics strip. Reconnect-with-backoff on both the server connectors and the
  browser EventSource. Demo mode injects synthetic messages so it works with zero config.

## Install + run (Windows-friendly)

```bash
npm install
copy .env.example .env        # (PowerShell: Copy-Item .env.example .env)
npx prisma db push            # creates prisma/dev.db from the schema
npm run dev                   # http://localhost:3000
```

On first run a **Demo Room** is auto-created and starts streaming synthetic
Twitch/X/Kick messages immediately — open it and you'll see the labeled, filterable feed.

> `npm install` runs `prisma generate` automatically (postinstall). If you ever skip it,
> run `npx prisma generate` manually before `npm run dev`.

## Point it at real channels

Create a room from the home page (`/`) and fill in any of:

- **Twitch channels** — csv logins, e.g. `xqc, ansem` (anonymous IRC, **no key**).
- **Kick channels** — csv slugs, e.g. `trainwreckstv, adin` (Pusher, **no key**).
  Kick sits behind Cloudflare; if chatroom-id resolution 403s, paste pre-resolved ids
  into **Kick chatroom ids** (csv aligned to the slugs).
- **X** — set **X mode** (`hashtag` / `mentions` / `replies`) and **X target**.
  Requires `X_BEARER_TOKEN` in `.env` (X API v2 Basic tier). Without a token, X is
  skipped — the rest keeps working. Polls every ~12s and back off on HTTP 429.

A room with **no** real targets (or with **Demo mode** checked, or env `DEMO=1`) runs
the synthetic demo feed instead. Each room carries its own config in the db, so multiple
rooms with different channel sets run side by side.

## Env vars (`.env`)

| var | meaning |
| --- | --- |
| `DATABASE_URL` | SQLite file db; leave as `file:./dev.db` |
| `DEMO` | `1` forces demo injection (the auto demo room always uses it) |
| `TWITCH_CHANNELS` | csv logins for the auto demo room |
| `KICK_CHANNELS` | csv slugs for the auto demo room |
| `KICK_CHATROOM_IDS` | optional csv chatroom ids (skip Cloudflare lookup) |
| `X_BEARER_TOKEN` | X API v2 bearer; if absent, X is skipped |
| `X_MODE` / `X_TARGET` | `replies\|mentions\|hashtag` + the target |
| `PORT` | dev server port (default 3000) |

## Unified message schema

```
{ id, source: "twitch"|"x"|"kick", channel, author, text, color, ts }
```

Source labels: `🎮 TWITCH` (#9146FF) · `𝕏 X` (#1D9BF0) · `⚡ KICK` (#53FC18).
```
