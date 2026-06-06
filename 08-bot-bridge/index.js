'use strict';
// index.js — OmniChat Bridge
// Runs the three connectors and fans every unified message out to:
//   (a) a live web "table view" at / over Server-Sent Events
//   (b) a Telegram chat   (Bot API sendMessage)        — optional
//   (c) a Discord webhook (DISCORD_WEBHOOK_URL)         — optional
// Outbound to TG/Discord is throttled through a single ~1 msg/s queue (batched).

const http = require('http');
const fs = require('fs');
const path = require('path');
const { startAll, SOURCES } = require('./connectors');

// --- load .env (tiny parser, no dependency) ---
loadDotEnv(path.join(__dirname, '.env'));

const PORT = parseInt(process.env.PORT, 10) || 8088;
const MAX_MESSAGES = 500;

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

function log(...a) { console.log('[bridge]', ...a); }

// --- ring buffer of recent messages (bounds memory) ---
const recent = [];
function remember(msg) {
  recent.push(msg);
  if (recent.length > MAX_MESSAGES) recent.splice(0, recent.length - MAX_MESSAGES);
}

// --- SSE clients ---
const clients = new Set();
function broadcastSSE(msg) {
  const payload = 'data: ' + JSON.stringify(msg) + '\n\n';
  for (const res of clients) {
    try { res.write(payload); } catch (_) { /* dropped on next write */ }
  }
}

// =====================================================================
// Outbound rate-limited queue (shared by Telegram + Discord)
// Telegram/Discord both tolerate ~1 msg/s; we batch up to N lines per tick.
// =====================================================================
const outQueue = [];
const SEND_INTERVAL_MS = 1100;
const BATCH_LINES = 12; // collapse a burst into one message to respect limits

function label(source) {
  const s = SOURCES[source] || { emoji: '', label: source.toUpperCase() };
  return s.emoji + ' ' + s.label;
}
function fmtLine(m) {
  return label(m.source) + ' #' + m.channel + ' ' + m.author + ': ' + m.text;
}

function enqueueOutbound(msg) {
  if (!TG_TOKEN && !DISCORD_WEBHOOK_URL) return; // nothing to send to
  outQueue.push(msg);
  // hard cap the backlog so a flood can't grow unbounded
  if (outQueue.length > 2000) outQueue.splice(0, outQueue.length - 2000);
}

setInterval(() => {
  if (!outQueue.length) return;
  const batch = outQueue.splice(0, BATCH_LINES);
  const text = batch.map(fmtLine).join('\n');
  if (TG_TOKEN && TG_CHAT) sendTelegram(text);
  if (DISCORD_WEBHOOK_URL) sendDiscord(text);
}, SEND_INTERVAL_MS);

async function sendTelegram(text) {
  try {
    const res = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG_CHAT,
        text: text.slice(0, 4096),
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) log('[telegram] HTTP ' + res.status + ' ' + (await safeText(res)));
  } catch (e) { log('[telegram] error: ' + (e && e.message)); }
}

async function sendDiscord(text) {
  try {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text.slice(0, 2000) }),
    });
    // Discord returns 204 on success
    if (res.status !== 204 && !res.ok) log('[discord] HTTP ' + res.status + ' ' + (await safeText(res)));
  } catch (e) { log('[discord] error: ' + (e && e.message)); }
}

async function safeText(res) { try { return (await res.text()).slice(0, 200); } catch (_) { return ''; } }

// =====================================================================
// Wire connectors -> all sinks
// =====================================================================
const bridge = startAll(process.env, (msg) => {
  remember(msg);
  broadcastSSE(msg);
  enqueueOutbound(msg);
}, log);

// =====================================================================
// HTTP server: web view + SSE + meta
// =====================================================================
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(INDEX_HTML);
    return;
  }

  if (url === '/meta') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      demo: bridge.demo,
      sinks: {
        telegram: !!(TG_TOKEN && TG_CHAT),
        discord: !!DISCORD_WEBHOOK_URL,
      },
      sources: SOURCES,
    }));
    return;
  }

  if (url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    // backfill recent history so a fresh tab isn't empty
    for (const m of recent.slice(-100)) res.write('data: ' + JSON.stringify(m) + '\n\n');
    clients.add(res);
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (_) {} }, 15000);
    req.on('close', () => { clearInterval(ka); clients.delete(res); });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, () => {
  log('OmniChat Bridge listening on http://localhost:' + PORT);
  log('mode: ' + (bridge.demo ? 'DEMO (synthetic feed)' : 'LIVE'));
  log('sinks: telegram=' + !!(TG_TOKEN && TG_CHAT) + ' discord=' + !!DISCORD_WEBHOOK_URL);
});

process.on('SIGINT', () => { log('shutting down'); try { bridge.stop(); } catch (_) {} process.exit(0); });

// =====================================================================
// minimal .env loader
// =====================================================================
function loadDotEnv(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch (_) { return; }
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v[0] === '"' && v.slice(-1) === '"') || (v[0] === "'" && v.slice(-1) === "'")) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
