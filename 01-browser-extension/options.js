// OmniChat options — read/write the single `cfg` object in chrome.storage.local.
const FIELDS = ["twitchChannels", "kickChannels", "kickChatroomIds", "xBearerToken", "xMode", "xTarget"];

function el(id) { return document.getElementById(id); }

async function load() {
  const { cfg } = await chrome.storage.local.get("cfg");
  const c = cfg || {};
  for (const f of FIELDS) if (el(f)) el(f).value = c[f] || "";
  el("demo").checked = !!c.demo;
}

async function save() {
  const { cfg } = await chrome.storage.local.get("cfg");
  const next = Object.assign({}, cfg || {});
  for (const f of FIELDS) next[f] = el(f).value.trim();
  next.demo = el("demo").checked;
  if (!next.filters) next.filters = { twitch: true, x: true, kick: true };
  await chrome.storage.local.set({ cfg: next });
  // background listens to storage.onChanged and restarts connectors automatically,
  // but we also send an explicit reload to be safe.
  chrome.runtime.sendMessage({ type: "omnichat:reload" }).catch(() => {});
  const s = el("saved");
  s.classList.add("show");
  setTimeout(() => s.classList.remove("show"), 1800);
}

el("save").addEventListener("click", save);

el("open").addEventListener("click", async () => {
  try {
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id });
  } catch (e) {
    alert("Click the OmniChat toolbar icon to open the side panel.");
  }
});

load();
