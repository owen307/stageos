const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('videoAPI', {
  onCommand: (cb) => ipcRenderer.on('video-command', (_, cmd) => cb(cmd)),
});
