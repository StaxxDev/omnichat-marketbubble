"""
x_dm.py — send the recap as a Direct Message on X (text + PNG card).

X DMs require USER-CONTEXT auth (the app-only bearer can only read). Set four
OAuth 1.0a values in .env, from an X app with Read+Write+Direct-Messages perms:
    X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET

Flow:  resolve @handle -> user id  ->  upload PNG (v1.1 media/upload) -> media_id
       ->  POST /2/dm_conversations/with/:id/messages  {text, attachments:[media_id]}

OAuth 1.0a HMAC-SHA1 is signed here with the stdlib (no extra deps). For our
multipart upload and JSON DM the request body is NOT form-encoded, so only the
oauth_* params go into the signature base string (per the OAuth 1.0a spec).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import time
from typing import Optional, Tuple
from urllib.parse import quote

import httpx

_UPLOAD_URL = "https://upload.twitter.com/1.1/media/upload.json"


def _creds() -> Tuple[str, str, str, str]:
    return (
        os.environ.get("X_API_KEY", "") or os.environ.get("X_CONSUMER_KEY", ""),
        os.environ.get("X_API_SECRET", "") or os.environ.get("X_CONSUMER_SECRET", ""),
        os.environ.get("X_ACCESS_TOKEN", ""),
        os.environ.get("X_ACCESS_SECRET", "") or os.environ.get("X_ACCESS_TOKEN_SECRET", ""),
    )


def has_creds() -> bool:
    return all(_creds())


def _pct(s: str) -> str:
    return quote(str(s), safe="-._~")


def _oauth_header(method: str, url: str, extra_oauth: Optional[dict] = None) -> str:
    ck, cs, tok, ts_secret = _creds()
    # stdlib randomness only (avoids workflow-sandbox bans on random in scripts; this is app runtime)
    nonce = base64.b64encode(os.urandom(24)).decode().strip("=").replace("+", "").replace("/", "")
    oauth = {
        "oauth_consumer_key": ck,
        "oauth_nonce": nonce,
        "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp": str(int(time.time())),
        "oauth_token": tok,
        "oauth_version": "1.0",
    }
    if extra_oauth:
        oauth.update(extra_oauth)
    # signature base: only oauth params (body is multipart/JSON, not form-encoded; no query params)
    param_str = "&".join(f"{_pct(k)}={_pct(v)}" for k, v in sorted(oauth.items()))
    base = "&".join([method.upper(), _pct(url), _pct(param_str)])
    key = f"{_pct(cs)}&{_pct(ts_secret)}"
    sig = base64.b64encode(hmac.new(key.encode(), base.encode(), hashlib.sha1).digest()).decode()
    oauth["oauth_signature"] = sig
    return "OAuth " + ", ".join(f'{_pct(k)}="{_pct(v)}"' for k, v in sorted(oauth.items()))


async def _resolve_user_id(cl: httpx.AsyncClient, handle: str) -> Optional[str]:
    handle = handle.strip().lstrip("@")
    if not handle:
        return None
    url = f"https://api.twitter.com/2/users/by/username/{handle}"
    bearer = os.environ.get("X_BEARER_TOKEN", "")
    headers = {"Authorization": f"Bearer {bearer}"} if bearer else {"Authorization": _oauth_header("GET", url)}
    r = await cl.get(url, headers=headers)
    if r.status_code == 200:
        return (r.json().get("data") or {}).get("id")
    return None


async def send_recap_dm(recipient: str, text: str, image_data_url: str = "") -> dict:
    """Resolve recipient, upload the PNG (if any), and send the DM. Returns {ok, error?}."""
    if not has_creds():
        return {"ok": False, "error": "No X write creds — set X_API_KEY/X_API_SECRET/X_ACCESS_TOKEN/X_ACCESS_SECRET in .env"}
    if not recipient:
        return {"ok": False, "error": "Enter a recipient @handle for the DM"}
    try:
        async with httpx.AsyncClient(timeout=30) as cl:
            uid = await _resolve_user_id(cl, recipient)
            if not uid:
                return {"ok": False, "error": f"Could not resolve @{recipient.lstrip('@')}"}

            media_id = None
            if image_data_url.startswith("data:image"):
                raw = base64.b64decode(image_data_url.split(",", 1)[1])
                up = await cl.post(
                    _UPLOAD_URL,
                    headers={"Authorization": _oauth_header("POST", _UPLOAD_URL)},
                    files={"media": ("recap.png", raw, "image/png")},
                )
                if up.status_code not in (200, 201):
                    return {"ok": False, "error": f"media upload failed ({up.status_code}): {up.text[:200]}"}
                media_id = up.json().get("media_id_string")

            dm_url = f"https://api.twitter.com/2/dm_conversations/with/{uid}/messages"
            body = {"text": text[:9000]}
            if media_id:
                body["attachments"] = [{"media_id": media_id}]
            dm = await cl.post(
                dm_url,
                headers={"Authorization": _oauth_header("POST", dm_url), "Content-Type": "application/json"},
                json=body,
            )
            if dm.status_code in (200, 201):
                return {"ok": True, "media": bool(media_id)}
            return {"ok": False, "error": f"DM failed ({dm.status_code}): {dm.text[:250]}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}
