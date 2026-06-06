// OmniChat side panel — renders the merged, labeled, filterable feed.
const MAX_DOM = 500;

const SOURCE_META = {
  twitch: { label: "TWITCH", emoji: "🎮" },
  x: { label: "X", emoji: "𝕏" },
  kick: { label: "KICK", emoji: "⚡" },
};

const feedEl = document.getElementById("feed");
const statusEl = document.getElementById("statusbar");
const jumpBtn = document.getElementById("jumpBtn");
const pauseBtn = document.getElementById("pauseBtn");
const clearBtn = document.getElementById("clearBtn");
const optionsBtn = document.getElementById("optionsBtn");
const demoBadge = document.getElementById("demoBadge");

let filters = { twitch: true, x: true, kick: true };
let paused = false;       // manual pause
let userScrolledUp = false;

// ---- helpers -------------------------------------------------------------
function nearBottom() {
  return feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 40;
}

function maybeAutoscroll() {
  if (paused || userScrolledUp) {
    jumpBtn.hidden = false;
    return;
  }
  feedEl.scrollTop = feedEl.scrollHeight;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function authorColor(msg) {
  if (msg.color) return msg.color;
  // deterministic fallback color from author name
  let h = 0;
  for (let i = 0; i < msg.author.length; i++) h = (h * 31 + msg.author.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue}, 70%, 65%)`;
}

function clearEmpty() {
  const e = feedEl.querySelector(".empty");
  if (e) e.remove();
}

function renderRow(msg) {
  const meta = SOURCE_META[msg.source];
  if (!meta) return;
  clearEmpty();

  const row = document.createElement("div");
  row.className = "row";
  row.dataset.src = msg.source;
  if (!filters[msg.source]) row.style.display = "none";

  const badge = document.createElement("span");
  badge.className = `badge ${msg.source}`;
  badge.textContent = `${meta.emoji} ${meta.label}`;

  const chan = document.createElement("span");
  chan.className = "chan";
  chan.textContent = msg.channel || "";

  const author = document.createElement("span");
  author.className = "author";
  author.style.color = authorColor(msg);
  author.textContent = msg.author;

  const text = document.createElement("span");
  text.className = "text";
  text.textContent = msg.text;

  row.append(badge, chan, author, text);
  feedEl.appendChild(row);

  // cap DOM
  while (feedEl.childElementCount > MAX_DOM) feedEl.removeChild(feedEl.firstElementChild);

  maybeAutoscroll();
}

function applyFilters() {
  for (const row of feedEl.querySelectorAll(".row")) {
    row.style.display = filters[row.dataset.src] ? "" : "none";
  }
  if (!paused && !userScrolledUp) feedEl.scrollTop = feedEl.scrollHeight;
}

function renderStatus(status) {
  if (!status) return;
  demoBadge.hidden = !status.demo;
  const parts = [];
  const tw = status.twitch || {};
  const ki = status.kick || {};
  const xx = status.x || {};
  if (status.demo) {
    parts.push(`<span><span class="dot up"></span>Demo mode — synthetic feed</span>`);
  } else {
    parts.push(`<span><span class="dot ${tw.connected ? "up" : "down"}"></span>Twitch ${(tw.channels || []).length || 0} ch</span>`);
    parts.push(`<span><span class="dot ${ki.connected ? "up" : "down"}"></span>Kick ${(ki.chatrooms || []).length || 0} ch</span>`);
    parts.push(`<span><span class="dot ${xx.active ? "up" : "down"}"></span>X ${xx.active ? xx.mode + ":" + xx.target : "off"}</span>`);
  }
  statusEl.innerHTML = parts.join("");
}

function showEmpty() {
  if (feedEl.childElementCount === 0) {
    const d = document.createElement("div");
    d.className = "empty";
    d.textContent = "Waiting for messages…";
    feedEl.appendChild(d);
  }
}

// ---- events --------------------------------------------------------------
chrome.runtime.onMessage.addListener((req) => {
  if (req.type === "omnichat:msg") renderRow(req.msg);
  else if (req.type === "omnichat:status") renderStatus(req.status);
});

for (const btn of document.querySelectorAll(".filter")) {
  btn.addEventListener("click", () => {
    const src = btn.dataset.src;
    filters[src] = !filters[src];
    btn.classList.toggle("on", filters[src]);
    applyFilters();
    chrome.runtime.sendMessage({ type: "omnichat:setFilters", filters }).catch(() => {});
  });
}

pauseBtn.addEventListener("click", () => {
  paused = !paused;
  pauseBtn.classList.toggle("paused", paused);
  pauseBtn.textContent = paused ? "▶ Paused" : "⏸ Live";
  if (!paused) {
    userScrolledUp = false;
    jumpBtn.hidden = true;
    feedEl.scrollTop = feedEl.scrollHeight;
  }
});

clearBtn.addEventListener("click", () => {
  feedEl.innerHTML = "";
  showEmpty();
});

optionsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

jumpBtn.addEventListener("click", () => {
  userScrolledUp = false;
  jumpBtn.hidden = true;
  feedEl.scrollTop = feedEl.scrollHeight;
});

// pause-on-scroll-up behavior
feedEl.addEventListener("scroll", () => {
  if (nearBottom()) {
    userScrolledUp = false;
    if (!paused) jumpBtn.hidden = true;
  } else {
    userScrolledUp = true;
  }
});

// ---- init ----------------------------------------------------------------
chrome.runtime.sendMessage({ type: "omnichat:getBackfill" }, (resp) => {
  if (chrome.runtime.lastError || !resp) { showEmpty(); return; }
  if (resp.filters) {
    filters = Object.assign(filters, resp.filters);
    for (const btn of document.querySelectorAll(".filter")) {
      btn.classList.toggle("on", !!filters[btn.dataset.src]);
    }
  }
  renderStatus(resp.status);
  if (resp.buffer && resp.buffer.length) {
    for (const m of resp.buffer) renderRow(m);
    feedEl.scrollTop = feedEl.scrollHeight;
  } else {
    showEmpty();
  }
});
