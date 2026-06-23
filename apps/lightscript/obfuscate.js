/**
 * LightScript build obfuscator
 * Run before electron-builder to make source unreadable in production.
 *
 * Uses javascript-obfuscator (install once: npm install javascript-obfuscator --save-dev)
 * Falls back gracefully if not installed — build still works, just unobfuscated.
 */

'use strict';
const fs   = require('fs');
const path = require('path');

let obfuscate;
try {
  obfuscate = require('javascript-obfuscator').obfuscate;
} catch(e) {
  console.warn('[obfuscate] javascript-obfuscator not installed — skipping.');
  console.warn('[obfuscate] Install with: npm install javascript-obfuscator --save-dev');
  process.exit(0);
}

// Files to obfuscate (relative to project root)
const TARGETS = [
  'src/app.js',
  'src/fixtures-db.js',
  'main.js',
  'preload.js',
  'license-validator.js',
  'remote-server.js',
  'gdtf-importer.js',
  'sacn-engine.js',
  'usb-dmx-engine.js',
];

// javascript-obfuscator options — browser files (src/)
const BROWSER_OPTIONS = {
  compact:                          true,
  controlFlowFlattening:            true,
  controlFlowFlatteningThreshold:   0.4,
  deadCodeInjection:                true,
  deadCodeInjectionThreshold:       0.2,
  debugProtection:                  true,
  debugProtectionInterval:          2000,
  disableConsoleOutput:             true,
  identifierNamesGenerator:         'hexadecimal',
  log:                              false,
  numbersToExpressions:             true,
  renameGlobals:                    false,
  selfDefending:                    true,
  simplify:                         true,
  splitStrings:                     true,
  splitStringsChunkLength:          8,
  stringArray:                      true,
  stringArrayCallsTransform:        true,
  stringArrayEncoding:              ['base64'],
  stringArrayIndexShift:            true,
  stringArrayRotate:                true,
  stringArrayShuffle:               true,
  stringArrayWrappersCount:         2,
  stringArrayWrappersType:          'function',
  unicodeEscapeSequence:            false,
  target:                           'browser',
};

// Node.js files — lighter touch, preserve require/module/exports/process/__dirname
const NODE_OPTIONS = {
  compact:                          true,
  controlFlowFlattening:            true,
  controlFlowFlatteningThreshold:   0.3,
  deadCodeInjection:                true,
  deadCodeInjectionThreshold:       0.15,
  debugProtection:                  false,  // breaks Node inspector
  disableConsoleOutput:             false,  // keep console.error for crash logs
  identifierNamesGenerator:         'hexadecimal',
  log:                              false,
  numbersToExpressions:             true,
  renameGlobals:                    false,  // never rename require/module/exports
  selfDefending:                    false,  // self-defending uses browser APIs
  simplify:                         true,
  splitStrings:                     true,
  splitStringsChunkLength:          10,
  stringArray:                      true,
  stringArrayCallsTransform:        true,
  stringArrayEncoding:              ['base64'],
  stringArrayIndexShift:            true,
  stringArrayRotate:                true,
  stringArrayShuffle:               true,
  stringArrayWrappersCount:         1,
  stringArrayWrappersType:          'function',
  unicodeEscapeSequence:            false,
  target:                           'node',  // preserves Node.js globals
};

const distDir = path.join(__dirname, 'dist-obf');
if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });

let ok = 0, fail = 0;

const NODE_FILES = new Set(['main.js','preload.js','license-validator.js','remote-server.js','gdtf-importer.js','sacn-engine.js','usb-dmx-engine.js']);

for (const rel of TARGETS) {
  const src = path.join(__dirname, rel);
  if (!fs.existsSync(src)) { console.warn(`[obfuscate] Not found: ${rel}`); continue; }

  try {
    const code   = fs.readFileSync(src, 'utf8');
    const isNode = NODE_FILES.has(path.basename(rel));
    const opts   = isNode ? NODE_OPTIONS : BROWSER_OPTIONS;
    const result = obfuscate(code, { ...opts, sourceMap: false });
    const outPath = path.join(__dirname, rel);
    fs.writeFileSync(outPath, result.getObfuscatedCode(), 'utf8');
    const before = code.length, after = result.getObfuscatedCode().length;
    console.log(`[obfuscate] ✓ ${rel}  ${(before/1024).toFixed(0)}KB → ${(after/1024).toFixed(0)}KB  [${isNode?'node':'browser'}]`);
    ok++;
  } catch(e) {
    console.error(`[obfuscate] ✕ ${rel}: ${e.message}`);
    fail++;
  }
}

console.log(`[obfuscate] Done — ${ok} obfuscated, ${fail} failed.`);
if (fail > 0) process.exit(1);
