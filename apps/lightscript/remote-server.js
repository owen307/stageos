'use strict';
const http   = require('http');
const crypto = require('crypto');
const os     = require('os');
const fs     = require('fs');
const path   = require('path');

// ── WebSocket frame parser/builder ────────────────────────────────────────────
function wsHandshake(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return false; }
  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  return true;
}

function wsSend(socket, data) {
  if (socket.destroyed) return;
  try {
    const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2); header[0] = 0x81; header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
    }
    socket.write(Buffer.concat([header, payload]));
  } catch(e) {}
}

function wsParseFrame(buf) {
  if (buf.length < 2) return null;
  const op   = buf[0] & 0x0f;
  const mask = (buf[1] & 0x80) !== 0;
  let len    = buf[1] & 0x7f;
  let offset = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); offset = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
  if (buf.length < offset + (mask ? 4 : 0) + len) return null;
  let maskKey = null;
  if (mask) { maskKey = buf.slice(offset, offset + 4); offset += 4; }
  const payload = buf.slice(offset, offset + len);
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
  return { op, payload, consumed: offset + len };
}

// ── Remote Server ─────────────────────────────────────────────────────────────
class RemoteServer {
  constructor() {
    this.server    = null;
    this.clients   = new Set();   // authenticated sockets
    this.pending   = new Set();   // unauthenticated sockets
    this.port      = 8080;
    this.running   = false;
    this.passcode  = '';          // '' = no passcode
    this.onCommand = null;
    this._lastState = null;
  }

  start(port = 8080, passcode = '') {
    if (this.running) return { ok: true, port: this.port, urls: this._getUrls() };
    this.port     = port;
    this.passcode = passcode || '';

    this.server = http.createServer((req, res) => {
      if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getRemoteHTML());
      } else if (req.url === '/state') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(this._lastState ? JSON.stringify(this._lastState) : '{}');
      } else {
        res.writeHead(404); res.end('Not found');
      }
    });

    this.server.on('upgrade', (req, socket) => {
      if (req.url !== '/ws') { socket.destroy(); return; }
      if (!wsHandshake(req, socket)) return;
      socket._wsBuf   = Buffer.alloc(0);
      socket._authed  = !this.passcode; // auto-auth if no passcode
      if (socket._authed) {
        this.clients.add(socket);
        if (this._lastState) wsSend(socket, { type:'state', ...this._lastState });
      } else {
        this.pending.add(socket);
        wsSend(socket, { type:'auth_required' });
      }

      socket.on('data', (chunk) => {
        socket._wsBuf = Buffer.concat([socket._wsBuf, chunk]);
        while (true) {
          const frame = wsParseFrame(socket._wsBuf);
          if (!frame) break;
          socket._wsBuf = socket._wsBuf.slice(frame.consumed);
          if (frame.op === 8) { this._removeSocket(socket); socket.destroy(); break; }
          if (frame.op === 9) { wsSend(socket, Buffer.from([0x8a, 0x00])); continue; }
          if (frame.op === 1 || frame.op === 2) {
            try {
              const msg = JSON.parse(frame.payload.toString());
              if (!socket._authed) {
                if (msg.type === 'auth' && msg.passcode === this.passcode) {
                  socket._authed = true;
                  this.pending.delete(socket);
                  this.clients.add(socket);
                  wsSend(socket, { type:'auth_ok' });
                  if (this._lastState) wsSend(socket, { type:'state', ...this._lastState });
                } else {
                  wsSend(socket, { type:'auth_fail' });
                }
                continue;
              }
              if (msg.cmd && this.onCommand) this.onCommand(msg.cmd);
              if (msg.type === 'ping') wsSend(socket, { type:'pong' });
            } catch(e) {}
          }
        }
      });
      socket.on('close', () => this._removeSocket(socket));
      socket.on('error', () => { this._removeSocket(socket); socket.destroy(); });
    });

    this.server.listen(port, '0.0.0.0', () => { this.running = true; });
    this.server.on('error', () => { this.running = false; });
    return { ok: true, port, urls: this._getUrls() };
  }

  _removeSocket(s) { this.clients.delete(s); this.pending.delete(s); }

  stop() {
    [...this.clients, ...this.pending].forEach(s => { try { s.destroy(); } catch(e) {} });
    this.clients.clear(); this.pending.clear();
    if (this.server) { this.server.close(); this.server = null; }
    this.running = false;
  }

  broadcast(state) {
    this._lastState = state;
    if (!this.clients.size) return;
    const msg = { type: 'state', ...state };
    this.clients.forEach(s => wsSend(s, msg));
  }

  setPasscode(p) { this.passcode = p || ''; }

  _getUrls() {
    const urls = [`http://localhost:${this.port}`];
    try {
      Object.values(os.networkInterfaces()).flat().forEach(iface => {
        if (iface.family === 'IPv4' && !iface.internal)
          urls.push(`http://${iface.address}:${this.port}`);
      });
    } catch(e) {}
    return urls;
  }

  getStatus() {
    return { running: this.running, port: this.port, clients: this.clients.size, urls: this._getUrls(), hasPasscode: !!this.passcode };
  }
}

function getRemoteHTML() {
  return fs.readFileSync(path.join(__dirname, 'src', 'remote.html'), 'utf8');
}

module.exports = { RemoteServer };


function getRemoteHTML() {
  return fs.readFileSync(path.join(__dirname, 'src', 'remote.html'), 'utf8');
}

module.exports = { RemoteServer };
