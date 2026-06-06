'use strict';

const WebSocket = require('ws');
const { makeMessage } = require('../schema');

const TWITCH_IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';

// Anonymous, read-only Twitch IRC connector (no API key).
// `channels` = array of channel logins (no leading #).
function startTwitch(channels, emit, log) {
  const chans = (channels || []).map((c) => c.trim().toLowerCase()).filter(Boolean);
  if (chans.length === 0) return () => {};

  let ws = null;
  let closed = false;
  let attempt = 0;
  let reconnectTimer = null;

  function backoff() {
    attempt += 1;
    return Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)); // 2s..30s
  }

  function parseLine(line) {
    if (!line || line.indexOf(' PRIVMSG ') === -1) return null;

    let tags = {};
    let rest = line;
    if (line[0] === '@') {
      const sp = line.indexOf(' ');
      const tagStr = line.slice(1, sp);
      rest = line.slice(sp + 1);
      for (const kv of tagStr.split(';')) {
        const eq = kv.indexOf('=');
        if (eq === -1) continue;
        tags[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
    }

    // rest looks like:  :alice!alice@alice.tmi.twitch.tv PRIVMSG #chan :hello world
    const privIdx = rest.indexOf(' PRIVMSG ');
    if (privIdx === -1) return null;
    const afterPriv = rest.slice(privIdx + ' PRIVMSG '.length); // "#chan :hello world"
    const colonIdx = afterPriv.indexOf(' :');
    if (colonIdx === -1) return null;
    const channel = afterPriv.slice(0, colonIdx).replace(/^#/, '');
    const text = afterPriv.slice(colonIdx + 2);

    // fallback author from the prefix nick if no display-name tag
    let author = tags['display-name'];
    if (!author) {
      const bang = rest.indexOf('!');
      if (rest[0] === ':' && bang > 0) author = rest.slice(1, bang);
    }

    return makeMessage({
      id: tags.id || `twitch-${channel}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      source: 'twitch',
      channel,
      author,
      text,
      color: tags.color || '',
    });
  }

  function connect() {
    if (closed) return;
    ws = new WebSocket(TWITCH_IRC_URL);

    ws.on('open', () => {
      attempt = 0;
      log(`twitch: connected, joining ${chans.length} channel(s): ${chans.join(', ')}`);
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands\r\n');
      ws.send(`NICK justinfan${Math.floor(Math.random() * 90000) + 10000}\r\n`);
      for (const c of chans) ws.send(`JOIN #${c}\r\n`);
    });

    ws.on('message', (buf) => {
      const data = buf.toString('utf8');
      for (const line of data.split('\r\n')) {
        if (!line) continue;
        if (line.startsWith('PING')) {
          ws.send('PONG :tmi.twitch.tv\r\n');
          continue;
        }
        const msg = parseLine(line);
        if (msg) emit(msg);
      }
    });

    ws.on('close', () => {
      if (closed) return;
      const wait = backoff();
      log(`twitch: socket closed, reconnecting in ${wait}ms`);
      reconnectTimer = setTimeout(connect, wait);
    });

    ws.on('error', (err) => {
      log(`twitch: error ${err.message}`);
      try { ws.close(); } catch (_) {}
    });
  }

  connect();

  return function stop() {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try { ws && ws.close(); } catch (_) {}
  };
}

module.exports = { startTwitch };
