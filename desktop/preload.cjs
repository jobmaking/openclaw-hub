'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Only the local shell has a preload. The remote Hub has no desktop bridge.
contextBridge.exposeInMainWorld('hubDesktop', Object.freeze({
  command: (name, value) => ipcRenderer.invoke('hub:command', name, value),
  onState: (callback) => {
    if (typeof callback !== 'function') return;
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('hub:state', handler);
    return () => ipcRenderer.removeListener('hub:state', handler);
  },
}));
