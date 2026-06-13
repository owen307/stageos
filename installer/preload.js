const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSysinfo:      ()       => ipcRenderer.invoke('get-sysinfo'),
  runInstall:      (opts)   => ipcRenderer.invoke('run-install', opts),
  minimize:        ()       => ipcRenderer.send('minimize'),
  close:           ()       => ipcRenderer.send('close'),
  openUrl:         (url)    => ipcRenderer.send('open-url', url),
  onProgress:      (cb)     => ipcRenderer.on('install-progress', (_, data) => cb(data))
});
