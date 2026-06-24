#!/usr/bin/env node
// StageOS Output Daemon v1.1
const dgram = require('dgram');
const http  = require('http');
const { execSync, spawn } = require('child_process');
const { WebSocketServer } = require('ws'); // own dependency now — no longer borrowed from Booth

const state = { displays:[], dmx:{}, streams:[], clients:new Set() };

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  state.clients.forEach(c => { try { c.send(msg); } catch(e) {} });
}

// Art-Net output
const artSocket = dgram.createSocket('udp4');
function sendArtNet(universe, data) {
  const pkt = Buffer.alloc(530);
  pkt.write('Art-Net\0', 0, 'ascii');
  pkt.writeUInt16LE(0x5000, 8); pkt.writeUInt16BE(0x000e, 10);
  pkt[12]=0; pkt[13]=0; pkt.writeUInt16LE(universe-1, 14); pkt.writeUInt16BE(512, 16);
  for (let i=0;i<512;i++) pkt[18+i]=data[i]||0;
  artSocket.send(pkt, 0, 530, 6454, '2.255.255.255');
}

// OSC input
const oscSocket = dgram.createSocket('udp4');
oscSocket.on('message', (msg, rinfo) => {
  broadcast({ type:'osc', from:rinfo.address, len:msg.length });
});
oscSocket.bind(9000, () => console.log('OSC: udp:9000'));

// WebSocket API
const wss = new WebSocketServer({ port: 9001 });
wss.on('connection', c => {
  state.clients.add(c);
  c.send(JSON.stringify({ type:'hello', displays:state.displays }));
  c.on('message', raw => {
    try {
      const cmd = JSON.parse(raw);
      if (cmd.type==='dmx') {
        if (!state.dmx[cmd.universe]) state.dmx[cmd.universe] = new Uint8Array(512);
        cmd.data.forEach((v,i) => state.dmx[cmd.universe][i]=v);
        sendArtNet(cmd.universe, state.dmx[cmd.universe]);
      }
      if (cmd.type==='ping') c.send(JSON.stringify({type:'pong',ts:Date.now()}));

      // ── Event Bus: relay show events between apps ──────────
      // Booth, LightScript, StageFlow, Timecode Pro all connect here.
      // Any app can emit { type:'show-event', event:'cue-fired', data:{...}, source:'booth' }
      // and every OTHER connected app receives it.
      if (cmd.type==='show-event') {
        const out = JSON.stringify({
          type:   'show-event',
          event:  cmd.event,
          data:   cmd.data || {},
          source: cmd.source || 'unknown',
          ts:     Date.now()
        });
        state.clients.forEach(other => {
          if (other !== c) { try { other.send(out); } catch(e) {} }
        });
      }
    } catch(e) {}
  });
  c.on('close', () => state.clients.delete(c));
});

// Display discovery
function discoverDisplays() {
  try {
    const out = execSync('DISPLAY=:0 xrandr --query 2>/dev/null').toString();
    const re = /^(\S+)\s+connected\s+(?:primary\s+)?(\d+x\d+)/gm;
    let m; state.displays = [];
    while ((m=re.exec(out))!==null)
      state.displays.push({ name:m[1], resolution:m[2], role:state.displays.length===0?'Operator':'Stage' });
    broadcast({ type:'displays', displays:state.displays });
  } catch(e) {}
}
setInterval(discoverDisplays, 10000);
discoverDisplays();

// ── App launching ────────────────────────────────────────────
// The launcher UI hits this so clicking a tile actually starts the
// app. Apps live at /opt/stageos/apps/<id> and are real Electron
// apps, so we spawn `electron <dir>` rather than plain `node`.
const runningApps = new Map(); // id -> child process

function launchApp(id) {
  if (runningApps.has(id)) {
    const proc = runningApps.get(id);
    if (!proc.killed) return { ok: true, alreadyRunning: true };
    runningApps.delete(id);
  }
  const appDir = `/opt/stageos/apps/${id}`;
  try {
    const proc = spawn('electron', [appDir], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, DISPLAY: ':0' }
    });
    proc.unref();
    runningApps.set(id, proc);
    proc.on('exit', () => runningApps.delete(id));
    return { ok: true };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

// Status + launch HTTP
const statusServer = http.createServer((req,res) => {
  res.setHeader('Access-Control-Allow-Origin','*');

  if (req.url.startsWith('/launch')) {
    const params = new URLSearchParams(req.url.split('?')[1] || '');
    const id = params.get('id');
    res.setHeader('Content-Type','application/json');
    if (!id) { res.writeHead(400); res.end(JSON.stringify({ok:false,error:'missing id'})); return; }
    const result = launchApp(id);
    res.writeHead(result.ok ? 200 : 500);
    res.end(JSON.stringify(result));
    return;
  }

  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({
    displays: state.displays,
    dmxUniverses: Object.keys(state.dmx),
    runningApps: Array.from(runningApps.keys()),
    uptime: process.uptime()
  }));
});
statusServer.listen(9002, () => console.log('Status+Launch: http:9002'));

console.log('StageOS Output Daemon ready\n  OSC:    udp:9000\n  WS:     ws:9001\n  Status: http:9002');
