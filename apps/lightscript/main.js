const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const fs   = require('fs');
const dgram = require('dgram');

let win;
let oscSocket = null;
let config = { dmx: { artnetIp: '2.255.255.255', universe: 0 }, oscPort: 9000 };
const configPath = path.join(app.getPath('userData'), 'config.json');
if (fs.existsSync(configPath)) { try { Object.assign(config, JSON.parse(fs.readFileSync(configPath))); } catch(e) {} }

function createWindow() {
  win = new BrowserWindow({ width:1400, height:860, minWidth:1000, minHeight:600,
    backgroundColor:'#0a0b0d',
    webPreferences:{ nodeIntegration:false, contextIsolation:true, preload:path.join(__dirname,'preload.js') }
  });
  win.loadFile('index.html');
  Menu.setApplicationMenu(null);
}

app.whenReady().then(() => { createWindow(); startOSC(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

function startOSC() {
  oscSocket = dgram.createSocket('udp4');
  oscSocket.bind(config.oscPort);
  oscSocket.on('message', (msg, rinfo) => {
    try {
      const end = msg.indexOf(0); const addr = msg.slice(0,end>0?end:msg.length).toString();
      win?.webContents.send('osc-in', { address: addr, from: rinfo.address });
    } catch(e) {}
  });
}

function sendArtNet(universe, data) {
  if (!oscSocket) return;
  const packet = Buffer.alloc(530);
  packet.write('Art-Net\0', 0, 'ascii');
  packet.writeUInt16LE(0x5000, 8);
  packet.writeUInt16BE(0x000e, 10);
  packet[12] = 0; packet[13] = 0;
  packet.writeUInt16LE(universe, 14);
  packet.writeUInt16BE(512, 16);
  for (let i=0; i<Math.min(data.length,512); i++) packet[18+i] = data[i]||0;
  oscSocket.send(packet, 0, 530, 6454, config.dmx.artnetIp);
}

function sendOSC(ip, port, address, args=[]) {
  if (!oscSocket) return;
  const padTo4 = s => { const b=Buffer.from(s+'\0'); const p=4-(b.length%4); return p===4?b:Buffer.concat([b,Buffer.alloc(p)]); };
  const addrBuf = padTo4(address);
  let tt=','; const argBufs=[];
  for (const a of args) {
    if (typeof a==='number'&&Number.isInteger(a)) { tt+='i'; const b=Buffer.alloc(4); b.writeInt32BE(a); argBufs.push(b); }
    else if (typeof a==='number') { tt+='f'; const b=Buffer.alloc(4); b.writeFloatBE(a); argBufs.push(b); }
    else { tt+='s'; argBufs.push(padTo4(String(a))); }
  }
  const buf = Buffer.concat([addrBuf, padTo4(tt), ...argBufs]);
  oscSocket.send(buf, 0, buf.length, port, ip);
}

ipcMain.on('dmx', (_, { universe, data }) => sendArtNet(universe||0, data));
ipcMain.on('osc', (_, { ip, port, address, args }) => sendOSC(ip, port, address, args||[]));
ipcMain.handle('get-config', () => config);
