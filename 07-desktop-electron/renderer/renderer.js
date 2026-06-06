// renderer.js — feed UI: badges, filters, auto-scroll w/ pause, settings panel.
'use strict';

const MAX_MESSAGES = 500;
const SOURCE_META = {
  twitch: { label: 'TWITCH', emoji: '🎮' },
  x:      { label: 'X',      emoji: '𝕏' },
  kick:   { label: 'KICK',   emoji: '⚡' },
};

const feed = document.getElementById('feed');
const statusbar = document.getElementById('statusbar');
const pausePill = document.getElementById('pausePill');
const filtersEl = document.getElementById('filters');

let paused = false;
const statuses = {}; // key `${source}:${channel}` -> status obj

// ---------- helpers ----------
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function nearBottom() {
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
}

// ---------- render a message ----------
function addMessage(msg) {
  const meta = SOURCE_META[msg.source] || { label: msg.source.toUpperCase(), emoji: '•' };

  const row = document.createElement('div');
  row.className = 'msg ' + msg.source;

  const authorColor = msg.color && /^#?[0-9a-fA-F]{3,8}$/.test(msg.color)
    ? (msg.color[0] === '#' ? msg.color : '#' + msg.color)
    : '';

  row.innerHTML =
    `<span class="badge ${msg.source}">${meta.emoji} ${meta.label}</span>` +
    `<span class="channel">${escapeHtml(msg.channel || '')}</span>` +
    `<span class="author"${authorColor ? ` style="color:${authorColor}"` : ''}>${escapeHtml(msg.author || 'unknown')}</span>` +
    `<span class="text">${escapeHtml(msg.text || '')}</span>` +
    `<span class="ts">${fmtTime(msg.ts || Date.now())}</span>`;

  const stick = !paused && nearBottom();
  feed.appendChild(row);

  // cap retained messages
  while (feed.childElementCount > MAX_MESSAGES) {
    feed.removeChild(feed.firstElementChild);
  }

  if (stick) feed.scrollTop = feed.scrollHeight;
}

// ---------- status bar ----------
function renderStatus(s) {
  const key = `${s.source}:${s.channel}`;
  statuses[key] = s;
  const parts = [];
  for (const k of Object.keys(statuses)) {
    const st = statuses[k];
    let cls = 'ok';
    if (st.state === 'reconnecting') cls = 'warn';
    else if (st.state === 'error') cls = 'err';
    const emoji = (SOURCE_META[st.source] && SOURCE_META[st.source].emoji) || '•';
    parts.push(`<span class="pill ${cls}">${emoji} ${escapeHtml(st.channel)} — ${escapeHtml(st.detail || st.state)}</span>`);
  }
  statusbar.innerHTML = parts.join('');
}

// ---------- filters ----------
filtersEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.filter');
  if (!btn) return;
  const src = btn.dataset.source;
  btn.classList.toggle('on');
  feed.classList.toggle('hide-' + src, !btn.classList.contains('on'));
});

// ---------- pause-on-scroll-up ----------
feed.addEventListener('scroll', () => {
  if (nearBottom()) {
    if (paused) { paused = false; pausePill.classList.add('hidden'); }
  } else {
    if (!paused) { paused = true; pausePill.classList.remove('hidden'); }
  }
});
pausePill.addEventListener('click', () => {
  feed.scrollTop = feed.scrollHeight;
  paused = false;
  pausePill.classList.add('hidden');
});

// ---------- settings panel ----------
const overlay = document.getElementById('settingsOverlay');
const el = (id) => document.getElementById(id);

function asCsv(arr) { return Array.isArray(arr) ? arr.join(', ') : (arr || ''); }

function openSettings() {
  window.omni.getSettings().then((s) => {
    el('set_twitch').value = asCsv(s.twitchChannels);
    el('set_kick').value = asCsv(s.kickChannels);
    el('set_kickids').value = asCsv(s.kickChatroomIds);
    el('set_xmode').value = s.xMode || 'hashtag';
    el('set_xtarget').value = s.xTarget || '';
    el('set_xtoken').value = s.xBearer || '';
    el('set_demo').checked = !!s.demo;
    overlay.classList.remove('hidden');
  });
}
function closeSettings() { overlay.classList.add('hidden'); }

el('settingsBtn').addEventListener('click', openSettings);
el('cancelBtn').addEventListener('click', closeSettings);
el('saveBtn').addEventListener('click', () => {
  const partial = {
    twitchChannels: el('set_twitch').value,
    kickChannels: el('set_kick').value,
    kickChatroomIds: el('set_kickids').value,
    xMode: el('set_xmode').value,
    xTarget: el('set_xtarget').value.trim(),
    xBearer: el('set_xtoken').value.trim(),
    demo: el('set_demo').checked,
  };
  // clear feed + statuses so the new session starts fresh
  feed.innerHTML = '';
  for (const k of Object.keys(statuses)) delete statuses[k];
  statusbar.innerHTML = '';
  window.omni.saveSettings(partial).then(() => closeSettings());
});

// ---------- wire up IPC ----------
window.omni.onMessage(addMessage);
window.omni.onStatus(renderStatus);
window.omni.onConfig(() => { /* config arrives; engine already started in main */ });
