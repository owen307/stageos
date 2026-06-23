'use strict';

/**
 * LightScript USB DMX Engine  —  ZERO npm dependencies
 * ─────────────────────────────────────────────────────────────────────────────
 * All serial I/O uses Node's built-in `fs` module to open the port as a raw
 * file descriptor and write bytes at OS level.  No native addons, no node-gyp,
 * compiles on Node 18-24 on macOS, Windows, Linux, and Raspberry Pi.
 *
 * Art-Net uses Node's built-in `dgram` (UDP) — also zero deps.
 *
 * Supported interfaces
 * ────────────────────
 *  enttec-pro       Enttec USB DMX Pro  (and DMXKing USB512-A clones)
 *                   → Widget-API protocol over USB-serial at 57600 baud
 *  enttec-open      Enttec Open DMX USB  (passive FTDI dongle)
 *                   → Raw DMX break + data over USB-serial at 250000 baud
 *  artnet           Art-Net over Ethernet/WiFi  (UDP, built-in dgram)
 *  null             Software-only, no hardware needed
 *
 * How the serial write works (macOS / Linux)
 * ──────────────────────────────────────────
 *  1.  Open the device path (e.g. /dev/tty.usbserial-*) with O_RDWR|O_NOCTTY|O_NONBLOCK
 *  2.  Use child_process.execFileSync('stty') to configure baud rate / line discipline
 *  3.  Write raw bytes via fs.write() into the fd
 *
 * How it works on Windows
 * ───────────────────────
 *  Same fd approach — Windows allows opening COM ports as files.
 *  Baud rate is set with `mode COMx BAUD=57600 PARITY=n DATA=8 STOP=1`.
 */

const fs    = require('fs');
const dgram = require('dgram');
const { execFileSync, execSync } = require('child_process');
const os    = require('os');

const IS_WIN   = process.platform === 'win32';
const IS_MAC   = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

// ── Interface catalogue ───────────────────────────────────────────────────────
const INTERFACES = {
  'enttec-pro': {
    label:       'Enttec USB DMX Pro',
    description: 'Professional dongle with optical isolation. Also compatible with DMXKing USB512-A.',
    needsPort: true,
    needsIp:   false,
  },
  'enttec-open': {
    label:       'Enttec Open DMX USB',
    description: 'Low-cost FTDI dongle (~$30). Passive — reliable on modern machines.',
    needsPort: true,
    needsIp:   false,
  },
  'artnet': {
    label:       'Art-Net (Ethernet / WiFi)',
    description: 'Sends Art-Net UDP packets to any ArtNet node or dimmer rack on your network.',
    needsPort: false,
    needsIp:   true,
  },
  'null': {
    label:       'Software (No Output)',
    description: 'No hardware. DMX values tracked internally. Good for programming without gear.',
    needsPort: false,
    needsIp:   false,
  },
};

// ── Serial port scanner ───────────────────────────────────────────────────────
async function listSerialPorts() {
  const ports = [];
  try {
    if (IS_WIN) {
      // Use PowerShell to get full port list with friendly names
      let psOut = '';
      try {
        psOut = execSync(
          'powershell -NoProfile -Command "Get-PnpDevice -Class Ports -Status OK | Select-Object FriendlyName,InstanceId | ConvertTo-Json -Compress"',
          { encoding:'utf8', timeout:5000 }
        );
      } catch(_) {
        // Fallback: registry query
        try {
          psOut = execSync('reg query HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM', { encoding:'utf8', timeout:3000 });
          const matches = [...psOut.matchAll(/REG_SZ\s+(COM\d+)/g)];
          matches.forEach(m => ports.push({ path:m[1], manufacturer:'', isDMX:false }));
          return ports;
        } catch(_) { return ports; }
      }

      // Parse PowerShell JSON output
      let devices = [];
      try { devices = JSON.parse(psOut); if (!Array.isArray(devices)) devices = [devices]; } catch(_) {}
      devices.forEach(d => {
        const name = d.FriendlyName || '';
        const comMatch = name.match(/\(COM(\d+)\)/);
        if (!comMatch) return;
        const comNum  = comMatch[1];
        const path    = `COM${comNum}`;
        const isDMX   = /arduino|ch340|ch341|cp210|ftdi|enttec|usb.*serial|serial.*usb/i.test(name);
        ports.push({ path, manufacturer: name.replace(/\s*\(COM\d+\)/, '').trim(), isDMX });
      });
    } else {
      // macOS / Linux: list /dev/tty.* and /dev/ttyUSB* /dev/ttyACM*
      const devDir = IS_MAC ? '/dev' : '/dev';
      const entries = fs.readdirSync(devDir);
      const patterns = IS_MAC
        ? [/^tty\.usbserial/i, /^tty\.usbmodem/i, /^tty\.FTDI/i, /^tty\.Enttec/i]
        : [/^ttyUSB/, /^ttyACM/, /^ttyS[0-3]$/];
      entries.forEach(e => {
        if (patterns.some(r => r.test(e))) {
          const path = `/dev/${e}`;
          const isDMX = /usb|FTDI|ftdi|enttec|ch34|cp21/i.test(e);
          ports.push({ path, manufacturer:'', isDMX });
        }
      });
    }
  } catch (_) {}
  return ports;
}

// ── Low-level serial open / configure / write ─────────────────────────────────
// Windows serial ports need the \\.\COMn path format and can't use fs.openSync
// the same way. We use a PowerShell-based write for Windows.

// Windows: write bytes to COM port using PowerShell .NET SerialPort
let _winPsMap = {}; // portPath -> { proc, write }

function openWinPort(portPath, baud) {
  const comName = portPath.replace(/^\\\\\.\\/,'').replace(/^.*\\/,''); // extract COMn
  // We'll use a persistent PowerShell process to write to the port
  // PowerShell script: opens port, reads hex bytes from stdin, writes to port
  const ps = require('child_process').spawn('powershell', ['-NoProfile','-NonInteractive','-Command',`
$port = New-Object System.IO.Ports.SerialPort('${comName}',${baud},'None',8,1)
$port.WriteTimeout = 500
$port.Open()
$stdin = [Console]::OpenStandardInput()
$buf = New-Object byte[] 4096
while($true){$n=$stdin.Read($buf,0,4096);if($n -le 0){break};$port.Write($buf,0,$n)}
$port.Close()
  `.trim()], { stdio:['pipe','pipe','pipe'] });

  ps.on('error', e => console.error('[DMX Win] PS error:', e.message));
  ps.stderr.on('data', d => console.error('[DMX Win] PS stderr:', d.toString()));

  return {
    ps,
    write: (buf) => {
      try { ps.stdin.write(buf); return true; }
      catch(e) { console.error('[DMX Win] write error:', e.message); return false; }
    },
    close: () => { try { ps.stdin.end(); ps.kill(); } catch(_) {} }
  };
}

function openSerialFd(portPath, baud) {
  if (IS_WIN) {
    // Use PowerShell approach for Windows
    const handle = openWinPort(portPath, baud);
    _winPsMap[portPath] = handle;
    // Return a fake fd — Windows writes go through the PS process
    return { _win: true, portPath };
  }

  let fd;
  try {
    fd = fs.openSync(portPath, fs.constants.O_RDWR | fs.constants.O_NOCTTY);
  } catch (e) {
    throw new Error(`Cannot open port ${portPath}: ${e.message}`);
  }

  try {
    execFileSync('stty', ['-F', portPath, String(baud), 'raw', 'cs8', '-cstopb', '-parenb'], { timeout:2000 });
  } catch (e) {
    console.warn('[DMX] stty warning (non-fatal):', e.message);
  }
  return fd;
}

function closeSerialFd(fd) {
  if (!fd) return;
  if (fd._win) {
    const handle = _winPsMap[fd.portPath];
    if (handle) { handle.close(); delete _winPsMap[fd.portPath]; }
    return;
  }
  try { fs.closeSync(fd); } catch(_) {}
}

function writeSerialFd(fd, buf) {
  if (!fd) return false;
  if (fd._win) {
    const handle = _winPsMap[fd.portPath];
    return handle ? handle.write(buf) : false;
  }
  try { fs.writeSync(fd, buf, 0, buf.length); return true; }
  catch(e) { console.error('[DMX] write error:', e.message); return false; }
}

// ── Enttec Pro protocol (Widget API) ──────────────────────────────────────────
// Packet: 0x7E [label] [len_lo] [len_hi] [data...] 0xE7
function buildEnttecProPacket(dmxBuf) {
  const label  = 6;   // "Send DMX Packet" command
  const len    = dmxBuf.length + 1; // +1 for start code
  const pkt    = Buffer.alloc(5 + len);
  pkt[0] = 0x7E;
  pkt[1] = label;
  pkt[2] = len & 0xFF;
  pkt[3] = (len >> 8) & 0xFF;
  pkt[4] = 0x00;  // DMX start code
  dmxBuf.copy(pkt, 5);
  pkt[pkt.length - 1] = 0xE7;
  return pkt;
}

// ── Enttec Open DMX USB (raw break + MAB + DMX data at 250kbaud) ──────────────
// The Open dongle has no microcontroller — we must generate the DMX break
// ourselves by briefly switching to a very low baud rate (76800 stops being
// decoded as valid 250k data, giving us a long enough break), sending 0x00,
// then switching back.  This is the standard technique for all FTDI-based
// passive dongles.
function sendEnttecOpenFrame(fd, portPath, dmxBuf) {
  if (IS_WIN) {
    // On Windows via PowerShell, we can't do baud-switch break
    // Send a null byte pattern that works as a soft break with most FTDI dongles
    const frame = Buffer.alloc(dmxBuf.length + 1);
    frame[0] = 0x00;
    dmxBuf.copy(frame, 1);
    return writeSerialFd(fd, frame);
  }

  // macOS / Linux: baud-switch break
  try {
    execFileSync('stty', ['-F', portPath, '76800', 'raw', 'cs8'], { timeout:500 });
    writeSerialFd(fd, Buffer.from([0x00]));
  } catch(_) {}
  try {
    execFileSync('stty', ['-F', portPath, '250000', 'raw', 'cs8', 'cstopb'], { timeout:500 });
  } catch(_) {}
  const frame = Buffer.alloc(dmxBuf.length + 1);
  frame[0] = 0x00;
  dmxBuf.copy(frame, 1);
  return writeSerialFd(fd, frame);
}

// ── Art-Net ───────────────────────────────────────────────────────────────────
let artnetSocket = null;
let artnetSeqNum = 0;

function buildArtnetPacket(universe, dmxBuf) {
  const pkt = Buffer.alloc(18 + dmxBuf.length);
  // Art-Net header
  Buffer.from('Art-Net\0').copy(pkt, 0);
  pkt.writeUInt16LE(0x5000, 8);          // OpOutput = 0x5000
  pkt.writeUInt16BE(0x000e, 10);         // Protocol version 14
  pkt[12] = artnetSeqNum++ & 0xFF;       // Sequence
  pkt[13] = 0;                            // Physical
  pkt.writeUInt16LE(universe & 0x7FFF, 14); // Universe (little-endian, 15-bit)
  pkt.writeUInt16BE(dmxBuf.length, 16);  // Length (big-endian)
  dmxBuf.copy(pkt, 18);
  return pkt;
}

function ensureArtnetSocket() {
  if (artnetSocket) return artnetSocket;
  artnetSocket = dgram.createSocket('udp4');
  artnetSocket.bind(() => {
    try { artnetSocket.setBroadcast(true); } catch(_) {}
  });
  artnetSocket.on('error', e => { console.error('[ArtNet]', e.message); });
  return artnetSocket;
}

// ── Main engine class ─────────────────────────────────────────────────────────
class USBDMXEngine {
  constructor() {
    this.interfaceId = null;
    this.portPath    = null;
    this.targetIp    = null;
    this.universe    = 0;   // 0-indexed Art-Net universe
    this.fd          = null;
    this.connected   = false;
    this.pushBusy    = false;
    this.dmxBuf      = Buffer.alloc(512, 0);
    this.stats       = { framesSent:0, errors:0, connectedAt:null };
  }

  static getInterfaces() { return INTERFACES; }
  static listSerialPorts() { return listSerialPorts(); }

  connect(interfaceId, portOrIp, opts = {}) {
    if (this.connected) this.disconnect();

    if (!INTERFACES[interfaceId]) return { ok:false, error:`Unknown interface "${interfaceId}"` };
    this.interfaceId = interfaceId;
    this.universe    = (opts.universe || 1) - 1; // convert to 0-indexed

    try {
      if (interfaceId === 'enttec-pro') {
        this.fd       = openSerialFd(portOrIp, 57600);
        this.portPath = portOrIp;
        // Send "Get Widget Parameters" to verify it's an Enttec Pro
        const ping = Buffer.from([0x7E, 0x03, 0x00, 0x00, 0xE7]);
        writeSerialFd(this.fd, ping);
      }
      else if (interfaceId === 'enttec-open') {
        // Initial open at 250k — sendEnttecOpenFrame handles break timing
        this.fd       = openSerialFd(portOrIp, 250000);
        this.portPath = portOrIp;
      }
      else if (interfaceId === 'artnet') {
        this.targetIp = portOrIp || '255.255.255.255';
        ensureArtnetSocket();
      }
      else if (interfaceId === 'null') {
        // no-op
      }

      this.connected = true;
      this.stats.connectedAt = Date.now();
      this.stats.framesSent  = 0;
      this.stats.errors      = 0;
      console.log(`[DMX] Connected: ${INTERFACES[interfaceId].label} @ ${portOrIp || 'N/A'}`);
      return { ok:true };

    } catch (e) {
      this.fd = null; this.connected = false;
      console.error('[DMX] connect error:', e.message);
      return { ok:false, error:e.message };
    }
  }

  // Build DMX buffer from fixtures array
  _buildBuffer(fixtures) {
    this.dmxBuf.fill(0);
    fixtures.forEach(f => {
      const base = (f.address || 1) - 1;

      // Use GDTF channel map if available
      if (f.gdtf && f.gdtfChannels && f.gdtfChannels.length > 0) {
        const vals = {
          dimmer: f.dimmer ?? 0, red: f.red ?? 255, green: f.green ?? 255, blue: f.blue ?? 255,
          white: f.white ?? 0, amber: f.amber ?? 0, uv: f.uv ?? 0,
          pan: f.pan ?? 127, tilt: f.tilt ?? 127, panFine: f.panFine ?? 0, tiltFine: f.tiltFine ?? 0,
          gobo: f.gobo ?? 0, color: f.color ?? 0, shutter: f.shutter ?? 255,
          strobe: f.strobe ?? 0, zoom: f.zoom ?? 127, focus: f.focus ?? 127,
          iris: f.iris ?? 0, prism: f.prism ?? 0, frost: f.frost ?? 0, speed: f.speed ?? 128,
        };
        f.gdtfChannels.forEach(ch => {
          if (!ch.param || ch.offset == null) return;
          const addr = base + (ch.offset - 1); // offset is 1-indexed
          if (addr >= 0 && addr < 512) {
            this.dmxBuf[addr] = Math.max(0, Math.min(255, Math.round(vals[ch.param] ?? 0)));
          }
        });
        return; // done with this fixture
      }

      // Generic fallback — only write channels the fixture actually has
      // Don't write values for channels that aren't part of the fixture's footprint
      const chCount = f.channels || 8;
      const genericVals = [
        f.dimmer ?? 0, f.red ?? 255, f.green ?? 255, f.blue ?? 255,
        f.pan ?? 127, f.tilt ?? 127, f.gobo ?? 0, f.color ?? 0,
        f.shutter ?? 255, f.zoom ?? 127, f.strobe ?? 0, f.focus ?? 127,
      ];
      for (let i = 0; i < Math.min(chCount, genericVals.length); i++) {
        const ch = base + i;
        if (ch >= 0 && ch < 512) this.dmxBuf[ch] = Math.max(0, Math.min(255, Math.round(genericVals[i])));
      }
    });
  }

  applyFixtures(fixtures) {
    if (!this.connected || this.pushBusy) return;
    this.pushBusy = true;
    try {
      this._buildBuffer(fixtures);
      this._sendFrame();
    } finally {
      this.pushBusy = false;
    }
  }

  setBuffer(data) {
    // data: Array or Uint8Array — raw pre-built DMX output (up to 512 bytes)
    if (!this.connected) return;
    const len = Math.min(data.length, 512);
    for (let i = 0; i < len; i++) this.dmxBuf[i] = data[i];
    this._sendFrame();
  }

  setChannel(channel, value) {
    if (!this.connected) return;
    const ch = Math.max(0, Math.min(511, channel - 1));
    this.dmxBuf[ch] = Math.max(0, Math.min(255, Math.round(value)));
    this._sendFrame();
  }

  blackout() {
    if (!this.connected) return;
    this.dmxBuf.fill(0);
    this._sendFrame();
  }

  _sendFrame() {
    try {
      if (this.interfaceId === 'enttec-pro') {
        const pkt = buildEnttecProPacket(this.dmxBuf);
        if (writeSerialFd(this.fd, pkt)) this.stats.framesSent++;
        else this.stats.errors++;
      }
      else if (this.interfaceId === 'enttec-open') {
        if (sendEnttecOpenFrame(this.fd, this.portPath, this.dmxBuf)) this.stats.framesSent++;
        else this.stats.errors++;
      }
      else if (this.interfaceId === 'artnet') {
        const pkt = buildArtnetPacket(this.universe, this.dmxBuf);
        ensureArtnetSocket().send(pkt, 6454, this.targetIp, err => {
          if (err) this.stats.errors++; else this.stats.framesSent++;
        });
      }
      else if (this.interfaceId === 'null') {
        this.stats.framesSent++;
      }
    } catch(e) {
      this.stats.errors++;
      console.error('[DMX] send error:', e.message);
    }
  }

  disconnect() {
    if (!this.connected) return;
    try { this.blackout(); } catch(_) {}
    closeSerialFd(this.fd);
    this.fd        = null;
    this.connected = false;
    console.log('[DMX] Disconnected');
  }

  getStatus() {
    const iface = INTERFACES[this.interfaceId];
    const upMs  = this.stats.connectedAt ? Date.now() - this.stats.connectedAt : 0;
    const s     = Math.floor(upMs / 1000);
    return {
      connected:      this.connected,
      interfaceId:    this.interfaceId || null,
      interfaceLabel: iface ? iface.label : null,
      portOrIp:       this.portPath || this.targetIp || null,
      framesSent:     this.stats.framesSent,
      errors:         this.stats.errors,
      uptime: `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor((s%3600)/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`,
    };
  }
}

module.exports = { USBDMXEngine, INTERFACES };
