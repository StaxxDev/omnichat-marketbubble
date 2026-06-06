// preload.js — safe bridge between main (Node) and renderer (sandboxed UI).
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('omni', {
  // streamed events from the engine
  onMessage: (cb) => ipcRenderer.on('chat:message', (_e, msg) => cb(msg)),
  onStatus: (cb) => ipcRenderer.on('chat:status', (_e, s) => cb(s)),
  onConfig: (cb) => ipcRenderer.on('chat:config', (_e, c) => cb(c)),

  // settings round-trip
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (partial) => ipcRenderer.invoke('settings:save', partial),
});
