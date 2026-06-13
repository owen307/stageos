const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('tc', {
  send:         (cmd)  => ipcRenderer.send('command', cmd),
  getConfig:    ()     => ipcRenderer.invoke('get-config'),
  getServerUrl: ()     => ipcRenderer.invoke('get-server-url'),
  onOscIn:      (cb)   => ipcRenderer.on('osc-in',     (_,d)=>cb(d)),
  onServerUrl:  (cb)   => ipcRenderer.on('server-url', (_,u)=>cb(u)),
});
