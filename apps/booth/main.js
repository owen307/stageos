const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path  = require('path');
const fs    = require('fs');
const http  = require('http');
const dgram = require('dgram');
const os    = require('os');

let mainWindow;
let oscSocket = null;
const wsClients = new Set();
let WebSocketServer;

let config = {
  eos:  { ip: '192.168.1.100', port: 3032  },
  m32:  { ip: '192.168.1.101', port: 10023 },
  atem: { ip: '192.168.1.103', port: 9910  },
  pp:   { ip: '192.168.1.104', port: 50001 },
  oscListenPort: 9999,
  httpPort: 3000
};

const configPath = path.join(app.getPath('userData'), 'config.json');
if (fs.existsSync(configPath)) {
  try { Object.assign(config, JSON.parse(fs.readFileSync(configPath))); } catch(e) {}
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400, height: 860, minWidth: 1000, minHeight: 600,
    backgroundColor: '#0a0b0e',
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
  });
  mainWindow.loadFile('renderer/index.html');
  Menu.setApplicationMenu(null);
}

app.whenReady().then(() => { createWindow(); startOSC(); startHTTP(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

function parseOSCAddress(buf) {
  const end = buf.indexOf(0); return buf.slice(0, end > 0 ? end : buf.length).toString();
}

function padTo4(s) {
  const buf = Buffer.from(s + '\0');
  const pad = 4 - (buf.length % 4);
  return pad === 4 ? buf : Buffer.concat([buf, Buffer.alloc(pad)]);
}

function buildOSC(address, args = []) {
  const addrBuf = padTo4(address);
  let typetag = ','; const argBufs = [];
  for (const a of args) {
    if (typeof a === 'number' && Number.isInteger(a)) {
      typetag += 'i'; const b = Buffer.alloc(4); b.writeInt32BE(a); argBufs.push(b);
    } else if (typeof a === 'number') {
      typetag += 'f'; const b = Buffer.alloc(4); b.writeFloatBE(a); argBufs.push(b);
    } else { typetag += 's'; argBufs.push(padTo4(String(a))); }
  }
  return Buffer.concat([addrBuf, padTo4(typetag), ...argBufs]);
}

function sendOSC(ip, port, address, args) {
  if (!oscSocket) return;
  const buf = buildOSC(address, args);
  oscSocket.send(buf, 0, buf.length, port, ip);
}

function startOSC() {
  oscSocket = dgram.createSocket('udp4');
  oscSocket.bind(config.oscListenPort);
  oscSocket.on('message', (msg, rinfo) => {
    const addr = parseOSCAddress(msg);
    mainWindow?.webContents.send('osc-in', { address: addr, from: rinfo.address });
    broadcast({ type: 'osc', address: addr });
  });
}

function getLocalIP() {
  for (const ifaces of Object.values(os.networkInterfaces()))
    for (const i of ifaces)
      if (i.family === 'IPv4' && !i.internal) return i.address;
  return '127.0.0.1';
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  wsClients.forEach(ws => { try { ws.send(msg); } catch(e) {} });
}

function startHTTP() {
  try { WebSocketServer = require('ws').WebSocketServer; } catch(e) { return; }
  const server = http.createServer((req, res) => {
    const filePath = path.join(__dirname, 'renderer', req.url === '/' ? 'index.html' : req.url);
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      const ext = path.extname(filePath);
      const types = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png'};
      res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
      res.end(data);
    });
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', ws => {
    wsClients.add(ws);
    ws.send(JSON.stringify({ type: 'config', config }));
    ws.on('message', raw => { try { handleCmd(JSON.parse(raw)); } catch(e) {} });
    ws.on('close', () => wsClients.delete(ws));
  });
  server.listen(config.httpPort, () => {
    mainWindow?.webContents.send('server-url', `http://${getLocalIP()}:${config.httpPort}`);
  });
}

function handleCmd(cmd) {
  switch(cmd.type) {
    case 'osc':         sendOSC(cmd.ip||config.eos.ip, cmd.port||config.eos.port, cmd.address, cmd.args||[]); break;
    case 'eos-cmd':     sendOSC(config.eos.ip,  config.eos.port,  `/eos/cmd/${cmd.cmd}`, []); break;
    case 'm32-fader':   sendOSC(config.m32.ip,  config.m32.port,  `/ch/${cmd.ch}/mix/fader`, [cmd.value]); break;
    case 'm32-mute':    sendOSC(config.m32.ip,  config.m32.port,  `/ch/${cmd.ch}/mix/on`, [cmd.on?1:0]); break;
    case 'atem-cut':    sendOSC(config.atem.ip, config.atem.port, '/atem/cut', []); break;
    case 'atem-input':  sendOSC(config.atem.ip, config.atem.port, '/atem/preview', [cmd.input]); break;
    case 'pp-next':     sendOSC(config.pp.ip,   config.pp.port,   '/pro7/triggerNextSlide', []); break;
    case 'pp-prev':     sendOSC(config.pp.ip,   config.pp.port,   '/pro7/triggerPreviousSlide', []); break;
    case 'config-update':
      Object.assign(config, cmd.config);
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      broadcast({ type: 'config', config }); break;
  }
}

ipcMain.on('command', (_, cmd) => handleCmd(cmd));
ipcMain.handle('get-config', () => config);
ipcMain.handle('get-server-url', () => `http://${getLocalIP()}:${config.httpPort}`);
