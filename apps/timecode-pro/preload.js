const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // HTTP server
  httpStart:   (port) => ipcRenderer.invoke('http-server-start', port),
  httpStop:    ()     => ipcRenderer.invoke('http-server-stop'),
  httpStatus:  ()     => ipcRenderer.invoke('http-server-status'),
  httpBroadcast:(msg) => ipcRenderer.invoke('http-broadcast', msg),
  onHttpStarted:(cb)  => ipcRenderer.on('http-server-started', (_, d) => cb(d)),
  onHttpError:  (cb)  => ipcRenderer.on('http-server-error',   (_, e) => cb(e)),
  // OSC
  oscStart:   (cfg)        => ipcRenderer.invoke('osc-start', cfg),
  oscStop:    ()           => ipcRenderer.invoke('osc-stop'),
  oscSend:    (addr, args) => ipcRenderer.invoke('osc-send', addr, args),
  oscConfig:  ()           => ipcRenderer.invoke('osc-config'),
  onOscIn:    (cb)         => ipcRenderer.on('osc-in',    (_, d) => cb(d)),
  onOscError: (cb)         => ipcRenderer.on('osc-error', (_, e) => cb(e)),

  // MIDI
  midiGetPorts:   ()        => ipcRenderer.invoke('midi-get-ports'),
  midiOpenInput:  (idx)     => ipcRenderer.invoke('midi-open-input',  idx),
  midiOpenOutput: (idx)     => ipcRenderer.invoke('midi-open-output', idx),
  midiSend:       (s,d1,d2) => ipcRenderer.invoke('midi-send', s, d1, d2),
  midiClose:      ()        => ipcRenderer.invoke('midi-close'),
  onMidiIn:       (cb)      => ipcRenderer.on('midi-in', (_, d) => cb(d)),

  // Video window
  videoWindowOpen:          ()      => ipcRenderer.invoke('video-window-open'),
  videoWindowClose:         ()      => ipcRenderer.invoke('video-window-close'),
  videoCommand:             (cmd)   => ipcRenderer.invoke('video-command', cmd),
  videoWindowFullscreen:    (f)     => ipcRenderer.invoke('video-window-fullscreen', f),
  videoWindowMoveToDisplay: (idx)   => ipcRenderer.invoke('video-window-move-to-display', idx),
  getDisplays:              ()      => ipcRenderer.invoke('get-displays'),
  onVideoWindowClosed:      (cb)    => ipcRenderer.on('video-window-closed', () => cb()),

  // File / show
  saveShowDialog:  (data) => ipcRenderer.invoke('save-show-dialog', data),
  openShowDialog:  ()     => ipcRenderer.invoke('open-show-dialog'),
  openFileDialog:  (opts) => ipcRenderer.invoke('open-file-dialog', opts),
  readFile:        (fp)   => ipcRenderer.invoke('read-file', fp),
  pathToUrl:       (fp)   => ipcRenderer.invoke('path-to-url', fp),

  // Menu events
  onMenuNewShow:     (cb) => ipcRenderer.on('menu-new-show',       () => cb()),
  onMenuOpenShow:    (cb) => ipcRenderer.on('menu-open-show',      (_, d) => cb(d)),
  onMenuSave:        (cb) => ipcRenderer.on('menu-save',           () => cb()),
  onMenuSaveAs:      (cb) => ipcRenderer.on('menu-save-as',        () => cb()),
  onMenuPlayPause:   (cb) => ipcRenderer.on('menu-play-pause',     () => cb()),
  onMenuStop:        (cb) => ipcRenderer.on('menu-stop',           () => cb()),
  onMenuGo:          (cb) => ipcRenderer.on('menu-go',             () => cb()),
  onMenuRecordStart: (cb) => ipcRenderer.on('menu-record-start',   () => cb()),
  onMenuRecordStop:  (cb) => ipcRenderer.on('menu-record-stop',    () => cb()),
});
