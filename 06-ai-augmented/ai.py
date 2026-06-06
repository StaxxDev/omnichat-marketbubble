"""
ai.py — the optional Claude AI layer for OmniChat AI.

Two jobs, both DEGRADE GRACEFULLY: if ANTHROPIC_API_KEY is unset (or the SDK
isn't installed), AI is disabled and the app runs as a plain aggregator.

  1) classify_message(msg)  -> per-message {flag, sentiment} enrichment
        flag      : "ok" | "spam" | "toxic"
        sentiment : a single emoji capturing the vibe
     Uses Claude's structured-output (output_config.format) so the result is a
     guaranteed-shape JSON object — no brittle text parsing.

  2) summarize_chat(recent) -> a one-line "what is chat talking about" banner,
     refreshed on a timer by the server (~every 15s).

Model: claude-haiku-4-5-20251001 (fast + cheap, ideal for per-message calls).
Uses the current Anthropic Messages API via the official async SDK.
"""

from __future__ import annotations

import json
import os
from typing import List, Optional

MODEL = "claude-haiku-4-5-20251001"

# --- Graceful import + key detection ------------------------------------- #
# Design: Claude is the PRIMARY brain. If there's no key, the SDK is missing, or
# the key has no credits / errors out, we fall back to a fast local HEURISTIC so
# the AI layer NEVER goes dark (spam tags, sentiment, and a live summary still
# work — zero cost, zero latency). A circuit breaker stops hammering a dead key.
_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "") or ""
import time as _time

_client = None
_claude_ok = False            # is the Claude path currently usable?
_claude_fails = 0             # consecutive failures (circuit breaker)
_claude_retry_at = 0.0        # monotonic time after which we re-probe Claude
_CLAUDE_FAIL_LIMIT = 3
_CLAUDE_REARM_SECS = 60       # after tripping, re-try Claude this often (top-up recovery)

try:
    if _API_KEY:
        import anthropic  # type: ignore

        _client = anthropic.AsyncAnthropic(api_key=_API_KEY)
        _claude_ok = True
except Exception as e:  # SDK missing or init failed -> heuristic only
    print(f"[ai] Claude SDK unavailable ({e!r}); using heuristic AI")
    _client = None
    _claude_ok = False

if _claude_ok:
    print("[ai] Claude layer ready (claude-haiku-4-5) — heuristic fallback armed")
else:
    print("[ai] No Claude key — running on the local heuristic AI layer")


def ai_enabled() -> bool:
    # The AI layer is ALWAYS on — Claude when available, heuristic otherwise.
    return True


def ai_mode() -> str:
    return "claude" if _claude_use() else "heuristic"


def _claude_use() -> bool:
    """Claude usable now? Re-arms ~every 60s after a trip so a mid-run top-up recovers."""
    global _claude_ok, _claude_fails
    if _claude_ok:
        return True
    if _client and _claude_retry_at and _time.monotonic() >= _claude_retry_at:
        _claude_ok = True       # give it another shot
        _claude_fails = 0
        print("[ai] re-probing Claude (credit top-up?)")
        return True
    return False


def _trip_breaker(e: Exception) -> None:
    """Count Claude failures; after a few (e.g. no-credit key), back off to heuristic."""
    global _claude_fails, _claude_ok, _claude_retry_at
    _claude_fails += 1
    if _claude_fails >= _CLAUDE_FAIL_LIMIT and _claude_ok:
        _claude_ok = False
        _claude_retry_at = _time.monotonic() + _CLAUDE_REARM_SECS
        print(f"[ai] Claude paused after {_claude_fails} failures "
              f"({type(e).__name__}); heuristic AI for now, re-probe in {_CLAUDE_REARM_SECS}s")


# --- Local heuristic AI (no API needed) ---------------------------------- #
import re as _re

_SPAM_RE = _re.compile(
    r"(airdrop|free\s*\d|giveaway|claim\s*now|claim\s*your|t\.me/|discord\.gg/|"
    r"\[\.\]|bit\.ly|tinyurl|dm\s*me|join\s*now|first\s*\d+\s*people|"
    r"connect\s*wallet|x\d+\s*(sol|eth|btc))",
    _re.I,
)
_TOXIC_RE = _re.compile(r"\b(kys|retard|faggot|nigger|idiot scum)\b", _re.I)
_BULL_RE = _re.compile(r"(bull|moon|lfg|pump|long|green|🔥|🚀|send it|breakout|ath|up only|cooking)", _re.I)
_BEAR_RE = _re.compile(r"(bear|dump|rug|rekt|short|red|📉|stop\s*loss|ngmi|paper hands|crash|liquidat)", _re.I)


def _heuristic_classify(text: str) -> dict:
    t = text or ""
    if _TOXIC_RE.search(t):
        return {"flag": "toxic", "sentiment": "🤬"}
    if _SPAM_RE.search(t):
        return {"flag": "spam", "sentiment": "🚩"}
    bull, bear = bool(_BULL_RE.search(t)), bool(_BEAR_RE.search(t))
    if bull and not bear:
        senti = "🚀"
    elif bear and not bull:
        senti = "📉"
    elif "gm" in t.lower() or "☕" in t:
        senti = "😄"
    else:
        senti = "💬"
    return {"flag": "ok", "sentiment": senti}


_CASHTAG_RE = _re.compile(r"\$[A-Za-z]{2,10}\b")


def _heuristic_summary(recent: List[dict]) -> Optional[str]:
    if not recent:
        return None
    tickers, bull, bear = {}, 0, 0
    for m in recent[-80:]:
        txt = m.get("text", "") or ""
        for tag in _CASHTAG_RE.findall(txt):
            tickers[tag.upper()] = tickers.get(tag.upper(), 0) + 1
        if _BULL_RE.search(txt):
            bull += 1
        if _BEAR_RE.search(txt):
            bear += 1
    top = sorted(tickers, key=tickers.get, reverse=True)[:3]
    mood = "leaning bullish 🚀" if bull > bear else "leaning bearish 📉" if bear > bull else "mixed vibes 🤔"
    if top:
        return f"Chat is buzzing about {', '.join(top)} — {mood}"
    return f"Chat is active across Twitch / X / Kick — {mood}"


# --- Per-message classification ------------------------------------------ #
_CLASSIFY_SCHEMA = {
    "type": "object",
    "properties": {
        "flag": {"type": "string", "enum": ["ok", "spam", "toxic"]},
        "sentiment": {"type": "string"},
    },
    "required": ["flag", "sentiment"],
    "additionalProperties": False,
}


def _extract_json(s: str) -> Optional[dict]:
    """Pull the first JSON object out of a model reply (tolerates ```json fences)."""
    if not s:
        return None
    s = s.strip()
    if s.startswith("```"):
        s = s.strip("`")
        # drop a leading "json" language tag if present
        nl = s.find("{")
        if nl != -1:
            s = s[nl:]
    start, end = s.find("{"), s.rfind("}")
    if start == -1 or end == -1 or end < start:
        return None
    try:
        return json.loads(s[start : end + 1])
    except Exception:
        return None


async def classify_message(text: str) -> Optional[dict]:
    """
    Return {"flag": ..., "sentiment": emoji} or None if AI is off/failed.

    Uses a compact JSON-in-the-prompt contract (works on every SDK version, no
    structured-output beta needed) — Haiku reliably returns a tiny JSON object.
    """
    if not text:
        return None
    # Claude path (primary) with circuit breaker; heuristic fallback always wins last.
    if _claude_use() and _client:
        try:
            resp = await _client.messages.create(
                model=MODEL,
                max_tokens=40,
                system=(
                    "You moderate live-stream chat for a crypto trading show (Market Bubble). "
                    "Classify ONE chat message. Reply with ONLY a compact JSON object, no prose, "
                    "no markdown fences. Shape: {\"flag\":\"ok|spam|toxic\",\"sentiment\":\"<one emoji>\"}. "
                    "flag='spam' for scams/link-spam/repetitive coin shilling, 'toxic' for harassment/slurs/hate, "
                    "'ok' otherwise. sentiment = a single emoji capturing the vibe."
                ),
                messages=[{"role": "user", "content": text[:500]}],
            )
            out = next((b.text for b in resp.content if b.type == "text"), "")
            data = _extract_json(out)
            if data:
                flag = data.get("flag", "ok")
                if flag not in ("ok", "spam", "toxic"):
                    flag = "ok"
                return {"flag": flag, "sentiment": (data.get("sentiment") or "").strip()[:4]}
        except Exception as e:
            _trip_breaker(e)
    return _heuristic_classify(text)


# --- Rolling chat summary ------------------------------------------------- #
async def summarize_chat(recent: List[dict]) -> Optional[str]:
    """
    One-line summary of what chat is talking about across all sources.
    `recent` is a list of unified message dicts. Returns None if AI is off.
    """
    if not recent:
        return None
    if _claude_use() and _client:
        try:
            lines = [
                f"[{m.get('source', '?').upper()}] {m.get('author', '?')}: {m.get('text', '')}"
                for m in recent[-60:]
            ]
            transcript = "\n".join(lines)[:6000]
            resp = await _client.messages.create(
                model=MODEL,
                max_tokens=80,
                system=(
                    "You summarize live multi-platform stream chat (Twitch, X, Kick) "
                    "for a crypto trading show. In ONE short sentence (max ~15 words), "
                    "say what chat is talking about right now. No preamble, no quotes."
                ),
                messages=[{"role": "user", "content": transcript}],
            )
            text = next((b.text for b in resp.content if b.type == "text"), "")
            if text.strip():
                return text.strip().replace("\n", " ")
        except Exception as e:
            _trip_breaker(e)
    return _heuristic_summary(recent)
