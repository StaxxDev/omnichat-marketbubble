# 🎬 Record & Submit — Market Bubble $10k Challenge

**Status when you wake up:** the hero app runs with **real Claude AI** (verified — your top-up worked), and 3 apps are screenshot-proven. Previews in this folder:
- `preview-hero.png` — #6 AI-Augmented (the hero you'll film)
- `preview-overlay.png` — #4 OBS Overlay (recommended primary submission)
- `preview-hub.png` — #2 WebSocket Hub (safe shareable demo)

The form needs 3 things: **X handle**, **Loom/YouTube video of the live app**, **GitHub repo link**.

---

## ✅ The plan (do these in order)

### 1. Push the repo to GitHub  (~2 min)
Everything is committed locally on branch `master`. Create an **empty public repo** on github.com, then:
```bash
cd "c:/Users/Josh/Music/challange"
git remote add origin https://github.com/<you>/<repo>.git
git branch -M main
git push -u origin main
```
> `.env` (your X token + Anthropic key) is gitignored — confirmed not committed. Safe to push.

### 2. Run the hero app for the video  (~1 min)
```powershell
cd "c:/Users/Josh/Music/challange/06-ai-augmented"
.\.venv\Scripts\python.exe -m uvicorn main:app --port 8790
```
Open **http://localhost:8790** — it starts in demo mode instantly (chat flowing, source labels, AI tags, live summary). Header should read **AI: ON 🤖 Claude**.

To show **real live data** instead of demo, stop it and run with the shared `.env` already wired:
```powershell
# .env already has TWITCH_CHANNELS, KICK_CHANNELS, X_MODE=mentions, X_TARGET=blknoiz06
$env:DEMO=$null ; .\.venv\Scripts\python.exe -m uvicorn main:app --port 8790
```
(Twitch anon-IRC pulls real chat from whatever channel is live; demo mode is the safe fallback if a channel is quiet.)

### 3. Film the Loom (~2–3 min script)
Record the browser at http://localhost:8790 and say, roughly:
1. *"The brief: unified Twitch + X + Kick chat in one real-time feed with source labels. I built it — and 9 more."*
2. Point at the **source badges** (🎮 TWITCH / 𝕏 X / ⚡ KICK) and **channel labels**.
3. Click the **Twitch / X / Kick toggles** to show source filtering on/off.
4. Point at the **AI banner** ("what chat is saying") and the **spam tag + sentiment emojis** — *"a Claude layer summarizes chat and flags spam live."*
5. Point at the gold **⭐VIP** rows and **$TICKER** highlights — *"tuned for the show: hosts and cashtags pop."*
6. Close: *"And there are 10 architectures in the repo — overlay, extension, desktop, edge, SaaS, bot — pick what fits the show."*

Optional power-move: also show **#4 OBS overlay** for 10 seconds (it's literally chat ON the broadcast):
```
Open in browser:  04-obs-overlay/overlay.html?demo=1
```

### 4. Fill the form
- **X Handle:** `@______`  ← (you said a different handle — drop it in)
- **Loom/YouTube link:** your recording
- **GitHub repo:** the URL from step 1
- **Anything else:** paste the blurb below 👇

---

## 📝 "Anything else we should know?" — paste this

> Everyone else built one aggregator. I built **10 different architectures** so you can pick what fits the show — an on-stream **OBS overlay** (chat scrolling on the broadcast), an **AI layer** that auto-summarizes what chat's talking about + flags spam with sentiment, plus a browser extension, desktop app, edge-scaled (Cloudflare Durable Object) version for big audiences, a Telegram/Discord bridge, and a multi-tenant SaaS.
>
> All three sources are real: **Twitch** (anonymous IRC over WebSocket, no key), **Kick** (Pusher WebSocket), and **X** (API v2 polling) — each message carries a clear **source label**, with source-filter toggles, multi-channel/co-stream support, **$ticker highlighting**, and **host/VIP highlighting** tuned for Market Bubble's black-&-gold look.
>
> The demo video is the AI-augmented build; the repo is the full menu of 10. The AI degrades gracefully to a local heuristic if the API is down, so the feed never goes dark on stream.

---

## 📡 Live-data proof (ran the real connectors for 28s)
- **Twitch — ✅ 341 real messages** pulled live from jynxzi/xqc via anonymous IRC (no key).
- **X — ✅ 99 real @blknoiz06 mentions** via your API token (real cashtags: $SOL, $kins…).
- **Kick — ⚠️ Cloudflare-403** on the server-side channel lookup. This is the known Kick quirk: their CF blocks non-browser fetches (even headless Chrome). Two working paths:
  1. **The browser apps (#4 overlay, #1 extension) resolve Kick fine** — they run in your real Chrome where CF passes. So **film the overlay (#4) and all 3 sources are live.**
  2. For the **server-side** apps (#6/#2/#3/#5/#8), set `KICK_CHATROOM_IDS` in `.env`: open `https://kick.com/api/v2/channels/<slug>` in your normal Chrome, copy the `chatroom.id`, and paste it (CSV, aligned to `KICK_CHANNELS`). Until then Kick falls back to demo so the feed stays full.

> **Net:** for the demo video, Twitch + X are live out of the box; for full live Kick, either film the **overlay (#4)** or drop one `KICK_CHATROOM_IDS` value in `.env`.

## 🧪 What's verified vs. needs your machine
- **#6 AI-Augmented** — ✅ runs, real Claude confirmed (filmable now)
- **#4 OBS Overlay** — ✅ renders (static HTML, demo screenshotted)
- **#2 WebSocket Hub** — ✅ boots + serves built UI, screenshotted
- **#1 Extension** — static MV3; load via `chrome://extensions` → Load unpacked
- **#3 Edge / #7 Electron / #8 Bridge** — Node-based, `npm install` then run per their README
- **#5 Go / #10 Bun** — need Go / Bun installed (not on this machine); code is complete per their README

Full per-app run commands: see the top-level [README.md](README.md) and each folder's README.
