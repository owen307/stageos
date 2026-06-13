const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path  = require('path');
const http  = require('http');
const dgram = require('dgram');
const os    = require('os');
const { WebSocketServer } = require('ws');

let win;
let oscSocket = null;
const wsClients = new Set();
let config = { oscListenPort:9998, httpPort:3141, eos:{ip:'192.168.1.100',port:3032}, m32:{ip:'192.168.1.101',port:10023} };

function createWindow() {
  win = new BrowserWindow({ width:1400, height:860, backgroundColor:'#0a0b0e',
    webPreferences:{ nodeIntegration:false, contextIsolation:true, preload:path.join(__dirname,'preload.js') }
  });
  win.loadFile('index.html');
  Menu.setApplicationMenu(null);
}

app.whenReady().then(() => { createWindow(); startOSC(); startHTTP(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

function padTo4(s) { const b=Buffer.from(s+'\0'); const p=4-(b.length%4); return p===4?b:Buffer.concat([b,Buffer.alloc(p)]); }
function buildOSC(address, args=[]) {
  const aB=padTo4(address); let tt=','; const aGs=[];
  for (const a of args) {
    if (typeof a==='number'&&Number.isInteger(a)){tt+='i';const b=Buffer.alloc(4);b.writeInt32BE(a);aGs.push(b);}
    else if(typeof a==='number'){tt+='f';const b=Buffer.alloc(4);b.writeFloatBE(a);aGs.push(b);}
    else{tt+='s';aGs.push(padTo4(String(a)));}
  }
  return Buffer.concat([aB,padTo4(tt),...aGs]);
}
function sendOSC(ip,port,addr,args) {
  if(!oscSocket)return; const buf=buildOSC(addr,args);
  oscSocket.send(buf,0,buf.length,port,ip);
}
function broadcast(data) {
  const msg=JSON.stringify(data);
  wsClients.forEach(ws=>{try{ws.send(msg);}catch(e){}});
}
function getIP() {
  for (const ifaces of Object.values(os.networkInterfaces()))
    for (const i of ifaces) if(i.family==='IPv4'&&!i.internal) return i.address;
  return '127.0.0.1';
}

function startOSC() {
  oscSocket = dgram.createSocket('udp4');
  oscSocket.bind(config.oscListenPort);
  oscSocket.on('message',(msg,rinfo)=>{
    const e=msg.indexOf(0); const addr=msg.slice(0,e>0?e:msg.length).toString();
    win?.webContents.send('osc-in',{address:addr,from:rinfo.address});
    broadcast({type:'osc',address:addr});
  });
}

function startHTTP() {
  const server = http.createServer((req,res)=>{
    const fp=path.join(__dirname, req.url==='/'?'index.html':req.url);
    const fs=require('fs');
    fs.readFile(fp,(err,data)=>{
      if(err){res.writeHead(404);res.end();return;}
      const types={'.html':'text/html','.js':'text/javascript','.css':'text/css'};
      res.writeHead(200,{'Content-Type':types[path.extname(fp)]||'text/plain'});
      res.end(data);
    });
  });
  const wss = new WebSocketServer({server});
  wss.on('connection',ws=>{
    wsClients.add(ws);
    ws.send(JSON.stringify({type:'config',config}));
    ws.on('message',raw=>{try{handleCmd(JSON.parse(raw));}catch(e){}});
    ws.on('close',()=>wsClients.delete(ws));
  });
  server.listen(config.httpPort,()=>{
    const url=`http://${getIP()}:${config.httpPort}`;
    win?.webContents.send('server-url',url);
  });
}

function handleCmd(cmd) {
  switch(cmd.type) {
    case 'osc': sendOSC(cmd.ip,cmd.port,cmd.address,cmd.args||[]); break;
    case 'eos': sendOSC(config.eos.ip,config.eos.port,`/eos/cmd/${cmd.cmd}`,[]); break;
    case 'm32-fader': sendOSC(config.m32.ip,config.m32.port,`/ch/${cmd.ch}/mix/fader`,[cmd.value]); break;
  }
}

ipcMain.on('command',(_, cmd)=>handleCmd(cmd));
ipcMain.handle('get-config',()=>config);
ipcMain.handle('get-server-url',()=>`http://${getIP()}:${config.httpPort}`);
