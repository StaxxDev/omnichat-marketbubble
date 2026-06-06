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


_SIGNAL_RE = _re.compile(
    r"(because|i think|imo|expect|target|support|resistance|thesis|liquidity|"
    r"breakout|accumulat|divergence|catalyst|why\b|how\b|\?$|funding|macro|"
    r"entry at|stop at|risk[/ ]reward|r:r)",
    _re.I,
)


def _heuristic_standout(t: str, flag: str) -> bool:
    """A message is 'standout' if it carries real signal: a reasoned take, a level/target, or a real question."""
    if flag != "ok":
        return False
    has_cashtag = bool(_CASHTAG_RE.search(t))
    has_signal = bool(_SIGNAL_RE.search(t))
    # substance heuristic: signal language, or a cashtag paired with a longer thought
    return has_signal or (has_cashtag and len(t) >= 22)


def _heuristic_classify(text: str) -> dict:
    t = text or ""
    if _TOXIC_RE.search(t):
        return {"flag": "toxic", "sentiment": "🤬", "standout": False}
    if _SPAM_RE.search(t):
        return {"flag": "spam", "sentiment": "🚩", "standout": False}
    bull, bear = bool(_BULL_RE.search(t)), bool(_BEAR_RE.search(t))
    if bull and not bear:
        senti = "🚀"
    elif bear and not bull:
        senti = "📉"
    elif "gm" in t.lower() or "☕" in t:
        senti = "😄"
    else:
        senti = "💬"
    return {"flag": "ok", "sentiment": senti, "standout": _heuristic_standout(t, "ok")}


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
                max_tokens=60,
                system=(
                    "You moderate live-stream chat for a crypto trading show (Market Bubble). "
                    "Classify ONE chat message. Reply with ONLY a compact JSON object, no prose, "
                    "no markdown fences. Shape: "
                    "{\"flag\":\"ok|spam|toxic\",\"sentiment\":\"<one emoji>\",\"standout\":true|false}. "
                    "flag='spam' for scams/link-spam/repetitive coin shilling, 'toxic' for harassment/slurs/hate, "
                    "'ok' otherwise. sentiment = a single emoji capturing the vibe. "
                    "standout=true ONLY for genuinely high-signal messages a host would want to read aloud: "
                    "a sharp market take with reasoning, real alpha, a specific level/target, or a thoughtful "
                    "question. standout=false for filler, hype, emotes, spam, or toxic."
                ),
                messages=[{"role": "user", "content": text[:500]}],
            )
            out = next((b.text for b in resp.content if b.type == "text"), "")
            data = _extract_json(out)
            if data:
                flag = data.get("flag", "ok")
                if flag not in ("ok", "spam", "toxic"):
                    flag = "ok"
                standout = bool(data.get("standout")) and flag == "ok"
                return {"flag": flag, "sentiment": (data.get("sentiment") or "").strip()[:4],
                        "standout": standout}
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


# --- End-of-stream host recap -------------------------------------------- #
_QUESTION_RE = _re.compile(r"\?\s*$")


def _heuristic_recap(recent: List[dict], top: list) -> dict:
    tickers = {}
    questions = []
    for m in recent:
        txt = (m.get("text") or "").strip()
        for tag in _CASHTAG_RE.findall(txt):
            tickers[tag.upper()] = tickers.get(tag.upper(), 0) + 1
        if _QUESTION_RE.search(txt) and len(txt) > 12 and len(questions) < 6:
            questions.append(f'{m.get("author","?")}: {txt}')
    top_tickers = sorted(tickers, key=tickers.get, reverse=True)[:5]
    bull = sum(1 for m in recent if _BULL_RE.search(m.get("text", "") or ""))
    bear = sum(1 for m in recent if _BEAR_RE.search(m.get("text", "") or ""))
    mood = "net bullish 🚀" if bull > bear else "net bearish 📉" if bear > bull else "mixed 🤔"
    return {
        "mode": "heuristic",
        "themes": [f"{t} ({tickers[t]} mentions)" for t in top_tickers] or ["General market chatter"],
        "questions": questions or ["No clear audience questions detected."],
        "followups": [f"Give your take on {t} — chat kept bringing it up." for t in top_tickers[:3]],
        "research": [f"Verify the claims/levels mentioned around {t}." for t in top_tickers[:3]],
        "sentiment": f"Chat was {mood} over {len(recent)} messages.",
        "notable": ", ".join(f'{r["author"]} (💎{r["standouts"]})' for r in top[:3] if r) or "—",
    }


async def host_recap(recent: List[dict], top: list, memory_context: str = "") -> dict:
    """
    End-of-stream debrief FOR THE HOST: themes, audience questions worth answering,
    follow-up segment ideas, and claims worth researching. Conditioned on the
    co-pilot's MEMORY of prior shows so it flags recurrence. Heuristic fallback.
    """
    if not recent:
        return {"mode": ai_mode(), "themes": [], "questions": [], "followups": [],
                "research": [], "sentiment": "No chat yet.", "notable": "—"}
    if _claude_use() and _client:
        try:
            lines = [
                f"[{m.get('source', '?').upper()}] {m.get('author', '?')}: {m.get('text', '')}"
                for m in recent[-180:]
            ]
            transcript = "\n".join(lines)[:14000]
            mem = (f"\n\n=== YOUR MEMORY FROM PRIOR SHOWS (use it!) ===\n{memory_context}\n"
                   "When something recurs from memory, SAY SO (e.g. 'again this week', "
                   "'returning contributor', 'known repeat bot'). Build on the past, don't repeat it cold."
                   if memory_context else "")
            resp = await _client.messages.create(
                model=MODEL,
                max_tokens=750,
                system=(
                    "You are the producer/co-pilot of a live crypto/markets show (Market Bubble, hosts "
                    "Ansem & Banks). The show just ended. Read the multi-platform chat transcript "
                    "and write a concise END-OF-STREAM DEBRIEF FOR THE HOST. Reply with ONLY a JSON "
                    "object, no prose/markdown, shape: "
                    "{\"themes\":[..],\"questions\":[..],\"followups\":[..],\"research\":[..],"
                    "\"sentiment\":\"..\",\"notable\":\"..\"}. "
                    "themes = 3-5 main things chat discussed. "
                    "questions = up to 6 real audience questions/requests the host should answer next time (quote briefly, with who asked). "
                    "followups = 3-5 concrete segment/topic ideas the host could do based on chat interest. "
                    "research = specific claims, tickers, or topics worth fact-checking or researching before next show. "
                    "sentiment = one line on overall mood. notable = standout contributors or moments. "
                    "Keep each list item to one short line." + mem
                ),
                messages=[{"role": "user", "content": transcript}],
            )
            out = next((b.text for b in resp.content if b.type == "text"), "")
            data = _extract_json(out)
            if data and isinstance(data, dict):
                data["mode"] = "claude"
                for k in ("themes", "questions", "followups", "research"):
                    if not isinstance(data.get(k), list):
                        data[k] = [str(data.get(k))] if data.get(k) else []
                return data
        except Exception as e:
            _trip_breaker(e)
    return _heuristic_recap(recent, top)


def _timeline_lines(recent: List[dict], limit: int = 120) -> str:
    """
    Render chat with TIME markers so the agent can answer time-scoped questions
    ('the opener', 'first 10 min', 'last 5 min'). Each line is prefixed with how
    many minutes before 'now' (the latest message) it landed: [-12m], [-0m], ...
    """
    window = [m for m in recent[-limit:] if m.get("text")]
    if not window:
        return ""
    now = max((int(m.get("ts") or 0) for m in window), default=0)
    out = []
    for m in window:
        ts = int(m.get("ts") or 0)
        mins = max(0, (now - ts) // 60000) if (now and ts) else 0
        out.append(
            f"[-{mins:>2}m][{m.get('source','?').upper()}] {m.get('author','?')}: {m.get('text','')}"
        )
    return "\n".join(out)[:7000]


def _facts_block(recent: List[dict]) -> str:
    """Hard, pre-computed facts so the agent cites numbers instead of estimating them."""
    msgs = [m for m in recent if m.get("text")]
    if not msgs:
        return "No chat captured yet this session."
    ts_vals = [int(m.get("ts") or 0) for m in msgs if m.get("ts")]
    span_min = ((max(ts_vals) - min(ts_vals)) // 60000) if len(ts_vals) >= 2 else 0
    tickers, authors, sources = {}, {}, {}
    for m in msgs:
        txt = m.get("text", "") or ""
        for tag in _CASHTAG_RE.findall(txt):
            tickers[tag.upper()] = tickers.get(tag.upper(), 0) + 1
        a = m.get("author", "?")
        authors[a] = authors.get(a, 0) + 1
        s = (m.get("source", "?") or "?").upper()
        sources[s] = sources.get(s, 0) + 1
    top_tk = sorted(tickers.items(), key=lambda kv: kv[1], reverse=True)[:6]
    top_au = sorted(authors.items(), key=lambda kv: kv[1], reverse=True)[:6]
    parts = [
        f"Messages this window: {len(msgs)} over ~{span_min} min "
        f"({'·'.join(f'{k} {v}' for k, v in sources.items())}).",
        "Most-mentioned tickers: " + (", ".join(f"{t} ×{c}" for t, c in top_tk) or "none"),
        "Most-active chatters: " + (", ".join(f"{a} ×{c}" for a, c in top_au) or "none"),
    ]
    return "\n".join(parts)


async def ask_agent(question: str, memory_context: str, recent: List[dict]) -> str:
    """
    The hosts' co-pilot Q&A. Answers using accumulated MEMORY across shows plus the
    current chat. e.g. 'who are my best contributors?', 'what does chat keep asking about?'.
    """
    q = (question or "").strip()
    if not q:
        return "Ask me about chat themes, your top contributors, recurring questions, or repeat bots."
    if _claude_use() and _client:
        try:
            timeline = _timeline_lines(recent)
            facts = _facts_block(recent)
            resp = await _client.messages.create(
                model=MODEL,
                max_tokens=380,
                system=(
                    "You are the persistent co-pilot for the hosts of a live crypto show (Market Bubble, "
                    "hosts Ansem & Banks). You have MEMORY across past shows, PRE-COMPUTED FACTS for the "
                    "current session, and a TIME-STAMPED chat log (each line tagged [-Nm] = minutes before "
                    "now, so [-0m] is just now and [-10m] is ten minutes ago).\n\n"
                    "HOW TO ANSWER:\n"
                    "- Lead with the answer. Be concrete: cite specific tickers, names, and the FACT counts "
                    "(e.g. '$VVV came up 7×, mostly from regulars').\n"
                    "- For time-scoped questions ('opener', 'first 10 min', 'last 5 min'), use the [-Nm] tags "
                    "to scope to that window and report what chat was doing then.\n"
                    "- You see CHAT, not the hosts' audio. If asked what the host SAID/covered, answer from "
                    "what chat reacted to in that window and say so in one short clause — then give a useful "
                    "read. NEVER end by asking the host to tell you what they covered; you do the work.\n"
                    "- 2-5 sentences, practical, no preamble. Ground every claim in the facts/log/memory below; "
                    "if something truly isn't there, say so in half a sentence and move on.\n\n"
                    f"=== MEMORY (prior shows) ===\n{memory_context or '(no prior shows yet)'}\n\n"
                    f"=== SESSION FACTS (pre-computed, trust these counts) ===\n{facts}\n\n"
                    f"=== CURRENT CHAT (time-stamped, newest last) ===\n{timeline or '(quiet)'}"
                ),
                messages=[{"role": "user", "content": q}],
            )
            text = next((b.text for b in resp.content if b.type == "text"), "")
            if text.strip():
                return text.strip()
        except Exception as e:
            _trip_breaker(e)
    # heuristic fallback: surface the pre-computed facts + raw memory (still useful offline)
    return ("Co-pilot (offline mode).\n" + _facts_block(recent) + "\n\nFrom memory:\n"
            + (memory_context or "no memory yet.") + "\n(Connect an Anthropic key for full Q&A.)")
