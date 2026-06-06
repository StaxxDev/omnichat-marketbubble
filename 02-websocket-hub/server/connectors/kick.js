'use strict';

const WebSocket = require('ws');
const { makeMessage } = require('../schema');

const PUSHER_URL =
  'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Resolve a chatroom id for a slug. Kick sits behind Cloudflare, so send a browser UA.
async function resolveChatroomId(slug, log) {
  try {
    const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
    });
    if (!res.ok) {
      log(`kick: lookup for "${slug}" returned ${res.status} (Cloudflare?). Use KICK_CHATROOM_IDS to override.`);
      return null;
    }
    const json = await res.json();
    const id = json && json.chatroom && json.chatroom.id;
    if (!id) {
      log(`kick: no chatroom id in response for "${slug}"`);
      return null;
    }
    return { id, slug };
  } catch (err) {
    log(`kick: lookup failed for "${slug}": ${err.message}`);
    return null;
  }
}

// channels = array of slugs. chatroomIdOverrides = array aligned to channels (optional).
function startKick(channels, chatroomIdOverrides, emit, log) {
  const slugs = (channels || []).map((c) => c.trim()).filter(Boolean);
  const overrides = chatroomIdOverrides || [];
  if (slugs.length === 0) return () => {};

  let ws = null;
  let closed = false;
  let attempt = 0;
  let reconnectTimer = null;
  // rooms: array of { id, slug }
  let rooms = [];

  function backoff() {
    attempt += 1;
    return Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
  }

  async function resolveRooms() {
    const out = [];
    for (let i = 0; i < slugs.length; i++) {
      const slug = slugs[i];
      const override = overrides[i] && String(overrides[i]).trim();
      if (override) {
        out.push({ id: override, slug });
        continue;
      }
      const r = await resolveChatroomId(slug, log);
      if (r) out.push(r);
    }
    return out;
  }

  function connect() {
    if (closed) return;
    ws = new WebSocket(PUSHER_URL);

    ws.on('open', () => {
      attempt = 0;
      log(`kick: pusher connected (${rooms.length} room(s))`);
    });

    ws.on('message', (buf) => {
      let frame;
      try {
        frame = JSON.parse(buf.toString('utf8'));
      } catch (_) {
        return;
      }

      if (frame.event === 'pusher:connection_established') {
        for (const room of rooms) {
          ws.send(
            JSON.stringify({
              event: 'pusher:subscribe',
              data: { auth: '', channel: `chatrooms.${room.id}.v2` },
            })
          );
        }
        log(`kick: subscribed to ${rooms.map((r) => r.slug).join(', ')}`);
        return;
      }

      if (frame.event === 'pusher:ping') {
        ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
        return;
      }

      if (frame.event === 'App\\Events\\ChatMessage') {
        let data;
        try {
          data = typeof frame.data === 'string' ? JSON.parse(frame.data) : frame.data;
        } catch (_) {
          return;
        }
        // map channel back to slug via the chatrooms.{id}.v2 pusher channel name
        let slug = '';
        const m = /chatrooms\.(\d+)\.v2/.exec(frame.channel || '');
        if (m) {
          const found = rooms.find((r) => String(r.id) === m[1]);
          slug = found ? found.slug : m[1];
        }
        const sender = data.sender || {};
        emit(
          makeMessage({
            id: data.id || `kick-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            source: 'kick',
            channel: slug,
            author: sender.username,
            text: data.content,
            color: (sender.identity && sender.identity.color) || '',
            ts: data.created_at ? Date.parse(data.created_at) || Date.now() : Date.now(),
          })
        );
      }
    });

    ws.on('close', () => {
      if (closed) return;
      const wait = backoff();
      log(`kick: pusher closed, reconnecting in ${wait}ms`);
      reconnectTimer = setTimeout(connect, wait);
    });

    ws.on('error', (err) => {
      log(`kick: error ${err.message}`);
      try { ws.close(); } catch (_) {}
    });
  }

  (async () => {
    rooms = await resolveRooms();
    if (rooms.length === 0) {
      log('kick: no resolvable chatrooms — connector idle (set KICK_CHATROOM_IDS to force).');
      return;
    }
    connect();
  })();

  return function stop() {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try { ws && ws.close(); } catch (_) {}
  };
}

module.exports = { startKick };
