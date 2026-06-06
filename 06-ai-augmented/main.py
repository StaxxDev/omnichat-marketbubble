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

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
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
from connectors import build_connector_tasks

MAX_RETAINED = 500           # cap retained messages to bound memory
SUMMARY_INTERVAL = 15        # seconds between rolling-summary refreshes

# Shared state
_clients: Set[WebSocket] = set()
_history: Deque[dict] = deque(maxlen=MAX_RETAINED)
_summary: dict = {"text": "", "ai": ai.ai_enabled()}
_loop_tasks: list = []


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
    # Patch the in-history copy so late joiners get the enriched version too.
    await _broadcast({"type": "patch", "data": {
        "id": msg.get("id"),
        "flag": msg.get("flag", "ok"),
        "sentiment": msg.get("sentiment", ""),
    }})


async def _enrich_and_emit(msg: dict) -> None:
    """
    Called by every connector for each new unified message. Broadcasts the
    message IMMEDIATELY (the feed never waits on the AI), then enriches in the
    background and patches the row in place. If AI is off, it's just a plain feed.
    """
    _history.append(msg)
    await _broadcast({"type": "message", "data": msg})
    if ai.ai_enabled():
        asyncio.create_task(_enrich_async(msg))


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
    _loop_tasks.extend(build_connector_tasks(_enrich_and_emit))
    _loop_tasks.append(asyncio.create_task(_summary_loop()))
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
