/**
 * StageOS Event Bus Client
 * ─────────────────────────────────────────────────────────────
 * Drop this file into any app's main process folder and require it.
 * It connects to the StageOS output daemon (ws://localhost:9001)
 * and lets your app emit and listen for show events from the other
 * three apps (Booth, LightScript, StageFlow, Timecode Pro) without
 * any of them knowing about each other's internals.
 *
 * Usage in an Electron main.js:
 *
 *   const bus = require('./stageos-eventbus')('lightscript');
 *
 *   // Tell other apps something happened:
 *   bus.emit('cue-fired', { cueNumber: 5, label: 'Verse' });
 *   bus.emit('blackout', { on: true });
 *
 *   // React to other apps:
 *   bus.on('cue-fired', (data, source) => {
 *     console.log(`${source} fired cue`, data.cueNumber);
 *     mainWindow.webContents.send('remote-cue-fired', data);
 *   });
 *
 * Reconnects automatically if the daemon isn't running yet or
 * the connection drops (e.g. daemon restarts). All emit() calls
 * made while disconnected are dropped silently — show events are
 * fire-and-forget, not guaranteed delivery, by design.
 * ─────────────────────────────────────────────────────────────
 */

module.exports = function createEventBus(appName, opts = {}) {
  const WebSocket = (() => {
    try { return require('ws'); } catch(e) {
      console.warn('[StageOS EventBus] "ws" module not found — event bus disabled for', appName);
      return null;
    }
  })();

  const url = opts.url || 'ws://localhost:9001';
  const listeners = new Map(); // event name -> Set of callbacks
  const wildcardListeners = new Set(); // listeners for ALL events

  let socket = null;
  let connected = false;
  let reconnectTimer = null;
  let reconnectDelay = 1000;
  const MAX_RECONNECT_DELAY = 15000;

  function log(...args) {
    if (opts.quiet) return;
    console.log(`[StageOS EventBus:${appName}]`, ...args);
  }

  function connect() {
    if (!WebSocket) return;
    try {
      socket = new WebSocket(url);
    } catch(e) {
      scheduleReconnect();
      return;
    }

    socket.on('open', () => {
      connected = true;
      reconnectDelay = 1000;
      log('connected to output daemon');
      // Announce presence so other apps / the launcher know we're alive
      send({ type: 'show-event', event: 'app-online', data: { app: appName }, source: appName });
    });

    socket.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch(e) { return; }
      if (msg.type !== 'show-event') return; // ignore daemon's other message types
      if (msg.source === appName) return;    // ignore our own echoed events, if any

      const handlers = listeners.get(msg.event);
      if (handlers) handlers.forEach(cb => safeCall(cb, msg.data, msg.source, msg.ts));
      wildcardListeners.forEach(cb => safeCall(cb, msg.event, msg.data, msg.source, msg.ts));
    });

    socket.on('close', () => {
      connected = false;
      log('disconnected, will retry…');
      scheduleReconnect();
    });

    socket.on('error', () => {
      connected = false;
      // 'close' fires after 'error' on most ws versions; scheduleReconnect handled there
    });
  }

  function safeCall(fn, ...args) {
    try { fn(...args); } catch(e) {
      console.error(`[StageOS EventBus:${appName}] listener error:`, e.message);
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_DELAY);
      connect();
    }, reconnectDelay);
  }

  function send(obj) {
    if (!connected || !socket || socket.readyState !== 1) return false;
    try { socket.send(JSON.stringify(obj)); return true; } catch(e) { return false; }
  }

  connect();

  return {
    /** Emit a show event to every other connected StageOS app. */
    emit(event, data = {}) {
      return send({ type: 'show-event', event, data, source: appName });
    },

    /** Listen for a specific show event from any other app. */
    on(event, callback) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(callback);
      return () => listeners.get(event)?.delete(callback); // unsubscribe fn
    },

    /** Listen for every show event regardless of name. cb(event, data, source, ts) */
    onAny(callback) {
      wildcardListeners.add(callback);
      return () => wildcardListeners.delete(callback);
    },

    /** Remove a specific listener. */
    off(event, callback) {
      listeners.get(event)?.delete(callback);
    },

    /** Current connection state. */
    isConnected() { return connected; },

    /** Manually close the connection (e.g. on app quit). */
    close() {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socket) { try { socket.close(); } catch(e) {} }
    }
  };
};
