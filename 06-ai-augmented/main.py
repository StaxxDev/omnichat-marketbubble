"""
main.py — OmniChat AI: unified Twitch + X + Kick chat aggregator with a Claude layer.

Architecture (2-3 sentences):
  A FastAPI app runs the three source connectors as asyncio tasks (websockets for
  Twitch/Kick, httpx polling for X), normalizes every message to one schema, and
  fans it out to all connected browsers over a single /ws WebSocket. An optional
  Claude (claude-haiku-4-5) layer enriches each message with a spam/toxicity flag
  + sentiment emoji and refreshes a rolling "what is chat talking about" banner
  every ~15s; if no ANTHROPIC_API_KEY is set, the AI layer is skipped and the app
  runs as a plain real-time aggregator.

Run:  pip install -r requirements.txt  &&  uvicorn main:app --port 8787
"""

from __future__ import annotations

import asyncio
import json
import os
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Deque, Set

import base64

import httpx
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

try:
    from dotenv import load_dotenv
    # Load this folder's .env, then the shared challenge .env one level up.
    load_dotenv(Path(__file__).parent / ".env")
    load_dotenv(Path(__file__).parent.parent / ".env")
except Exception:
    pass

import ai
import memory
from datetime import datetime, timezone
from connectors import build_connector_tasks

MAX_RETAINED = 500           # cap retained messages to bound memory
SUMMARY_INTERVAL = 15        # seconds between rolling-summary refreshes
STATS_INTERVAL = 6           # seconds between contributor-leaderboard pushes

# Shared state
_clients: Set[WebSocket] = set()
_history: Deque[dict] = deque(maxlen=MAX_RETAINED)
_summary: dict = {"text": "", "ai": ai.ai_enabled()}
_loop_tasks: list = []

# Per-user "meaningful contribution" stats. score = standouts*3 + messages.
# Standouts (AI-judged high-signal posts) are weighted heavily so quality > spammy volume.
_stats: dict = {}  # author -> {"msgs", "standouts", "source"}
_bot_counts: dict = {}  # author -> bot-flagged message count (this session)


def _bump_stats(author: str, source: str) -> None:
    if not author:
        return
    s = _stats.setdefault(author, {"msgs": 0, "standouts": 0, "source": source})
    s["msgs"] += 1
    s["source"] = source


def _bump_standout(author: str) -> None:
    if author and author in _stats:
        _stats[author]["standouts"] += 1


def _top_contributors(n: int = 8) -> list:
    rows = [
        {"author": a, "source": v["source"], "msgs": v["msgs"],
         "standouts": v["standouts"], "score": v["standouts"] * 3 + v["msgs"]}
        for a, v in _stats.items()
    ]
    rows.sort(key=lambda r: (r["standouts"], r["score"]), reverse=True)
    return rows[:n]


def _session_user_rows() -> list:
    """All this-session participants (incl. bots) for committing to persistent memory."""
    rows = {}
    for a, v in _stats.items():
        rows[a] = {"author": a, "source": v["source"], "msgs": v["msgs"],
                   "standouts": v["standouts"], "score": v["standouts"] * 3 + v["msgs"], "bots": 0}
    for a, cnt in _bot_counts.items():
        r = rows.setdefault(a, {"author": a, "source": "", "msgs": 0, "standouts": 0, "score": 0, "bots": 0})
        r["bots"] += cnt
    return list(rows.values())


# --- Bot / raid detection (behavioral, synchronous — flags on screen) ------ #
import re as _re

_BOT_NAME_RE = _re.compile(r"(^user\d+$|\d{6,}$|^[a-z]+\d{4,}$)", _re.I)
# Hosts/VIPs are never bots (configurable for the show).
_VIP_AUTHORS = {"blknoiz06", "banks", "ansem", "marketbubble"}
# Recency window: a "raid" is a burst of the SAME line, not a phrase that recurs all night.
_recent_norm: Deque[str] = deque(maxlen=30)


def _norm_text(t: str) -> str:
    return _re.sub(r"\s+", " ", (t or "").strip().lower())


def _bot_check(author: str, text: str) -> bool:
    """Flag likely bots: bot-style handles, or the same line repeated in a short burst (raid)."""
    a = (author or "").lower().lstrip("@")
    if a in _VIP_AUTHORS:                # hosts/VIPs are never flagged
        return False
    if author and _BOT_NAME_RE.search(author):  # bot-style handle (user1337, name123456)
        return True
    n = _norm_text(text)
    if not n:
        return False
    burst = _recent_norm.count(n)        # times this exact line appeared in the last 30 msgs
    _recent_norm.append(n)
    return burst >= 4                    # 5th identical line in the window -> raid/bot


async def _broadcast(payload: dict) -> None:
    """Send a JSON payload to every connected browser; drop dead sockets."""
    if not _clients:
        return
    dead = []
    data = json.dumps(payload)
    for ws in list(_clients):
        try:
            await ws.send_text(data)
        except Exception:
            dead.append(ws)
    for ws in dead:
        _clients.discard(ws)


async def _enrich_async(msg: dict) -> None:
    """Classify a message with Claude AFTER it's already on screen, then patch it."""
    enrich = await ai.classify_message(msg.get("text", ""))
    if not enrich:
        return
    msg["flag"] = enrich.get("flag", "ok")
    msg["sentiment"] = enrich.get("sentiment", "")
    msg["standout"] = bool(enrich.get("standout"))
    if msg["standout"]:
        _bump_standout(msg.get("author", ""))
    # Patch the in-history copy so late joiners get the enriched version too.
    await _broadcast({"type": "patch", "data": {
        "id": msg.get("id"),
        "flag": msg.get("flag", "ok"),
        "sentiment": msg.get("sentiment", ""),
        "standout": msg["standout"],
    }})


async def _enrich_and_emit(msg: dict) -> None:
    """
    Called by every connector for each new unified message. Broadcasts the
    message IMMEDIATELY (the feed never waits on the AI), then enriches in the
    background and patches the row in place. If AI is off, it's just a plain feed.
    """
    msg["bot"] = _bot_check(msg.get("author", ""), msg.get("text", ""))
    _history.append(msg)
    if msg["bot"]:
        a = msg.get("author", "")
        if a:
            _bot_counts[a] = _bot_counts.get(a, 0) + 1
    else:                # bots don't earn contribution credit
        _bump_stats(msg.get("author", ""), msg.get("source", ""))
    await _broadcast({"type": "message", "data": msg})
    if ai.ai_enabled():
        asyncio.create_task(_enrich_async(msg))


async def _stats_loop() -> None:
    """Push the live 'meaningful contribution' leaderboard every few seconds."""
    while True:
        await asyncio.sleep(STATS_INTERVAL)
        try:
            await _broadcast({"type": "stats", "data": {"top": _top_contributors()}})
        except Exception as e:
            print(f"[stats] loop error ({e!r})")


async def _summary_loop() -> None:
    """Refresh the rolling 'what is chat talking about' banner every ~15s."""
    if not ai.ai_enabled():
        return
    while True:
        await asyncio.sleep(SUMMARY_INTERVAL)
        try:
            text = await ai.summarize_chat(list(_history))
            if text:
                _summary["text"] = text
                await _broadcast({"type": "summary", "data": _summary})
        except Exception as e:
            print(f"[summary] loop error ({e!r})")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Start connectors + summary loop on startup
    memory.init()
    _loop_tasks.extend(build_connector_tasks(_enrich_and_emit))
    _loop_tasks.append(asyncio.create_task(_summary_loop()))
    _loop_tasks.append(asyncio.create_task(_stats_loop()))
    print(f"[omnichat] started — AI {'ON' if ai.ai_enabled() else 'OFF (plain mode)'}")
    try:
        yield
    finally:
        for t in _loop_tasks:
            t.cancel()


app = FastAPI(title="OmniChat AI", lifespan=lifespan)

STATIC_DIR = Path(__file__).parent / "static"


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/recap")
async def recap(commit: int = 1):
    """
    End-of-stream host debrief, CONDITIONED on memory from prior shows, then COMMITTED
    to the co-pilot's persistent memory so it shapes future analysis.
    """
    mem_ctx = memory.recall_context()
    data = await ai.host_recap(list(_history), _top_contributors(), mem_ctx)
    data["messages"] = len(_history)
    data["recalled"] = bool(mem_ctx)
    if commit:
        ts = datetime.now(timezone.utc).isoformat(timespec="seconds")
        data["committed"] = memory.commit_recap(data, _session_user_rows(), len(_history), ts)
    data["memory"] = memory.get_memory()
    return JSONResponse(data)


@app.get("/memory")
async def memory_view():
    """The co-pilot's accumulated cross-show memory: lessons + persistent user reputation."""
    return JSONResponse(memory.get_memory())


@app.get("/agent")
async def agent(q: str = ""):
    """Ask the hosts' co-pilot a question, answered from cross-show memory + live chat."""
    answer = await ai.ask_agent(q, memory.recall_context(), list(_history))
    return JSONResponse({"q": q, "answer": answer, "mode": ai.ai_mode()})


@app.post("/share/telegram")
async def share_telegram(request: Request):
    """
    Send the recap to Telegram. Body: {target?, caption, image?(data-url png)}.
    Bot token from env TG_BOT_TOKEN / TELEGRAM_BOT_TOKEN; target = chat id / @channel
    (falls back to TG_CHAT_ID env). Sends a photo (the recap card) if image given, else text.
    """
    payload = await request.json()
    token = os.environ.get("TG_BOT_TOKEN") or os.environ.get("TELEGRAM_BOT_TOKEN")
    chat = (payload.get("target") or "").strip() or os.environ.get("TG_CHAT_ID") \
        or os.environ.get("TELEGRAM_CHAT_ID")
    if not token:
        return JSONResponse({"ok": False, "error": "No TG_BOT_TOKEN set in .env"}, status_code=400)
    if not chat:
        return JSONResponse({"ok": False, "error": "No target chat — enter a chat id / @channel"}, status_code=400)
    caption = (payload.get("caption") or "")[:1000]
    img = payload.get("image") or ""
    try:
        async with httpx.AsyncClient(timeout=25) as cl:
            if img.startswith("data:image"):
                raw = base64.b64decode(img.split(",", 1)[1])
                r = await cl.post(
                    f"https://api.telegram.org/bot{token}/sendPhoto",
                    data={"chat_id": chat, "caption": caption},
                    files={"photo": ("recap.png", raw, "image/png")},
                )
            else:
                r = await cl.post(
                    f"https://api.telegram.org/bot{token}/sendMessage",
                    json={"chat_id": chat, "text": caption, "disable_web_page_preview": True},
                )
        j = r.json()
        return JSONResponse({"ok": bool(j.get("ok")), "error": None if j.get("ok") else j.get("description")})
    except Exception as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=500)


@app.get("/health")
async def health():
    return JSONResponse({
        "ok": True,
        "ai": ai.ai_enabled(),
        "clients": len(_clients),
        "retained": len(_history),
    })


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    _clients.add(ws)
    # Send current AI status + summary, then replay retained history so a new
    # tab is immediately populated.
    try:
        await ws.send_text(json.dumps({
            "type": "hello",
            "data": {"ai": ai.ai_enabled(), "mode": ai.ai_mode(),
                     "summary": _summary.get("text", "")},
        }))
        for m in list(_history):
            await ws.send_text(json.dumps({"type": "message", "data": m}))
        await ws.send_text(json.dumps({"type": "stats", "data": {"top": _top_contributors()}}))
        while True:
            # We don't need client messages; keep the socket alive.
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        _clients.discard(ws)


# Serve /static/* assets (index.html references none externally, but handy)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8787"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False)
