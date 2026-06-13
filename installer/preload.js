const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  getSysinfo:      ()       => ipcRenderer.invoke('get-sysinfo'),
  scanDrives:      ()       => ipcRenderer.invoke('scan-drives'),
  writeUSB:        (opts)   => ipcRenderer.invoke('write-usb', opts),
  cancelWrite:     ()       => ipcRenderer.invoke('cancel-write'),
  requestAdmin:    ()       => ipcRenderer.invoke('request-admin'),
  browseISO:       ()       => ipcRenderer.invoke('browse-iso'),
  minimize:        ()       => ipcRenderer.send('minimize'),
  close:           ()       => ipcRenderer.send('close'),
  openUrl:         (url)    => ipcRenderer.send('open-url', url),
  onWriteProgress: (cb)     => ipcRenderer.on('write-progress', (_, d) => cb(d)),
});
