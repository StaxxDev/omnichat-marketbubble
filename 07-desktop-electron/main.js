// main.js — Electron main process for OmniChat Desktop
// Local-first: runs the three connectors directly in Node and forwards unified
// messages to the renderer via IPC. Settings persist to a local JSON in userData.

'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { ChatEngine, SOURCE_META } = require('./connectors');

// Optional .env support without a dependency (tiny parser).
loadDotEnv(path.join(__dirname, '.env'));

let win = null;
let engine = null;

// ---- settings persistence (userData/settings.json) ----
function settingsPath() {
  return path.join(app.getPath('userData'), 'omnichat-settings.json');
}

function readSettings() {
  // env provides defaults; saved file overrides; both merged.
  const fromEnv = {
    twitchChannels: csv(process.env.TWITCH_CHANNELS),
    kickChannels: csv(process.env.KICK_CHANNELS),
    kickChatroomIds: csv(process.env.KICK_CHATROOM_IDS),
    xBearer: process.env.X_BEARER_TOKEN || '',
    xMode: process.env.X_MODE || 'hashtag',
    xTarget: process.env.X_TARGET || '',
    demo: process.env.DEMO === '1',
  };
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch (_) { /* no saved file yet */ }
  return Object.assign({}, fromEnv, saved);
}

function writeSettings(s) {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save settings:', e.message);
  }
}

function csv(v) {
  if (!v) return [];
  return String(v).split(',').map((x) => x.trim()).filter(Boolean);
}

// ---- engine lifecycle ----
function startEngine(settings) {
  if (engine) engine.stop();
  engine = new ChatEngine(
    settings,
    (msg) => { if (win && !win.isDestroyed()) win.webContents.send('chat:message', msg); },
    (status) => { if (win && !win.isDestroyed()) win.webContents.send('chat:status', status); }
  );
  engine.start();
}

function createWindow() {
  win = new BrowserWindow({
    width: 480,
    height: 820,
    minWidth: 360,
    minHeight: 480,
    backgroundColor: '#0e0e10',
    title: 'OmniChat Desktop',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.on('did-finish-load', () => {
    const settings = readSettings();
    win.webContents.send('chat:config', { settings, sourceMeta: SOURCE_META });
    startEngine(settings);
  });
}

// ---- IPC: renderer asks for current config / saves new settings / restarts ----
ipcMain.handle('settings:get', () => readSettings());

ipcMain.handle('settings:save', (_evt, partial) => {
  const merged = Object.assign({}, readSettings(), partial || {});
  // normalize csv strings -> arrays if the renderer sent strings
  ['twitchChannels', 'kickChannels', 'kickChatroomIds'].forEach((k) => {
    if (typeof merged[k] === 'string') merged[k] = csv(merged[k]);
  });
  writeSettings(merged);
  startEngine(merged);
  return merged;
});

app.whenReady().then(createWindow);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (engine) engine.stop();
  if (process.platform !== 'darwin') app.quit();
});

// ---- minimal .env loader (no dependency) ----
function loadDotEnv(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!(k in process.env)) process.env[k] = v;
    }
  } catch (_) { /* no .env file — fine */ }
}
