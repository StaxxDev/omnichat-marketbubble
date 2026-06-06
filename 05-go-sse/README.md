# ⚡ OmniChat Go — Unified Chat Aggregator

Twitch + X + Kick in **one real-time feed** with clear per-message **SOURCE LABELS** and
source-filter toggles. Built for Ansem's (@blknoiz06) live trading show — supports **multiple
channels per platform** (co-stream aggregation). Single Go binary, Server-Sent Events, zero
client dependencies.

## Architecture (2-3 sentences)

A goroutine per upstream source (Twitch anon IRC + Kick Pusher over `gorilla/websocket`, X via
an HTTP polling loop) normalizes everything into one unified JSON schema and pushes it onto a
central **hub** channel. The hub owns a single fan-out loop that keeps a bounded ring buffer
(cap 500) and broadcasts to every connected browser over an `/events` **SSE** stream; `/` serves
a `go:embed`-ed static HTML feed UI with source badges, author colors, and live filter toggles.
If nothing is configured (or `DEMO=1`), a demo goroutine injects synthetic crypto-stream
messages from all three sources so it visibly works out of the box.

## Run it (Windows-friendly)

Requires Go 1.21+ ([go.dev/dl](https://go.dev/dl/)). From this folder:

```powershell
go run .
```

Then open **http://localhost:8080**. With no config it starts in **DEMO MODE** immediately —
labeled, filterable messages stream in from all three sources.

Build a single binary instead:

```powershell
go build -o omnichat.exe .
.\omnichat.exe
```

## Point it at real channels

Copy `.env.example` to `.env` for reference, then set the vars in your shell. The app reads
process environment directly (no .env loader dependency), so:

```powershell
# PowerShell
$env:TWITCH_CHANNELS = "blknoiz06,xqc"
$env:KICK_CHANNELS   = "ansem,trainwreckstv"
$env:X_BEARER_TOKEN  = "<your X API v2 bearer>"
$env:X_MODE          = "mentions"   # replies | mentions | hashtag
$env:X_TARGET        = "blknoiz06"
go run .
```

```bat
:: cmd.exe
set TWITCH_CHANNELS=blknoiz06,xqc
set KICK_CHANNELS=ansem
go run .
```

- **Twitch** — anonymous IRC over WebSocket, no API key. Just list channel logins (lowercase) in
  `TWITCH_CHANNELS`.
- **Kick** — Pusher WebSocket, no API key. List slugs in `KICK_CHANNELS`. Kick sits behind
  Cloudflare; the server sends a browser User-Agent to resolve chatroom ids. If that 403s, set
  `KICK_CHATROOM_IDS` (CSV aligned to `KICK_CHANNELS`) to bypass resolution.
- **X / Twitter** — no live chat exists, so it **polls** the v2 recent-search API every ~12s and
  streams new tweets. Needs `X_BEARER_TOKEN`. Choose `X_MODE` (`replies`/`mentions`/`hashtag`)
  and `X_TARGET`. 429s back off automatically; missing token simply disables X (no crash).

## Source filters

Three header toggles (🎮 TWITCH · 𝕏 X · ⚡ KICK) instantly show/hide each source client-side.

## Env vars

| Var | Meaning |
|---|---|
| `TWITCH_CHANNELS` | CSV of Twitch logins |
| `KICK_CHANNELS` | CSV of Kick slugs |
| `KICK_CHATROOM_IDS` | optional CSV chatroom-id overrides (aligned to slugs) |
| `X_BEARER_TOKEN` | X API v2 bearer token |
| `X_MODE` | `replies` \| `mentions` \| `hashtag` |
| `X_TARGET` | conversation id / handle / tag |
| `PORT` | HTTP port (default 8080) |
| `MAX_MESSAGES` | hub history cap (default 500) |
| `DEMO` | `1` to force demo mode |

## Resilience

Each socket connector reconnects with exponential backoff (1s → 30s cap). The hub never blocks
a connector (drops to slow clients instead) and caps retained messages both server-side and in
the browser to bound memory.
