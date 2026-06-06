# OmniChat Overlay — Twitch + X + Kick in one OBS Browser Source

A **transparent OBS Browser-Source overlay** that merges live chat from **Twitch**,
**Kick**, and **X** into one labeled, source-filtered feed that floats over your
stream video. Designed for Ansem's (@blknoiz06) live trading show — multi-channel
per platform, clear per-message **SOURCE BADGES**, smooth slide-in, auto-fade.

## Architecture (2-3 sentences)

`overlay.html` + `overlay.js` is a single static page that connects **directly from
the browser** to **Twitch IRC over WebSocket** (anonymous, no key) and **Kick chat
over Pusher WebSocket** (public app key, no key) — both allow browser WebSockets.
For **X** (which has no live chat) a tiny optional zero-dependency Node helper
`x-proxy.js` holds the bearer token, polls X API v2 recent-search every ~12s, and
exposes `GET /x?since=...` returning new tweets as unified JSON the page polls; the
proxy also resolves Kick chatroom ids (Cloudflare-friendly) and can serve the static
page so OBS has one same-origin URL. If the proxy/token is absent the overlay still
runs Twitch + Kick (+ demo) — every message is normalized to one schema and rendered
with a colored source badge.

## Run it instantly (zero config, Windows-friendly)

No install, no Node, no keys — just open the file with demo data:

```
# from this folder (04-obs-overlay)
start overlay.html?demo=1&ui=1
```

`?demo=1` injects synthetic crypto-stream messages from all three sources every
~800ms. `?ui=1` shows the filter toolbar (Twitch / X / Kick toggles + status).
Over a dark background you'll see the transparent overlay, badges, and animations.

## Run with real Twitch + Kick (still no Node, no keys)

Open the page directly with channels in the URL:

```
start "overlay.html?twitch=ansem,hasanabi&kick=trainwreckstv&kickid_trainwreckstv=1689&ui=1"
```

- `twitch=` connects anonymously to Twitch IRC immediately (no key, no proxy).
- `kick=` needs each slug's **chatroom id**. Browsers can't reliably hit Kick's
  Cloudflare-protected API, so either pass it inline as
  `kickid_<slug>=<id>` (or a single `kickid=<id>`), **or** run the proxy below which
  resolves ids server-side.

## Run the full stack incl. X (one same-origin URL for OBS)

Requires Node 16+ (`node --version`). The proxy is **zero npm dependencies**.

```
# Windows PowerShell / cmd, from this folder:
copy .env.example .env
notepad .env            # paste X_BEARER_TOKEN, set X_MODE + X_TARGET
node x-proxy.js
```

Then your overlay URL (served by the proxy, same origin so X polling + Kick id
lookup just work):

```
http://localhost:8787/overlay.html?twitch=ansem&kick=trainwreckstv&x=1&max=25
```

- `x=1` -> poll the proxy at the same origin for the X feed.
- `x=http://host:port` -> point at a proxy on another origin.
- The proxy also resolves Kick ids automatically, so you can drop `kickid_*`.

## Add as a Browser Source in OBS

1. In OBS: **Sources -> + -> Browser**.
2. **URL**:
   - Demo:        `file:///C:/.../04-obs-overlay/overlay.html?demo=1`
   - Real (proxy):`http://localhost:8787/overlay.html?twitch=ansem&kick=trainwreckstv&x=1`
3. Set **Width** 600, **Height** 1080 (or match your scene). Leave the page CSS
   transparent — do **not** add a custom background.
4. Tick **"Shutdown source when not visible"** off if you want it always live.
5. Position it; messages slide in at the bottom and auto-fade. (No `?ui=1` for the
   clean broadcast look — the toolbar is hidden by default.)

## URL parameters

| Param        | Example                         | Meaning |
|--------------|---------------------------------|---------|
| `twitch`     | `twitch=ansem,hasanabi`         | CSV of Twitch channel logins (multiple supported) |
| `kick`       | `kick=trainwreckstv,xqc`        | CSV of Kick slugs (multiple supported) |
| `kickid_<slug>` | `kickid_xqc=668`             | Inline chatroom id when not using the proxy |
| `x`          | `x=1` or `x=http://host:8787`   | Enable X polling via proxy (origin or explicit) |
| `max`        | `max=20`                        | Max retained/visible messages (cap, default 20) |
| `demo`       | `demo=1`                        | Demo mode — synthetic 3-source feed |
| `ui`         | `ui=1`                          | Show filter toolbar + connection status |
| `fade`       | `fade=0`                        | Disable auto-fade of old messages |
| `fadems`     | `fadems=30000`                  | Auto-fade delay in ms (default 45000) |

If **no** channels/targets are given (and no `demo=1`), the overlay auto-enables
**demo mode** so it's never blank.

## Source filter toggles

With `?ui=1`, three buttons (🎮 TWITCH / 𝕏 X / ⚡ KICK) show/hide each source live.
Useful for the desktop preview; hide the toolbar for the actual broadcast.

## Unified message schema (every source normalizes to this)

```
{ id, source: "twitch"|"x"|"kick", channel, author, text, color, ts }
```

## Reliability

- **Reconnect with exponential backoff** (1s -> 30s cap) on Twitch IRC and Kick
  Pusher socket drops; X polling backs off on HTTP 429.
- **Capped retained messages** (`max`, default 20) bound DOM/memory; the de-dupe
  map is also bounded.
- Twitch `PING`/Kick `pusher:ping` keepalives are answered automatically.

## Files

- `overlay.html` — transparent page + styling (badges, slide-in, outline text).
- `overlay.js` — all three connectors, schema merge, filters, demo mode.
- `x-proxy.js` — optional Node helper: X polling, Kick id resolver, static serving.
- `.env.example` — copy to `.env` for the X proxy.
