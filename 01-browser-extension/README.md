# OmniChat — Unified Stream Chat (Chrome MV3 Extension)

One real-time, source-labeled feed that merges **Twitch + Kick + X** chat for Ansem's
(@blknoiz06) live trading show. Built for the MarketBubble $10,000 Vibe Code Challenge.

## What it is

A Chrome **Manifest V3** extension. A background **service worker** opens all three
connectors directly — Twitch anonymous IRC over WebSocket, Kick's public Pusher
WebSocket, and X API v2 recent-search polling — normalizes every event into one unified
schema, and pushes it to a **Side Panel** that renders a merged, color-badged, filterable
live feed. No DOM scraping: it talks to the sources directly from the worker, which is far
more robust than reading a page.

## Architecture (3 sentences)

`background.js` runs the three connectors plus a demo generator, normalizes each event to
`{id, source, channel, author, text, color, ts}`, keeps a 500-message ring buffer, and
broadcasts every message over `chrome.runtime` messaging. `sidepanel.{html,js,css}`
subscribes to that bus, renders newest-at-bottom with per-source badges (🎮 TWITCH /
𝕏 X / ⚡ KICK), and offers three filter toggles plus pause-on-scroll. `options.{html,js}`
writes a single `cfg` object to `chrome.storage.local`; the worker reacts to storage
changes and reconnects with exponential backoff, healed every 30s by a keepalive alarm.

## Install + Run (Windows-friendly, zero build step)

This is plain JS/HTML/CSS — **nothing to install or compile**.

1. Open Chrome (or any Chromium browser: Edge, Brave) and go to `chrome://extensions`.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select this folder:
   `c:\Users\Josh\Music\challange\01-browser-extension`
4. Click the **OmniChat** toolbar icon (puzzle-piece menu → pin it) to open the side panel.

It starts in **Demo Mode** immediately — synthetic Twitch/Kick/X messages stream in every
~800ms so you can see the merged, labeled, filterable feed working with zero config.

## Point it at real channels

1. `chrome://extensions` → OmniChat → **Details** → **Extension options**
   (or click the ⚙ button in the side panel).
2. Fill in any of:
   - **Twitch channels** — CSV of logins, e.g. `ansemtrades,xqc` (no key needed).
   - **Kick channels** — CSV of slugs, e.g. `trainwreckstv` (no key needed). If Kick's
     Cloudflare blocks chatroom auto-resolve, paste **Chatroom IDs override** (CSV aligned
     to the channels), readable from `https://kick.com/api/v2/channels/<slug>`.
   - **X** — paste your **Bearer Token**, pick a **Mode** (`hashtag` / `mentions` /
     `replies`) and a **Target** (tag / @handle / conversation_id). Polls every ~12s and
     backs off on HTTP 429.
3. **Save** — the worker reloads connectors automatically. Untick "Force Demo Mode" if set.

Leaving every field blank (or ticking **Force Demo Mode**) keeps the synthetic feed.

## Features mapped to the brief

- ✅ Three connectors in the worker (Twitch IRC WS / Kick Pusher WS / X polling).
- ✅ Unified schema, merged feed, **clear per-message SOURCE LABELS** (emoji+label+color).
- ✅ **Multiple channels per platform** (CSV) — co-stream aggregation.
- ✅ Three **source-filter toggles** (persisted to storage).
- ✅ **Demo Mode** with zero config.
- ✅ **Reconnect with exponential backoff** + 30s keepalive self-heal; **500-message cap**
  in both the worker buffer and the DOM.
- ✅ Newest-at-bottom auto-scroll, pausable on hover/scroll-up with a "jump to new" button.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest (sidePanel + storage + alarms perms, host perms for the 4 origins) |
| `background.js` | Service worker: connectors + demo + message bus + reconnect/backoff |
| `sidepanel.html/js/css` | Merged feed UI, source badges, filter toggles, pause |
| `options.html/js` | Configure channels, X mode/target, bearer token |
| `icons/` | Toolbar icons |
| `.env.example` | Documents the shared env convention (maps to Options fields) |
