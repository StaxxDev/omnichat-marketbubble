"""
connectors.py — the three real-time source connectors for OmniChat AI.

Every connector emits the unified message schema via an async callback:

    {
      "id": str, "source": "twitch"|"x"|"kick", "channel": str,
      "author": str, "text": str, "color": str, "ts": int (epoch ms)
    }

All connectors reconnect-with-backoff and never crash the process. If a source
has no channels configured (or DEMO=1), the demo generator runs instead so the
merged, labeled, filterable feed visibly works with zero config.

Mechanics follow the shared connector spec exactly (tested):
  - Twitch: anonymous IRC over WebSocket (no API key)
  - Kick:   Pusher WebSocket (no API key), chatroom id resolved server-side
  - X:      API v2 recent-search polling with a bearer token
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import time
from typing import Awaitable, Callable, List, Optional
from urllib.parse import quote

import httpx
import websockets

# Emit callback: takes one unified message dict, returns an awaitable.
Emit = Callable[[dict], Awaitable[None]]

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)


def now_ms() -> int:
    return int(time.time() * 1000)


def _csv(name: str) -> List[str]:
    raw = os.environ.get(name, "") or ""
    return [p.strip() for p in raw.split(",") if p.strip()]


def _rid(prefix: str) -> str:
    return f"{prefix}-{now_ms()}-{random.randint(1000, 9999)}"


async def _backoff(attempt: int) -> None:
    """Exponential backoff with jitter, capped at 30s."""
    delay = min(30.0, (2 ** min(attempt, 6))) + random.uniform(0, 0.75)
    await asyncio.sleep(delay)


# --------------------------------------------------------------------------- #
# TWITCH — anonymous IRC over WebSocket (NO API KEY)
# --------------------------------------------------------------------------- #
TWITCH_WS = "wss://irc-ws.chat.twitch.tv:443"


def _parse_twitch_tags(raw_tags: str) -> dict:
    tags: dict = {}
    for kv in raw_tags.split(";"):
        if "=" in kv:
            k, v = kv.split("=", 1)
            tags[k] = v
    return tags


def parse_twitch_line(line: str) -> Optional[dict]:
    """Parse one raw IRC line into a unified message, or None if not chat."""
    if " PRIVMSG " not in line:
        return None

    tags: dict = {}
    rest = line
    if line.startswith("@"):
        tag_str, rest = line[1:].split(" ", 1)
        tags = _parse_twitch_tags(tag_str)

    # channel = substring between "PRIVMSG #" and " :"
    try:
        after = rest.split("PRIVMSG #", 1)[1]
        channel, text = after.split(" :", 1)
    except (IndexError, ValueError):
        return None

    channel = channel.strip()
    text = text.replace("\r", "").replace("\n", " ").strip()

    author = tags.get("display-name") or "?"
    if author == "?":
        # fall back to the nick in the prefix: :alice!alice@alice.tmi...
        if "!" in rest:
            author = rest.split("!", 1)[0].lstrip(":")

    color = tags.get("color", "") or ""
    msg_id = tags.get("id") or _rid(channel)

    return {
        "id": msg_id,
        "source": "twitch",
        "channel": channel,
        "author": author,
        "text": text,
        "color": color,
        "ts": now_ms(),
    }


async def twitch_connector(channels: List[str], emit: Emit) -> None:
    attempt = 0
    while True:
        try:
            async with websockets.connect(TWITCH_WS, ping_interval=None) as ws:
                attempt = 0
                nick = f"justinfan{random.randint(10000, 99999)}"
                await ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands\r\n")
                await ws.send(f"NICK {nick}\r\n")
                for ch in channels:
                    await ws.send(f"JOIN #{ch.lower()}\r\n")

                async for raw in ws:
                    if isinstance(raw, bytes):
                        raw = raw.decode("utf-8", "ignore")
                    for line in raw.split("\r\n"):
                        if not line:
                            continue
                        if line.startswith("PING"):
                            await ws.send("PONG :tmi.twitch.tv\r\n")
                            continue
                        msg = parse_twitch_line(line)
                        if msg:
                            await emit(msg)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # reconnect on any drop
            print(f"[twitch] disconnected ({e!r}); reconnecting...")
            attempt += 1
            await _backoff(attempt)


# --------------------------------------------------------------------------- #
# KICK — Pusher WebSocket (NO API KEY)
# --------------------------------------------------------------------------- #
KICK_PUSHER = (
    "wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679"
    "?protocol=7&client=js&version=8.4.0&flash=false"
)


async def resolve_kick_chatroom(slug: str) -> Optional[str]:
    url = f"https://kick.com/api/v2/channels/{slug}"
    headers = {"User-Agent": UA, "Accept": "application/json"}
    try:
        async with httpx.AsyncClient(timeout=12.0, headers=headers) as cx:
            r = await cx.get(url)
            if r.status_code == 200:
                cid = r.json().get("chatroom", {}).get("id")
                return str(cid) if cid is not None else None
            print(f"[kick] channel lookup for {slug} -> HTTP {r.status_code}")
    except Exception as e:
        print(f"[kick] channel lookup for {slug} failed: {e!r}")
    return None


def parse_kick_frame(frame: str) -> Optional[dict]:
    """Parse one Pusher frame into a unified message, or None."""
    try:
        outer = json.loads(frame)
    except (ValueError, TypeError):
        return None

    if outer.get("event") != "App\\Events\\ChatMessage":
        return None

    data = outer.get("data")
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except (ValueError, TypeError):
            return None
    if not isinstance(data, dict):
        return None

    sender = data.get("sender", {}) or {}
    identity = sender.get("identity", {}) or {}
    text = (data.get("content", "") or "").replace("\n", " ").strip()
    channel = outer.get("channel", "")
    if isinstance(channel, str) and channel.startswith("chatrooms."):
        channel = channel.split(".")[1]

    return {
        "id": str(data.get("id") or _rid("kick")),
        "source": "kick",
        "channel": str(channel),
        "author": sender.get("username", "?"),
        "text": text,
        "color": identity.get("color", "") or "",
        "ts": now_ms(),
    }


async def kick_connector(slugs: List[str], chatroom_ids: List[str], emit: Emit) -> None:
    # Build chatroom-id -> display-name map. Env override aligns to KICK_CHANNELS.
    label_for: dict = {}
    ids: List[str] = []
    for i, slug in enumerate(slugs):
        cid = chatroom_ids[i] if i < len(chatroom_ids) and chatroom_ids[i] else None
        if not cid:
            cid = await resolve_kick_chatroom(slug)
        if cid:
            ids.append(cid)
            label_for[cid] = slug
    # Any leftover override ids with no matching slug
    for cid in chatroom_ids[len(slugs):]:
        if cid:
            ids.append(cid)
            label_for.setdefault(cid, cid)

    if not ids:
        print("[kick] no chatroom ids resolved; kick connector idle")
        return

    attempt = 0
    while True:
        try:
            async with websockets.connect(KICK_PUSHER, ping_interval=None) as ws:
                attempt = 0
                async for raw in ws:
                    if isinstance(raw, bytes):
                        raw = raw.decode("utf-8", "ignore")
                    try:
                        outer = json.loads(raw)
                    except (ValueError, TypeError):
                        continue

                    ev = outer.get("event")
                    if ev == "pusher:connection_established":
                        for cid in ids:
                            await ws.send(json.dumps({
                                "event": "pusher:subscribe",
                                "data": {"auth": "", "channel": f"chatrooms.{cid}.v2"},
                            }))
                        continue
                    if ev == "pusher:ping":
                        await ws.send(json.dumps({"event": "pusher:pong", "data": {}}))
                        continue

                    msg = parse_kick_frame(raw)
                    if msg:
                        msg["channel"] = label_for.get(msg["channel"], msg["channel"])
                        await emit(msg)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"[kick] disconnected ({e!r}); reconnecting...")
            attempt += 1
            await _backoff(attempt)


# --------------------------------------------------------------------------- #
# X / TWITTER — API v2 recent-search polling (bearer token)
# --------------------------------------------------------------------------- #
X_SEARCH = "https://api.twitter.com/2/tweets/search/recent"


def build_x_query(mode: str, target: str) -> str:
    if mode == "replies":
        return f"conversation_id:{target}"
    if mode == "hashtag":
        return f"#{target} -is:retweet"
    # default: mentions
    return f"@{target} -is:retweet"


async def x_connector(token: str, mode: str, target: str, emit: Emit) -> None:
    if not token:
        print("[x] no X_BEARER_TOKEN; X connector skipped")
        return

    query = build_x_query(mode, target)
    label = f"{mode}:{target}"
    since_id: Optional[str] = None
    headers = {"Authorization": f"Bearer {token}", "User-Agent": "omnichat-ai/1.0"}
    attempt = 0

    async with httpx.AsyncClient(timeout=20.0, headers=headers) as cx:
        while True:
            try:
                params = {
                    "query": query,
                    "max_results": "100",
                    "tweet.fields": "created_at,author_id",
                    "expansions": "author_id",
                    "user.fields": "username",
                }
                if since_id:
                    params["since_id"] = since_id

                # urlencode query explicitly to be safe with operators
                qs = "&".join(
                    f"{k}={quote(str(v), safe='')}" for k, v in params.items()
                )
                r = await cx.get(f"{X_SEARCH}?{qs}")

                if r.status_code == 429:
                    print("[x] rate limited (429); backing off")
                    attempt += 1
                    await _backoff(attempt + 2)
                    continue
                if r.status_code != 200:
                    print(f"[x] HTTP {r.status_code}; retrying")
                    attempt += 1
                    await _backoff(attempt)
                    continue

                attempt = 0
                payload = r.json()
                users = {
                    u["id"]: u.get("username", "?")
                    for u in payload.get("includes", {}).get("users", [])
                }
                data = payload.get("data", []) or []
                # newest-first -> reverse to chronological
                for tw in reversed(data):
                    tid = tw["id"]
                    if since_id is None or int(tid) > int(since_id):
                        since_id = tid
                    await emit({
                        "id": tid,
                        "source": "x",
                        "channel": label,
                        "author": users.get(tw.get("author_id"), "?"),
                        "text": (tw.get("text", "") or "").replace("\n", " ").strip(),
                        "color": "",
                        "ts": now_ms(),
                    })

                await asyncio.sleep(12)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                print(f"[x] poll error ({e!r}); retrying")
                attempt += 1
                await _backoff(attempt)


# --------------------------------------------------------------------------- #
# DEMO MODE — synthetic messages from all three sources (zero config)
# --------------------------------------------------------------------------- #
_DEMO_AUTHORS = [
    "degenApe", "satoshiJr", "candleWatcher", "gmFren", "liquidatedAgain",
    "pumpItLou", "diamondHandz", "exitLiquidity", "wenLambo", "rektRadar",
    # VIPs sprinkled in so the gold ⭐ host-highlight visibly fires on camera
    "blknoiz06", "Banks", "MarketBubble",
]
_DEMO_TEXTS = [
    "ansem cooking again 🔥", "that $HYPE entry was clean", "$SOL looking strong rn",
    "wen new trade", "this chart is bullish af", "longed $BTC, lfg",
    "who else aped $ZEC", "stop loss hit ugh", "green candles only today",
    "bro called the top exactly", "GM degens ☕", "is it too late to enter $VVV",
    "leverage is a hell of a drug", "watching this $ETH level closely",
    "send it to the moon", "paper hands ngmi", "scalped 3% nice",
    "polymarket odds shifting fast", "the price is wrong on this one",
    # one obvious spam line so the AI spam-filter visibly tags something
    "🚀 FREE 5 SOL airdrop claim now at sol-giveaway[.]xyz dont miss 🚀",
]
_DEMO_COLORS = ["#FF4500", "#1E90FF", "#FFD700", "#32CD32", "#FF69B4", ""]
_DEMO_SOURCES = [
    ("twitch", "blknoiz06"),
    ("kick", "trainwreckstv"),
    ("x", "mentions:blknoiz06"),
    ("twitch", "xqc"),
    ("kick", "xqc"),
]


async def demo_connector(emit: Emit) -> None:
    print("[demo] DEMO MODE active — injecting synthetic messages")
    i = 0
    while True:
        src, channel = _DEMO_SOURCES[i % len(_DEMO_SOURCES)]
        i += 1
        await emit({
            "id": _rid("demo"),
            "source": src,
            "channel": channel,
            "author": random.choice(_DEMO_AUTHORS),
            "text": random.choice(_DEMO_TEXTS),
            "color": random.choice(_DEMO_COLORS),
            "ts": now_ms(),
        })
        await asyncio.sleep(0.8)


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #
def build_connector_tasks(emit: Emit) -> List[asyncio.Task]:
    """
    Inspect env and return the set of connector tasks to run. Falls back to
    DEMO MODE when nothing is configured or DEMO=1.
    """
    twitch_channels = _csv("TWITCH_CHANNELS")
    kick_slugs = _csv("KICK_CHANNELS")
    kick_ids = _csv("KICK_CHATROOM_IDS")
    x_token = os.environ.get("X_BEARER_TOKEN", "") or ""
    x_mode = os.environ.get("X_MODE", "mentions") or "mentions"
    x_target = os.environ.get("X_TARGET", "") or ""
    demo_forced = os.environ.get("DEMO", "") in ("1", "true", "True")

    nothing_configured = not twitch_channels and not kick_slugs and not (x_token and x_target)

    tasks: List[asyncio.Task] = []
    if demo_forced or nothing_configured:
        tasks.append(asyncio.create_task(demo_connector(emit)))
        return tasks

    if twitch_channels:
        tasks.append(asyncio.create_task(twitch_connector(twitch_channels, emit)))
    if kick_slugs or kick_ids:
        tasks.append(asyncio.create_task(kick_connector(kick_slugs, kick_ids, emit)))
    if x_token and x_target:
        tasks.append(asyncio.create_task(x_connector(x_token, x_mode, x_target, emit)))

    if not tasks:  # belt-and-suspenders
        tasks.append(asyncio.create_task(demo_connector(emit)))
    return tasks
