const { app, BrowserWindow, ipcMain, dialog, Menu, screen, protocol } = require('electron');
const path  = require('path');
const fs    = require('fs');
const http  = require('http');
const os    = require('os');

let mainWindow, videoWindow = null;
let OSC, midi;
let oscServer = null;
let oscConfig = { localPort:9000, remoteHost:'127.0.0.1', remotePort:8000 };
let midiInputPort = null, midiOutputPort = null;
let httpServer = null, wss = null, httpPort = 3141;
const wsClients = new Set();

function getLocalIp() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function broadcastToMobile(obj) {
  const msg = JSON.stringify(obj);
  wsClients.forEach(ws => { try { if (ws.readyState === 1) ws.send(msg); } catch(e) {} });
}

function handleMobileMessage(msg) {
  const send = (ch,...args) => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send(ch,...args);
  switch (msg.type) {
    case 'osc-send':   sendOsc(msg.address, msg.args||[]); send('osc-in',{address:msg.address,args:msg.args,from:'mobile',ts:Date.now()}); break;
    case 'midi-send':  sendMidi(msg.status,msg.data1,msg.data2); send('midi-in',{status:msg.status,data1:msg.data1,data2:msg.data2,ts:Date.now()}); break;
    case 'fader':      sendOsc(msg.path,[{type:'f',value:msg.value}]); break;
    case 'mute':       sendOsc(msg.path,[{type:'i',value:msg.value}]); break;
    case 'go':         send('menu-go'); break;
    case 'play-pause': send('menu-play-pause'); break;
    case 'stop':       send('menu-stop'); break;
    case 'ion-cmd':    sendOsc('/eos/cmd',[{type:'s',value:msg.cmd}]); break;
    case 'atem-cut':   sendOsc('/atem/cut',[]); break;
    case 'atem-preview': sendOsc('/atem/preview',[{type:'i',value:msg.input}]); break;
    case 'atem-program': sendOsc('/atem/program',[{type:'i',value:msg.input}]); break;
  }
}

function startHttpServer(port) {
  stopHttpServer();
  httpPort = port || 3141;
  const server = http.createServer((req, res) => {
    let filePath;
    const url = req.url.split('?')[0];
    if (url === '/' || url === '/index.html') {
      filePath = path.join(__dirname, 'renderer', 'mobile.html');
    } else if (url.startsWith('/assets/')) {
      filePath = path.join(__dirname, '..', url);
    } else {
      filePath = path.join(__dirname, 'renderer', url);
    }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      const ext = path.extname(filePath);
      const mime = {'.html':'text/html','.css':'text/css','.js':'application/javascript','.png':'image/png','.jpg':'image/jpeg','.ico':'image/x-icon'}[ext] || 'application/octet-stream';
      res.writeHead(200, {'Content-Type':mime}); res.end(data);
    });
  });
  try {
    const WS = require('ws');
    wss = new WS.WebSocketServer({ server });
    wss.on('connection', ws => {
      wsClients.add(ws);
      ws.send(JSON.stringify({ type:'hello', ip:getLocalIp(), port:httpPort }));
      ws.on('message', raw => { try { handleMobileMessage(JSON.parse(raw.toString())); } catch(e) {} });
      ws.on('close', () => wsClients.delete(ws));
      ws.on('error', () => wsClients.delete(ws));
    });
  } catch(e) { console.warn('ws not available:', e.message); }
  server.listen(httpPort, '0.0.0.0', () => {
    const ip = getLocalIp();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('http-server-started', { ip, port:httpPort, url:`http://${ip}:${httpPort}` });
  });
  server.on('error', e => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('http-server-error', e.message); });
  httpServer = server;
}

function stopHttpServer() {
  wsClients.forEach(ws => { try { ws.close(); } catch(e) {} });
  wsClients.clear();
  if (wss) { try { wss.close(); } catch(e) {} wss = null; }
  if (httpServer) { try { httpServer.close(); } catch(e) {} httpServer = null; }
}

function startOscServer(config) {
  if (!OSC) return { ok:false, error:'osc module not installed' };
  if (oscServer) { try { oscServer.close(); } catch(e) {} }
  oscConfig = { ...oscConfig, ...config };
  try {
    oscServer = new OSC.UDPPort({ localAddress:'0.0.0.0', localPort:oscConfig.localPort, remoteAddress:oscConfig.remoteHost, remotePort:oscConfig.remotePort, metadata:true });
    oscServer.on('message', (msg, _tt, info) => {
      const data = { address:msg.address, args:msg.args, from:`${info.address}:${info.port}`, ts:Date.now() };
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('osc-in', data);
      broadcastToMobile({ type:'osc-in', ...data });
    });
    oscServer.on('error', err => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('osc-error', err.message); });
    oscServer.open();
    return { ok:true };
  } catch(e) { return { ok:false, error:e.message }; }
}

function sendOsc(address, args) {
  if (!oscServer) return { ok:false, error:'OSC not started' };
  try { oscServer.send({ address, args:args||[] }); return { ok:true }; } catch(e) { return { ok:false, error:e.message }; }
}

function stopOscServer() { if (oscServer) { try { oscServer.close(); } catch(e) {} oscServer = null; } }

function getMidiPorts() {
  if (!midi) return { inputs:[], outputs:[] };
  try {
    const i=new midi.Input(), o=new midi.Output();
    const inputs=Array.from({length:i.getPortCount()},(_,n)=>i.getPortName(n));
    const outputs=Array.from({length:o.getPortCount()},(_,n)=>o.getPortName(n));
    i.closePort(); o.closePort(); return { inputs, outputs };
  } catch(e) { return { inputs:[], outputs:[], error:e.message }; }
}

function openMidiInput(idx) {
  if (!midi) return { ok:false, error:'node-midi not installed' };
  try {
    if (midiInputPort) midiInputPort.closePort();
    midiInputPort = new midi.Input(); midiInputPort.openPort(idx);
    midiInputPort.on('message', (_dt, msg) => {
      const data = { status:msg[0], data1:msg[1], data2:msg[2], ts:Date.now() };
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('midi-in', data);
      broadcastToMobile({ type:'midi-in', ...data });
    });
    return { ok:true };
  } catch(e) { return { ok:false, error:e.message }; }
}

function openMidiOutput(idx) {
  if (!midi) return { ok:false, error:'node-midi not installed' };
  try { if (midiOutputPort) midiOutputPort.closePort(); midiOutputPort = new midi.Output(); midiOutputPort.openPort(idx); return { ok:true }; }
  catch(e) { return { ok:false, error:e.message }; }
}

function sendMidi(s, d1, d2) {
  if (!midiOutputPort) return { ok:false, error:'No MIDI output' };
  try { midiOutputPort.sendMessage([s,d1,d2]); return { ok:true }; } catch(e) { return { ok:false, error:e.message }; }
}

function closeMidi() {
  if (midiInputPort)  { try { midiInputPort.closePort();  } catch(e) {} midiInputPort  = null; }
  if (midiOutputPort) { try { midiOutputPort.closePort(); } catch(e) {} midiOutputPort = null; }
}

app.whenReady().then(() => {
  protocol.registerFileProtocol('tcmedia', (req, cb) => { cb({ path: decodeURIComponent(req.url.replace('tcmedia://', '')) }); });
  try { OSC  = require('osc');       } catch(e) { console.warn('osc not available'); }
  try { midi = require('node-midi'); } catch(e) { console.warn('node-midi not available'); }
  createWindow();
  buildMenu();
  startHttpServer(3141);
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width:1440, height:900, minWidth:1100, minHeight:700, backgroundColor:'#0d1117',
    titleBarStyle: process.platform==='darwin'?'hiddenInset':'default',
    frame: process.platform!=='darwin',
    icon: path.join(__dirname,'../assets/icon.png'),
    webPreferences: { nodeIntegration:false, contextIsolation:true, preload:path.join(__dirname,'preload.js') }
  });
  mainWindow.loadFile(path.join(__dirname,'renderer/index.html'));
}

function createVideoWindow() {
  if (videoWindow && !videoWindow.isDestroyed()) { videoWindow.focus(); return; }
  const prim = screen.getPrimaryDisplay();
  const sec  = screen.getAllDisplays().find(d => d.id !== prim.id);
  let opts;
  if (sec) { opts = sec.bounds; }
  else { const w=Math.round(prim.workAreaSize.width*0.75),h=Math.round(prim.workAreaSize.height*0.75); opts={x:prim.bounds.x+Math.round((prim.bounds.width-w)/2),y:prim.bounds.y+Math.round((prim.bounds.height-h)/2),width:w,height:h}; }
  videoWindow = new BrowserWindow({ ...opts, backgroundColor:'#000', title:'Booth Copilot — Video Output', webPreferences:{nodeIntegration:false,contextIsolation:true,webSecurity:false,preload:path.join(__dirname,'preload-video.js')} });
  videoWindow.loadFile(path.join(__dirname,'renderer/video-player.html'));
  videoWindow.on('closed', () => { videoWindow=null; if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('video-window-closed'); });
}

ipcMain.handle('http-server-start',  (_, port) => { startHttpServer(port); return {ok:true,ip:getLocalIp(),port:port||3141}; });
ipcMain.handle('http-server-stop',   ()        => { stopHttpServer(); return {ok:true}; });
ipcMain.handle('http-server-status', ()        => ({running:!!httpServer,ip:getLocalIp(),port:httpPort,url:`http://${getLocalIp()}:${httpPort}`}));
ipcMain.handle('http-broadcast',     (_,msg)   => { broadcastToMobile(msg); return {ok:true}; });
ipcMain.handle('osc-start',  (_,cfg)        => startOscServer(cfg));
ipcMain.handle('osc-stop',   ()             => { stopOscServer(); return {ok:true}; });
ipcMain.handle('osc-send',   (_,addr,args)  => sendOsc(addr,args));
ipcMain.handle('osc-config', ()             => oscConfig);
ipcMain.handle('midi-get-ports',   ()           => getMidiPorts());
ipcMain.handle('midi-open-input',  (_,idx)      => openMidiInput(idx));
ipcMain.handle('midi-open-output', (_,idx)      => openMidiOutput(idx));
ipcMain.handle('midi-send',        (_,s,d1,d2)  => sendMidi(s,d1,d2));
ipcMain.handle('midi-close',       ()           => { closeMidi(); return {ok:true}; });
ipcMain.handle('video-window-open',            ()     => { createVideoWindow(); return true; });
ipcMain.handle('video-window-close',           ()     => { if(videoWindow&&!videoWindow.isDestroyed())videoWindow.close(); return true; });
ipcMain.handle('video-command',                (_,cmd)=> { if(videoWindow&&!videoWindow.isDestroyed()){videoWindow.webContents.send('video-command',cmd);return true;}return false; });
ipcMain.handle('video-window-fullscreen',      (_,f)  => { if(videoWindow&&!videoWindow.isDestroyed()){videoWindow.setFullScreen(f!==undefined?f:!videoWindow.isFullScreen());return true;}return false; });
ipcMain.handle('video-window-move-to-display', (_,idx)=> { if(!videoWindow||videoWindow.isDestroyed())return false; const d=screen.getAllDisplays()[idx]||screen.getAllDisplays()[0]; videoWindow.setBounds(d.bounds); return true; });
ipcMain.handle('get-displays', () => { const p=screen.getPrimaryDisplay(); return screen.getAllDisplays().map((d,i)=>({index:i,id:d.id,label:`Display ${i+1}${d.id===p.id?' (Primary)':''}`,bounds:d.bounds})); });
ipcMain.handle('save-show-dialog', async(_,data) => { const r=await dialog.showSaveDialog(mainWindow,{filters:[{name:'Booth Copilot Show',extensions:['bcs']}],defaultPath:'MyShow.bcs'}); if(!r.canceled){fs.writeFileSync(r.filePath,JSON.stringify(data,null,2));return r.filePath;}return null; });
ipcMain.handle('open-show-dialog', async()       => { const r=await dialog.showOpenDialog(mainWindow,{filters:[{name:'Booth Copilot Show',extensions:['bcs']}],properties:['openFile']}); if(!r.canceled)return JSON.parse(fs.readFileSync(r.filePaths[0],'utf-8')); return null; });
ipcMain.handle('open-file-dialog', async(_,opts) => { const r=await dialog.showOpenDialog(mainWindow,{filters:opts.filters||[{name:'All Files',extensions:['*']}],properties:['openFile']}); return r.canceled?null:r.filePaths[0]; });
ipcMain.handle('read-file',   async(_,fp) => { try{return fs.readFileSync(fp);}catch(e){return null;} });
ipcMain.handle('path-to-url', (_,fp) => 'file:///'+fp.replace(/\\/g,'/').split('/').map(s=>encodeURIComponent(s)).join('/').replace(/^\/+/,''));

function buildMenu() {
  const send = (ch,...a) => mainWindow && mainWindow.webContents.send(ch,...a);
  const t = [
    {label:'File',submenu:[{label:'New Show',accelerator:'CmdOrCtrl+N',click:()=>send('menu-new-show')},{label:'Open Show…',accelerator:'CmdOrCtrl+O',click:async()=>{const r=await dialog.showOpenDialog(mainWindow,{filters:[{name:'Booth Copilot Show',extensions:['bcs']}],properties:['openFile']});if(!r.canceled)send('menu-open-show',JSON.parse(fs.readFileSync(r.filePaths[0],'utf-8')));}},{label:'Save',accelerator:'CmdOrCtrl+S',click:()=>send('menu-save')},{label:'Save As…',accelerator:'CmdOrCtrl+Shift+S',click:()=>send('menu-save-as')},{type:'separator'},{role:'quit'}]},
    {label:'Automation',submenu:[{label:'Play / Pause',accelerator:'Space',click:()=>send('menu-play-pause')},{label:'Stop',accelerator:'Escape',click:()=>send('menu-stop')},{label:'GO',accelerator:'G',click:()=>send('menu-go')},{type:'separator'},{label:'Start Recording',accelerator:'CmdOrCtrl+R',click:()=>send('menu-record-start')},{label:'Stop Recording',accelerator:'CmdOrCtrl+Shift+R',click:()=>send('menu-record-stop')}]},
    {label:'Video',submenu:[{label:'Open Video Window',accelerator:'CmdOrCtrl+Shift+V',click:()=>createVideoWindow()},{label:'Close Video Window',click:()=>{if(videoWindow)videoWindow.close();}},{label:'Toggle Fullscreen',accelerator:'CmdOrCtrl+Shift+F',click:()=>{if(videoWindow&&!videoWindow.isDestroyed())videoWindow.setFullScreen(!videoWindow.isFullScreen());}},{label:'Blackout',accelerator:'CmdOrCtrl+Shift+B',click:()=>{if(videoWindow&&!videoWindow.isDestroyed())videoWindow.webContents.send('video-command',{type:'blackout'});}}]},
    {label:'View',submenu:[{role:'toggleDevTools'},{type:'separator'},{role:'togglefullscreen'}]}
  ];
  if(process.platform==='darwin') t.unshift({label:app.name,submenu:[{role:'about'},{type:'separator'},{role:'quit'}]});
  Menu.setApplicationMenu(Menu.buildFromTemplate(t));
}

app.on('window-all-closed', () => { stopHttpServer(); stopOscServer(); closeMidi(); if(process.platform!=='darwin')app.quit(); });
app.on('activate', () => { if(BrowserWindow.getAllWindows().length===0)createWindow(); });
