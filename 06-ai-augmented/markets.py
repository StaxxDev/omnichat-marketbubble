"""
markets.py — the prediction-market layer for OmniChat AI.

Market Bubble is "the new home for prediction market discourse", so the co-pilot
doesn't just read chat — it reads what chat is *betting on*. This module pulls
LIVE odds from Polymarket's public Gamma API (no key needed) and matches them to
what chat is talking about, so the host can say "chat's split on X — the line
says 63% Yes" on camera.

Two jobs, both DEGRADE GRACEFULLY (network down -> empty, never throws to caller):
  1) trending()           -> top active markets by 24h volume (ambient context)
  2) relevant(keywords)   -> markets that match what chat is discussing right now

Public endpoints used:
  GET https://gamma-api.polymarket.com/markets?active=true&closed=false&order=volume24hr
  GET https://gamma-api.polymarket.com/public-search?q=<term>
"""

from __future__ import annotations

import json
from typing import List, Optional

import httpx

_GAMMA = "https://gamma-api.polymarket.com"
_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36"
_EVENT_URL = "https://polymarket.com/event/"

# Common cashtags -> the words Polymarket actually titles markets with.
_TICKER_ALIASES = {
    "BTC": "bitcoin", "ETH": "ethereum", "SOL": "solana", "DOGE": "dogecoin",
    "HYPE": "hyperliquid", "XRP": "xrp", "BNB": "bnb", "ADA": "cardano",
    "PEPE": "pepe", "WIF": "dogwifhat", "BONK": "bonk", "AVAX": "avalanche",
    "LINK": "chainlink", "SUI": "sui", "TRUMP": "trump", "VVV": "venice",
}


def search_term(keyword: str) -> str:
    """Map a chat keyword (often a $TICKER) to a better Polymarket search term."""
    k = (keyword or "").strip().lstrip("$").upper()
    return _TICKER_ALIASES.get(k, keyword.strip().lstrip("$"))


def _parse_odds(m: dict) -> List[dict]:
    """Parse Polymarket's JSON-string outcomes/prices into [{name, pct}], sorted desc."""
    try:
        names = json.loads(m.get("outcomes") or "[]")
        prices = json.loads(m.get("outcomePrices") or "[]")
    except Exception:
        return []
    pairs = []
    for n, p in zip(names, prices):
        try:
            pairs.append({"name": str(n), "pct": round(float(p) * 100, 1)})
        except Exception:
            continue
    pairs.sort(key=lambda o: o["pct"], reverse=True)
    return pairs


def _norm(m: dict, slug: Optional[str] = None, kw: str = "") -> Optional[dict]:
    q = (m.get("question") or m.get("groupItemTitle") or "").strip()
    odds = _parse_odds(m)
    if not q or not odds:
        return None
    try:
        vol = float(m.get("volume24hr") or 0)
    except Exception:
        vol = 0.0
    s = slug or m.get("slug") or ""
    return {
        "question": q,
        "odds": odds[:3],
        "vol24": vol,
        "url": (_EVENT_URL + s) if s else "https://polymarket.com",
        "matched": kw,
    }


async def _get(cl: httpx.AsyncClient, path: str, params: dict) -> Optional[object]:
    try:
        r = await cl.get(_GAMMA + path, params=params, headers={"User-Agent": _UA})
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return None


async def trending(limit: int = 6) -> List[dict]:
    """Top active markets by 24h volume — ambient 'what the board looks like' context."""
    async with httpx.AsyncClient(timeout=12) as cl:
        data = await _get(cl, "/markets", {
            "active": "true", "closed": "false",
            "order": "volume24hr", "ascending": "false", "limit": str(limit * 2),
        })
    out, seen = [], set()
    for m in (data or []):
        nm = _norm(m)
        if nm and nm["question"] not in seen:
            seen.add(nm["question"]); out.append(nm)
        if len(out) >= limit:
            break
    return out


async def _search_one(cl: httpx.AsyncClient, keyword: str) -> List[dict]:
    term = search_term(keyword)
    data = await _get(cl, "/public-search", {"q": term, "limit_per_type": "4"})
    out = []
    for ev in ((data or {}).get("events") or []):
        if ev.get("closed") or not ev.get("active"):
            continue
        slug = ev.get("slug") or ""
        # pick the highest-volume market in the event for a clean single line
        mk = sorted(ev.get("markets") or [], key=lambda x: float(x.get("volume24hr") or 0), reverse=True)
        for m in mk[:1]:
            nm = _norm(m, slug=slug, kw=keyword)
            if nm:
                out.append(nm)
    return out


async def relevant(keywords: List[str], limit: int = 5) -> dict:
    """
    Markets matching what chat is talking about + a trending fallback.
    Returns {"matched": [...], "trending": [...]}. Never raises.
    """
    matched, seen = [], set()
    kws = [k for k in (keywords or []) if k][:3]
    async with httpx.AsyncClient(timeout=12) as cl:
        for kw in kws:
            for nm in await _search_one(cl, kw):
                key = nm["question"].lower()
                if key not in seen:
                    seen.add(key); matched.append(nm)
            if len(matched) >= limit:
                break
    matched.sort(key=lambda m: m["vol24"], reverse=True)
    trend = await trending(6)
    return {"matched": matched[:limit], "trending": trend}


def as_context(snapshot: dict, max_items: int = 5) -> str:
    """Compact text block of current odds for the co-pilot / recap to reason over."""
    if not snapshot:
        return ""
    rows = (snapshot.get("matched") or []) or (snapshot.get("trending") or [])
    lines = []
    for m in rows[:max_items]:
        odds = " / ".join(f"{o['name']} {o['pct']}%" for o in m["odds"][:2])
        lines.append(f"- {m['question']} — {odds}")
    return ("Live prediction-market odds (Polymarket):\n" + "\n".join(lines)) if lines else ""
