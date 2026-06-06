"""
memory.py — the show co-pilot's persistent memory (SQLite, stdlib only).

After each end-of-stream recap, we COMMIT what was learned:
  - the recap itself (recaps table),
  - distilled lessons (themes / research / questions / recurring tickers) that
    accrue 'hits' every time they recur across shows (lessons table),
  - per-user reputation accumulated across sessions (users table).

That memory is then RECALLED into future analysis (recall_context) so the agent
notices recurring themes, returning high-signal contributors, and repeat bots —
i.e. it gets sharper every show instead of starting cold each time.
"""

from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path
from typing import List, Optional

_DB = Path(__file__).parent / "copilot.db"
_CASHTAG = re.compile(r"\$[A-Za-z]{2,10}\b")


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(_DB)
    c.row_factory = sqlite3.Row
    return c


def init() -> None:
    with _conn() as c:
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS recaps(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT, messages INTEGER, sentiment TEXT, notable TEXT,
                mode TEXT, data TEXT
            );
            CREATE TABLE IF NOT EXISTS lessons(
                key TEXT PRIMARY KEY, kind TEXT, text TEXT, hits INTEGER, ts TEXT
            );
            CREATE TABLE IF NOT EXISTS users(
                author TEXT PRIMARY KEY, source TEXT, sessions INTEGER,
                msgs INTEGER, standouts INTEGER, bot_flags INTEGER,
                score INTEGER, last_seen TEXT
            );
            """
        )
    print(f"[memory] co-pilot memory ready at {_DB.name}")


def _add_lesson(c: sqlite3.Connection, kind: str, text: str, ts: str) -> None:
    text = (text or "").strip()
    if not text or len(text) < 3:
        return
    key = f"{kind}:{text.lower()[:120]}"
    row = c.execute("SELECT hits FROM lessons WHERE key=?", (key,)).fetchone()
    if row:
        c.execute("UPDATE lessons SET hits=hits+1, ts=? WHERE key=?", (ts, key))
    else:
        c.execute(
            "INSERT INTO lessons(key,kind,text,hits,ts) VALUES(?,?,?,1,?)",
            (key, kind, text, ts),
        )


def commit_recap(recap: dict, user_rows: List[dict], n_messages: int, ts: str) -> dict:
    """Persist a recap + distilled lessons + accumulate user reputation. Returns memory counts."""
    with _conn() as c:
        c.execute(
            "INSERT INTO recaps(ts,messages,sentiment,notable,mode,data) VALUES(?,?,?,?,?,?)",
            (ts, n_messages, recap.get("sentiment", ""), recap.get("notable", ""),
             recap.get("mode", ""), json.dumps(recap)),
        )
        # distilled lessons
        for t in recap.get("themes", []) or []:
            _add_lesson(c, "theme", t, ts)
        for r in recap.get("research", []) or []:
            _add_lesson(c, "research", r, ts)
        for q in recap.get("questions", []) or []:
            _add_lesson(c, "question", q, ts)
        # recurring tickers (strong cross-show signal) — mined from themes+research+sentiment
        blob = " ".join((recap.get("themes", []) or []) + (recap.get("research", []) or [])
                        + [recap.get("sentiment", "")])
        for tk in {m.upper() for m in _CASHTAG.findall(blob)}:
            _add_lesson(c, "ticker", tk, ts)
        # accumulate user reputation across sessions
        for u in user_rows:
            a = u.get("author", "")
            if not a:
                continue
            row = c.execute("SELECT * FROM users WHERE author=?", (a,)).fetchone()
            if row:
                c.execute(
                    "UPDATE users SET source=?, sessions=sessions+1, msgs=msgs+?, "
                    "standouts=standouts+?, bot_flags=bot_flags+?, score=score+?, last_seen=? "
                    "WHERE author=?",
                    (u.get("source", row["source"]), u.get("msgs", 0), u.get("standouts", 0),
                     u.get("bots", 0), u.get("score", 0), ts, a),
                )
            else:
                c.execute(
                    "INSERT INTO users(author,source,sessions,msgs,standouts,bot_flags,score,last_seen) "
                    "VALUES(?,?,?,?,?,?,?,?)",
                    (a, u.get("source", ""), 1, u.get("msgs", 0), u.get("standouts", 0),
                     u.get("bots", 0), u.get("score", 0), ts),
                )
    return get_memory(brief=True)


def recall_context(max_chars: int = 1400) -> str:
    """Compact memory block injected into future analysis prompts. Empty string if no memory yet."""
    try:
        with _conn() as c:
            tickers = c.execute(
                "SELECT text,hits FROM lessons WHERE kind='ticker' AND hits>1 ORDER BY hits DESC LIMIT 6"
            ).fetchall()
            vips = c.execute(
                "SELECT author,standouts,sessions FROM users WHERE standouts>0 ORDER BY standouts DESC LIMIT 6"
            ).fetchall()
            bots = c.execute(
                "SELECT author,bot_flags FROM users WHERE bot_flags>0 ORDER BY bot_flags DESC LIMIT 8"
            ).fetchall()
            themes = c.execute(
                "SELECT text,hits FROM lessons WHERE kind IN('theme','research') AND hits>1 "
                "ORDER BY hits DESC LIMIT 5"
            ).fetchall()
            nrecaps = c.execute("SELECT COUNT(*) n FROM recaps").fetchone()["n"]
    except Exception:
        return ""
    if not nrecaps:
        return ""
    parts = [f"MEMORY FROM {nrecaps} PRIOR SHOW(S):"]
    if tickers:
        parts.append("Recurring tickers: " + ", ".join(f"{r['text']}(x{r['hits']})" for r in tickers))
    if themes:
        parts.append("Recurring topics: " + "; ".join(f"{r['text']} (x{r['hits']})" for r in themes))
    if vips:
        parts.append("Returning high-signal contributors: "
                     + ", ".join(f"{r['author']} (💎{r['standouts']} over {r['sessions']} shows)" for r in vips))
    if bots:
        parts.append("Known repeat bot/raid handles: " + ", ".join(r["author"] for r in bots))
    return "\n".join(parts)[:max_chars]


def get_memory(brief: bool = False) -> dict:
    with _conn() as c:
        nrecaps = c.execute("SELECT COUNT(*) n FROM recaps").fetchone()["n"]
        nlessons = c.execute("SELECT COUNT(*) n FROM lessons").fetchone()["n"]
        nusers = c.execute("SELECT COUNT(*) n FROM users").fetchone()["n"]
        if brief:
            return {"recaps": nrecaps, "lessons": nlessons, "users": nusers}
        lessons = [dict(r) for r in c.execute(
            "SELECT kind,text,hits FROM lessons ORDER BY hits DESC, ts DESC LIMIT 14").fetchall()]
        top_users = [dict(r) for r in c.execute(
            "SELECT author,source,sessions,msgs,standouts,bot_flags,score FROM users "
            "ORDER BY standouts DESC, score DESC LIMIT 8").fetchall()]
    return {"recaps": nrecaps, "lessons_count": nlessons, "users_count": nusers,
            "lessons": lessons, "top_users": top_users}
