'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

// Load .env from this folder, then from the parent challenge folder (shared secrets).
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { SOURCES } = require('./schema');
const { startTwitch } = require('./connectors/twitch');
const { startKick } = require('./connectors/kick');
const { startX } = require('./connectors/x');
const { startDemo } = require('./connectors/demo');

const PORT = parseInt(process.env.PORT || '3848', 10);
const MAX_RETAINED = 500;

function csv(v) {
  return (v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function log(msg) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}] ${msg}`);
}

// ---- in-memory ring buffer of recent messages (bounds memory) ----
const recent = [];
function retain(msg) {
  recent.push(msg);
  if (recent.length > MAX_RETAINED) recent.splice(0, recent.length - MAX_RETAINED);
}

// ---- WebSocket fan-out ----
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      try { client.send(data); } catch (_) {}
    }
  }
}

function emit(msg) {
  retain(msg);
  broadcast({ type: 'message', message: msg });
}

wss.on('connection', (ws) => {
  // Send current config + history snapshot so a fresh browser is immediately useful.
  ws.send(
    JSON.stringify({
      type: 'hello',
      sources: SOURCES,
      config: configSummary,
      history: recent,
    })
  );
});

// ---- decide config / demo mode ----
const twitchChannels = csv(process.env.TWITCH_CHANNELS);
const kickChannels = csv(process.env.KICK_CHANNELS);
const kickChatroomIds = csv(process.env.KICK_CHATROOM_IDS);
const xBearer = process.env.X_BEARER_TOKEN || '';
const xMode = process.env.X_MODE || 'replies';
const xTarget = process.env.X_TARGET || '';

const anythingConfigured =
  twitchChannels.length > 0 || kickChannels.length > 0 || (xBearer && xTarget);
const demoMode = process.env.DEMO === '1' || !anythingConfigured;

const configSummary = {
  demo: demoMode,
  twitch: twitchChannels,
  kick: kickChannels,
  x: xBearer && xTarget ? { mode: xMode, target: xTarget } : null,
};

const stoppers = [];

if (demoMode) {
  log('=== DEMO MODE (no/partial config) — synthetic feed enabled ===');
  stoppers.push(startDemo(emit, log, 800));
} else {
  log('=== LIVE MODE ===');
  if (twitchChannels.length) stoppers.push(startTwitch(twitchChannels, emit, log));
  if (kickChannels.length) stoppers.push(startKick(kickChannels, kickChatroomIds, emit, log));
  if (xBearer && xTarget) stoppers.push(startX({ bearer: xBearer, mode: xMode, target: xTarget }, emit, log));
}

// ---- static frontend (built) with graceful fallback ----
const webDist = path.join(__dirname, '..', 'web', 'dist');
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, demo: demoMode, retained: recent.length, config: configSummary });
});

if (fs.existsSync(path.join(webDist, 'index.html'))) {
  app.use(express.static(webDist));
  // SPA fallback: any GET that wasn't a static file or /api -> index.html.
  // Using app.use (not a path pattern) avoids Express-4 path-to-regexp quirks.
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.sendFile(path.join(webDist, 'index.html'));
  });
  log(`serving built frontend from ${webDist}`);
} else {
  app.get('/', (_req, res) => {
    res
      .status(200)
      .type('html')
      .send(
        `<!doctype html><html><body style="font-family:system-ui;background:#0e0e10;color:#eee;padding:40px">
        <h1>OmniChat Hub — server running</h1>
        <p>The WebSocket feed is live at <code>ws://localhost:${PORT}/ws</code>.</p>
        <p>The React frontend isn't built yet. In dev, run <code>npm run dev</code> (server + Vite).
        For the static build, run <code>npm run build</code> then <code>npm start</code>.</p>
        <p>Health: <a style="color:#9146FF" href="/api/health">/api/health</a></p>
        </body></html>`
      );
  });
}

server.listen(PORT, () => {
  log(`OmniChat Hub server on http://localhost:${PORT}  (ws: /ws)`);
});

function shutdown() {
  log('shutting down...');
  for (const stop of stoppers) {
    try { stop(); } catch (_) {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
