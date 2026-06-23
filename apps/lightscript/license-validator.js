'use strict';
/**
 * LightScript License Validator
 * ──────────────────────────────
 * Verifies EC P-256 signed JWT license keys offline.
 * The public key is embedded — no server needed.
 */
const crypto = require('crypto');
const os     = require('os');
const fs     = require('fs');
const path   = require('path');

// ── Embedded public key (safe to ship with the app) ──────────────────────────
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEVgREuEUcLUFGqIYWY+oIihLXC/H8
6SeOCwfnECO2BlKpRcj5FHm+YvyBEGZMBLWYBAliXZRc16SN01/AkCXI6w==
-----END PUBLIC KEY-----`;

// ── Plan definitions ──────────────────────────────────────────────────────────
const PLANS = {
  free:   { channels: 25,   label: 'Free'   },
  pro:    { channels: 512,  label: 'Pro'    },
  studio: { channels: 2048, label: 'Studio' },
};
const FREE_PLAN = { plan:'free', channels:25, label:'Free', expires:null, id:'builtin' };

// ── Storage path for activated license ───────────────────────────────────────
function getLicensePath(app) {
  const base = app ? app.getPath('userData') : path.join(os.homedir(), '.lightscript');
  if (!fs.existsSync(base)) fs.mkdirSync(base, {recursive:true});
  return path.join(base, 'license.json');
}

// ── b64url helpers ────────────────────────────────────────────────────────────
function b64urlDecode(str) {
  str = str.replace(/-/g,'+').replace(/_/g,'/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

// ── Validate a raw license key string ────────────────────────────────────────
function validateKey(rawKey) {
  try {
    if (!rawKey || typeof rawKey !== 'string') return {ok:false, error:'No key provided'};
    const key = rawKey.trim();

    // Strip our LSC1- prefix
    if (!key.startsWith('LSC1-')) return {ok:false, error:'Invalid key format'};
    const token = key.slice(5);

    // Split JWT
    const parts = token.split('.');
    if (parts.length !== 3) return {ok:false, error:'Malformed key'};
    const [headerB64, payloadB64, sigB64] = parts;

    // Verify signature
    const signing = `${headerB64}.${payloadB64}`;
    const sig     = b64urlDecode(sigB64);
    const pubKey  = crypto.createPublicKey(PUBLIC_KEY_PEM);
    const valid   = crypto.verify('sha256', Buffer.from(signing), {
      key: pubKey, dsaEncoding: 'ieee-p1363',
    }, sig);

    if (!valid) return {ok:false, error:'Invalid license signature'};

    // Decode payload
    const payload = JSON.parse(b64urlDecode(payloadB64).toString());

    // Check expiry
    if (payload.expires && Date.now() > payload.expires) {
      return {ok:false, error:`License expired on ${new Date(payload.expires).toISOString().slice(0,10)}`};
    }

    return {
      ok:       true,
      plan:     payload.plan     || 'free',
      channels: payload.channels || 25,
      label:    payload.label    || 'Free',
      email:    payload.email    || '',
      expires:  payload.expires  || null,
      issued:   payload.issued   || null,
      id:       payload.id       || '',
    };
  } catch(e) {
    return {ok:false, error:'License validation error: '+e.message};
  }
}

// ── Save activated license to disk ────────────────────────────────────────────
function activateLicense(rawKey, app) {
  const result = validateKey(rawKey);
  if (!result.ok) return result;
  const licensePath = getLicensePath(app);
  fs.writeFileSync(licensePath, JSON.stringify({rawKey, ...result, activatedAt: Date.now()}));
  return result;
}

// ── Load license from disk ────────────────────────────────────────────────────
function loadLicense(app) {
  try {
    const licensePath = getLicensePath(app);
    if (!fs.existsSync(licensePath)) return {...FREE_PLAN, ok:true, activated:false};
    const saved = JSON.parse(fs.readFileSync(licensePath, 'utf8'));
    // Re-validate signature every launch
    const recheck = validateKey(saved.rawKey);
    if (!recheck.ok) {
      // Key is invalid/expired — fall back to free
      return {...FREE_PLAN, ok:true, activated:false, warning:recheck.error};
    }
    return {...recheck, activated:true};
  } catch(e) {
    return {...FREE_PLAN, ok:true, activated:false};
  }
}

// ── Remove license ────────────────────────────────────────────────────────────
function deactivateLicense(app) {
  try { fs.unlinkSync(getLicensePath(app)); } catch(_) {}
}

module.exports = { validateKey, activateLicense, loadLicense, deactivateLicense, FREE_PLAN, PLANS };
