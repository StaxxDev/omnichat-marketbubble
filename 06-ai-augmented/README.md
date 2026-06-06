# OmniChat AI ⚡🤖

**Unified Twitch + X + Kick chat aggregator** in one real-time, source-labeled
feed — with an optional Claude AI layer for per-message spam/toxicity flags,
sentiment emoji, and a rolling "what is chat talking about" banner.

Built for the MarketBubble $10,000 Vibe Code Challenge (Ansem's live trading show).

## Architecture (2-3 sentences)

A **FastAPI** app runs the three source connectors as `asyncio` tasks
(`websockets` for Twitch anon-IRC and Kick Pusher, `httpx` polling for X API v2),
normalizes every message to one unified schema, and fans it out to every browser
over a single `/ws` WebSocket. An optional **Claude** layer (`claude-haiku-4-5`,
via the Anthropic Messages API) enriches each message with a `spam`/`toxic` flag +
sentiment emoji and refreshes a rolling chat-summary banner every ~15s. **The AI
degrades gracefully**: if `ANTHROPIC_API_KEY` is not set, the AI layer is skipped
and the app runs as a plain real-time aggregator.

## Features

- **Three live connectors** — Twitch (anonymous IRC over WebSocket, no key), Kick
  (Pusher WebSocket, no key), X (API v2 recent-search polling, bearer token).
- **Clear per-message SOURCE LABELS** — 🎮 TWITCH (purple) · 𝕏 X (white) · ⚡ KICK (green).
- **Multiple channels per platform** via CSV env vars.
- **Source-filter toggles** — three buttons show/hide each source instantly.
- **DEMO MODE** — zero config: with no channels set (or `DEMO=1`) synthetic
  crypto-stream chatter from all three sources streams in so the labeled,
  filterable feed visibly works instantly.
- **AI layer** — per-message moderation flag + sentiment emoji, plus a top banner
  summarizing what chat is talking about. Skipped cleanly when no API key.
- **Robust** — reconnect-with-backoff on every socket (server + browser), retained
  messages capped at 500, X 429s backed off, Kick CF blocks fall back to
  `KICK_CHATROOM_IDS`.

## Install & run (Windows-friendly)

```powershell
cd 06-ai-augmented
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn main:app --port 8787
```

(macOS/Linux: `source .venv/bin/activate` instead of the Activate.ps1 line.)

Then open **http://localhost:8787** — it works immediately in DEMO MODE with no
config. To enable AI, set `ANTHROPIC_API_KEY` (see below) before launching.

## Point it at real channels

Copy `.env.example` to `.env` and fill in what you want (everything is optional):

```ini
TWITCH_CHANNELS=blknoiz06,xqc        # channel logins, no '#'
KICK_CHANNELS=trainwreckstv,xqc      # channel slugs
X_BEARER_TOKEN=AAAA...               # X API v2 Basic-tier bearer
X_MODE=mentions                      # replies | mentions | hashtag
X_TARGET=blknoiz06                   # conversation id / handle / tag
ANTHROPIC_API_KEY=sk-ant-...         # optional — enables the AI layer
PORT=8787
```

`main.py` also auto-loads the shared `../.env` at the challenge root, so the
provided tokens/channels there are picked up automatically.

- **Kick behind Cloudflare?** If the chatroom-id lookup 403s, set
  `KICK_CHATROOM_IDS=` to a comma list aligned positionally to `KICK_CHANNELS`.
- **Force demo** even with channels configured: `DEMO=1`.

## Files

- `main.py` — FastAPI app, `/ws` fan-out, AI enrichment hook, summary loop, demo fallback.
- `connectors.py` — the three connectors + demo generator (unified-schema emit).
- `ai.py` — Claude layer (classify + summarize) with graceful degradation.
- `static/index.html` — single-page feed UI: source badges, filter toggles, AI banner.
- `requirements.txt`, `.env.example`.

## Health check

`GET /health` → `{"ok": true, "ai": <bool>, "clients": N, "retained": N}`.
