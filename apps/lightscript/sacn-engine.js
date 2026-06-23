'use strict';

/**
 * LightScript sACN Engine
 * Implements ANSI E1.31 (sACN) — DMX over UDP multicast.
 * Runs entirely in the Electron main process (Node.js).
 *
 * Each universe maps to multicast group 239.255.0.<universe>
 * UDP port 5568 (standard sACN port).
 */

const dgram  = require('dgram');
const os     = require('os');

// ─── E1.31 CONSTANTS ──────────────────────────────────────────────────────────
const SACN_PORT         = 5568;
const SACN_PRIORITY_DEFAULT = 100;

// Generate a CID (component identifier) — 16 random bytes, fixed per session
function makeCID() {
  const b = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  return b;
}

const SESSION_CID = makeCID();

// Sequence numbers per universe (0–255 wrapping)
const seqNums = {};

/**
 * Build a valid E1.31 sACN data packet.
 * Returns a Buffer ready to send via UDP.
 */
function buildSACNPacket(universe, dmxData, priority, sourceName, seqNum) {
  // dmxData: Uint8Array or Buffer of 512 bytes
  const src = Buffer.from((sourceName || 'LightScript').padEnd(64).slice(0, 64), 'ascii');

  // ── Root Layer ────────────────────────────────────────────────────────────
  // Preamble + postamble + ACN Packet Identifier + flags+length + vector + CID
  const ACN_ID = Buffer.from([
    0x41,0x53,0x43,0x2d,0x45,0x31,0x31,0x37,
    0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
  ]);

  const VECTOR_ROOT_E131_DATA = Buffer.from([0x00,0x00,0x00,0x04]);

  // ── Framing Layer ─────────────────────────────────────────────────────────
  const VECTOR_E131_DATA_PACKET = Buffer.from([0x00,0x00,0x00,0x02]);

  // ── DMP Layer ─────────────────────────────────────────────────────────────
  const VECTOR_DMP_SET_PROPERTY = 0x02;
  const ADDRESS_TYPE_AND_DATA_TYPE = 0xa1; // absolute, range, single octet
  const FIRST_PROP_ADDR = Buffer.from([0x00,0x00]);
  const ADDRESS_INCREMENT = Buffer.from([0x00,0x01]);
  const PROP_COUNT = 513; // start code + 512 channels

  const dmx512 = Buffer.alloc(512);
  if (dmxData) dmxData.copy ? dmxData.copy(dmx512) : dmx512.set(dmxData.slice(0,512));
  const startCodeAndData = Buffer.concat([Buffer.from([0x00]), dmx512]); // start code 0

  // Compute lengths (flags = 0x70 | high nibble of length)
  const dmpLen      = 11 + PROP_COUNT;
  const framingLen  = 77 + dmpLen;
  const rootLen     = 16 + framingLen;
  const totalLen    = 16 + rootLen;

  const flagLen = (len) => {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(0x7000 | (len & 0x0fff));
    return b;
  };

  const pkt = Buffer.alloc(totalLen);
  let o = 0;

  // Root layer preamble
  pkt.writeUInt16BE(0x0010, o); o += 2; // preamble size
  pkt.writeUInt16BE(0x0000, o); o += 2; // postamble size
  ACN_ID.copy(pkt, o); o += 16;          // ACN packet identifier (padded)

  // Root flags+len
  flagLen(rootLen).copy(pkt, o); o += 2;
  VECTOR_ROOT_E131_DATA.copy(pkt, o); o += 4;
  SESSION_CID.copy(pkt, o); o += 16;

  // Framing layer
  flagLen(framingLen).copy(pkt, o); o += 2;
  VECTOR_E131_DATA_PACKET.copy(pkt, o); o += 4;
  src.copy(pkt, o); o += 64;            // source name
  pkt[o++] = priority & 0xff;           // priority
  pkt.writeUInt16BE(0x0000, o); o += 2; // synchronization address (none)
  pkt[o++] = seqNum & 0xff;             // sequence number
  pkt[o++] = 0x00;                      // options
  pkt.writeUInt16BE(universe & 0xffff, o); o += 2; // universe

  // DMP layer
  flagLen(dmpLen).copy(pkt, o); o += 2;
  pkt[o++] = VECTOR_DMP_SET_PROPERTY;
  pkt[o++] = ADDRESS_TYPE_AND_DATA_TYPE;
  FIRST_PROP_ADDR.copy(pkt, o); o += 2;
  ADDRESS_INCREMENT.copy(pkt, o); o += 2;
  pkt.writeUInt16BE(PROP_COUNT, o); o += 2;
  startCodeAndData.copy(pkt, o); o += PROP_COUNT;

  return pkt;
}

function multicastAddr(universe) {
  // E1.31 §9.3: 239.255.<hi>.<lo> where universe is 16-bit
  const hi = (universe >> 8) & 0xff;
  const lo = universe & 0xff;
  return `239.255.${hi}.${lo}`;
}

// ─── ENGINE CLASS ─────────────────────────────────────────────────────────────
class SACNEngine {
  constructor() {
    this.socket        = null;
    this.running       = false;
    this.universes     = {};   // universeNum → Buffer(512)
    this.priority      = SACN_PRIORITY_DEFAULT;
    this.sourceName    = 'LightScript';
    this.sendInterval  = null;
    this.fps           = 40;   // frames per second
    this.networkIface  = null; // null = auto
    this.stats = {
      packetsSent: 0,
      errors: 0,
      startTime: null,
    };
  }

  /** Start the sACN engine */
  start(options = {}) {
    if (this.running) return { ok: false, error: 'Already running' };

    if (options.priority)   this.priority   = options.priority;
    if (options.sourceName) this.sourceName = options.sourceName;
    if (options.fps)        this.fps        = Math.max(1, Math.min(44, options.fps));
    if (options.iface)      this.networkIface = options.iface;

    try {
      this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      this.socket.on('error', (err) => {
        this.stats.errors++;
        console.error('[sACN] UDP error:', err.message);
      });

      this.socket.bind(() => {
        try {
          this.socket.setBroadcast(true);
          this.socket.setMulticastTTL(8);
          if (this.networkIface) {
            this.socket.setMulticastInterface(this.networkIface);
          }
        } catch (e) {
          // Non-fatal — some platforms are more permissive
          console.warn('[sACN] Multicast config warning:', e.message);
        }
      });

      this.running      = true;
      this.stats.startTime = Date.now();
      this.stats.packetsSent = 0;
      this.stats.errors = 0;

      const intervalMs = Math.round(1000 / this.fps);
      this.sendInterval = setInterval(() => this._sendAll(), intervalMs);

      console.log(`[sACN] Engine started — ${this.fps} fps, priority ${this.priority}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /** Stop the sACN engine and blackout all universes */
  stop() {
    if (!this.running) return;
    clearInterval(this.sendInterval);
    this.sendInterval = null;

    // Send a few blackout frames before closing
    Object.keys(this.universes).forEach(u => {
      const universe = parseInt(u);
      this._sendUniverse(universe, Buffer.alloc(512));
    });

    setTimeout(() => {
      if (this.socket) {
        try { this.socket.close(); } catch(_) {}
        this.socket = null;
      }
    }, 100);

    this.running = false;
    console.log('[sACN] Engine stopped');
  }

  /** Set a single channel value (1-indexed channel within universe) */
  setChannel(universe, channel, value) {
    if (!this.universes[universe]) this.universes[universe] = Buffer.alloc(512);
    if (channel >= 1 && channel <= 512) {
      this.universes[universe][channel - 1] = Math.max(0, Math.min(255, Math.round(value)));
    }
  }

  /** Set a full universe buffer (Buffer or Uint8Array of 512 bytes) */
  setUniverse(universe, data) {
    if (!this.universes[universe]) this.universes[universe] = Buffer.alloc(512);
    const src = Buffer.isBuffer(data) ? data : Buffer.from(data);
    src.copy(this.universes[universe], 0, 0, Math.min(512, src.length));
  }

  /** Apply a fixture's parameter values to its DMX address */
  applyFixture(fixture) {
    const base    = (fixture.address || 1) - 1; // 0-indexed
    const universe = Math.floor(base / 512) + 1;
    const offset   = base % 512;

    if (!this.universes[universe]) this.universes[universe] = Buffer.alloc(512);
    const buf = this.universes[universe];

    // Generic multi-channel layout:
    // Ch1: dimmer, Ch2: red, Ch3: green, Ch4: blue,
    // Ch5: pan, Ch6: tilt, Ch7: gobo, Ch8: color,
    // Ch9: shutter, Ch10: zoom, Ch11: strobe, Ch12: focus
    const vals = [
      fixture.dimmer  ?? 0,
      fixture.red     ?? 255,
      fixture.green   ?? 255,
      fixture.blue    ?? 255,
      fixture.pan     ?? 127,
      fixture.tilt    ?? 127,
      fixture.gobo    ?? 0,
      fixture.color   ?? 0,
      fixture.shutter ?? 255,
      fixture.zoom    ?? 127,
      fixture.strobe  ?? 0,
      fixture.focus   ?? 127,
    ];

    vals.forEach((v, i) => {
      const ch = offset + i;
      if (ch < 512) buf[ch] = Math.max(0, Math.min(255, Math.round(v)));
    });
  }

  /** Blackout — zero all universes instantly */
  blackout() {
    Object.keys(this.universes).forEach(u => {
      this.universes[u].fill(0);
    });
  }

  /** Get engine stats for the UI */
  getStats() {
    const upMs = this.stats.startTime ? Date.now() - this.stats.startTime : 0;
    const upSec = Math.floor(upMs / 1000);
    const hh = String(Math.floor(upSec / 3600)).padStart(2,'0');
    const mm = String(Math.floor((upSec % 3600) / 60)).padStart(2,'0');
    const ss = String(upSec % 60).padStart(2,'0');
    return {
      running:      this.running,
      fps:          this.fps,
      priority:     this.priority,
      universeCount: Object.keys(this.universes).length,
      packetsSent:  this.stats.packetsSent,
      errors:       this.stats.errors,
      uptime:       `${hh}:${mm}:${ss}`,
      sourceName:   this.sourceName,
    };
  }

  /** List available network interfaces */
  static getNetworkInterfaces() {
    const ifaces = os.networkInterfaces();
    const result = [];
    Object.entries(ifaces).forEach(([name, addrs]) => {
      addrs.forEach(addr => {
        if (addr.family === 'IPv4' && !addr.internal) {
          result.push({ name, address: addr.address });
        }
      });
    });
    return result;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _sendAll() {
    if (!this.running || !this.socket) return;
    const universeNums = Object.keys(this.universes);
    // If no universes registered yet, still keep socket alive
    if (universeNums.length === 0) return;
    universeNums.forEach(u => {
      this._sendUniverse(parseInt(u), this.universes[u]);
    });
  }

  _sendUniverse(universe, data) {
    if (!seqNums[universe]) seqNums[universe] = 0;
    seqNums[universe] = (seqNums[universe] + 1) % 256;

    const pkt  = buildSACNPacket(universe, data, this.priority, this.sourceName, seqNums[universe]);
    const addr = multicastAddr(universe);

    this.socket.send(pkt, 0, pkt.length, SACN_PORT, addr, (err) => {
      if (err) {
        this.stats.errors++;
        console.error(`[sACN] Send error universe ${universe}:`, err.message);
      } else {
        this.stats.packetsSent++;
      }
    });
  }
}

module.exports = { SACNEngine };
