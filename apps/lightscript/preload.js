const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onMenuAction:     (cb)            => ipcRenderer.on('menu-action', (_, action, data) => cb(action, data)),
  saveDialog:       (name)          => ipcRenderer.invoke('save-dialog', name),
  writeFile:        (p, d)          => ipcRenderer.invoke('write-file', p, d),
  // GDTF
  gdtfPickFolder:   ()              => ipcRenderer.invoke('gdtf-pick-folder'),
  gdtfLoadFolder:   (p)             => ipcRenderer.invoke('gdtf-load-folder', p),
  // sACN
  sacnStart:        (opts)          => ipcRenderer.invoke('sacn-start', opts),
  sacnStop:         ()              => ipcRenderer.invoke('sacn-stop'),
  sacnPushFixtures: (f)             => ipcRenderer.invoke('sacn-push-fixtures', f),
  sacnSetUniverse:  (u, data)       => ipcRenderer.invoke('sacn-set-universe', u, data),
  sacnSetChannel:   (u, ch, v)      => ipcRenderer.invoke('sacn-set-channel', u, ch, v),
  sacnBlackout:     ()              => ipcRenderer.invoke('sacn-blackout'),
  sacnStats:        ()              => ipcRenderer.invoke('sacn-stats'),
  sacnInterfaces:   ()              => ipcRenderer.invoke('sacn-interfaces'),
  sacnConfigure:    (opts)          => ipcRenderer.invoke('sacn-configure', opts),
  // USB DMX
  usbdmxListPorts:    ()                      => ipcRenderer.invoke('usbdmx-list-ports'),
  usbdmxGetInterfaces:()                      => ipcRenderer.invoke('usbdmx-get-interfaces'),
  usbdmxConnect:      (id, portOrIp, opts)    => ipcRenderer.invoke('usbdmx-connect', id, portOrIp, opts),
  usbdmxDisconnect:   ()                      => ipcRenderer.invoke('usbdmx-disconnect'),
  usbdmxPushFixtures: (f)                     => ipcRenderer.invoke('usbdmx-push-fixtures', f),
  usbdmxSetBuffer:    (data)                   => ipcRenderer.invoke('usbdmx-set-buffer', data),
  usbdmxSetChannel:   (ch, v)                 => ipcRenderer.invoke('usbdmx-set-channel', ch, v),
  usbdmxBlackout:     ()                      => ipcRenderer.invoke('usbdmx-blackout'),
  usbdmxStatus:       ()                      => ipcRenderer.invoke('usbdmx-status'),
  // Clipboard
  clipboardRead:     ()        => ipcRenderer.invoke('clipboard-read'),
  // License
  licenseLoad:       ()        => ipcRenderer.invoke('license-load'),
  licenseValidate:   (key)     => ipcRenderer.invoke('license-validate', key),
  licenseActivate:   (key)     => ipcRenderer.invoke('license-activate', key),
  licenseDeactivate: ()        => ipcRenderer.invoke('license-deactivate'),
  // AI (Anthropic proxy — key stored in main process userData)
  aiHasKey:   ()               => ipcRenderer.invoke('ai-has-key'),
  aiSetKey:   (key)            => ipcRenderer.invoke('ai-set-key', key),
  aiClearKey: ()               => ipcRenderer.invoke('ai-clear-key'),
  aiChat:     (payload)        => ipcRenderer.invoke('ai-chat', payload),
  // Web Remote
  ppConnect:        (port)            => ipcRenderer.invoke('pp-connect', port),
  remoteStart:      (port, passcode)  => ipcRenderer.invoke('remote-start', port, passcode),
  remoteStop:       ()                => ipcRenderer.invoke('remote-stop'),
  remoteStatus:     ()                => ipcRenderer.invoke('remote-status'),
  remoteBroadcast:  (state)           => ipcRenderer.invoke('remote-broadcast', state),
  remotePasscode:   (p)               => ipcRenderer.invoke('remote-passcode', p),
  onRemoteCommand:  (cb)              => ipcRenderer.on('remote-command', (_, cmd) => cb(cmd)),
});
