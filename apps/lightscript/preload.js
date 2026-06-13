const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ls', {
  sendDMX:  (universe, data) => ipcRenderer.send('dmx', { universe, data }),
  sendOSC:  (ip,port,address,args) => ipcRenderer.send('osc',{ip,port,address,args}),
  getConfig: () => ipcRenderer.invoke('get-config'),
  onOscIn:  (cb) => ipcRenderer.on('osc-in', (_,d)=>cb(d)),
});
