const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('sf', {
  goLive:   (slide) => ipcRenderer.send('go-live', slide),
  blackout: ()      => ipcRenderer.send('blackout'),
  clear:    ()      => ipcRenderer.send('clear'),
  onShow:   (cb)    => ipcRenderer.on('show-slide', (_,s)=>cb(s)),
  onBlackout:(cb)   => ipcRenderer.on('blackout', ()=>cb()),
  onClear:  (cb)    => ipcRenderer.on('clear', ()=>cb()),
});
