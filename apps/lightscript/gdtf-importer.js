'use strict';

/**
 * LightScript GDTF Importer
 * ════════════════════════════════════════════════════════════════════════════
 * Reads a folder of .gdtf files, parses description.xml from each ZIP,
 * and returns structured fixture profiles for use in the Patching tab.
 *
 * GDTF format:
 *   - .gdtf file = ZIP archive (uncompressed or deflated)
 *   - Contains description.xml at root
 *   - description.xml structure:
 *       <GDTF>
 *         <FixtureType Name="..." Manufacturer="..." ...>
 *           <DMXModes>
 *             <DMXMode Name="16ch" ...>
 *               <DMXChannels>
 *                 <DMXChannel Offset="1" ...>
 *                   <LogicalChannel Attribute="Dimmer">
 *
 * GDTF Attribute → LightScript param mapping:
 *   Dimmer           → dimmer
 *   ColorAdd_R       → red
 *   ColorAdd_G       → green
 *   ColorAdd_B       → blue
 *   ColorAdd_W       → white
 *   ColorAdd_A       → amber
 *   ColorAdd_UV      → uv
 *   Pan              → pan
 *   Tilt             → tilt
 *   Pan_Fine         → panFine
 *   Tilt_Fine        → tiltFine
 *   Gobo*            → gobo
 *   Color*           → color (color wheel)
 *   Shutter*         → shutter
 *   Strobe*          → strobe
 *   Zoom             → zoom
 *   Focus            → focus
 *   Iris             → iris
 *   Prism*           → prism
 *   Frost*           → frost
 *   Speed            → speed
 ════════════════════════════════════════════════════════════════════════════
 */

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── GDTF Attribute name → LightScript param ──────────────────────────────
const ATTR_MAP = {
  'Dimmer':          'dimmer',
  'ColorAdd_R':      'red',
  'ColorAdd_G':      'green',
  'ColorAdd_B':      'blue',
  'ColorAdd_W':      'white',
  'ColorAdd_A':      'amber',
  'ColorAdd_UV':     'uv',
  'Color_R':         'red',
  'Color_G':         'green',
  'Color_B':         'blue',
  'Pan':             'pan',
  'Tilt':            'tilt',
  'Pan_Fine':        'panFine',
  'Tilt_Fine':       'tiltFine',
  'Zoom':            'zoom',
  'Focus':           'focus',
  'Iris':            'iris',
  'Speed':           'speed',
};

// Prefix-based fallbacks for attributes like Gobo1, Shutter_Strobe, etc.
const ATTR_PREFIX_MAP = [
  ['Gobo',    'gobo'],
  ['Color',   'color'],
  ['Colour',  'color'],
  ['Shutter', 'shutter'],
  ['Strobe',  'strobe'],
  ['Prism',   'prism'],
  ['Frost',   'frost'],
  ['Macro',   'macro'],
  ['Effects', 'effects'],
  ['CTO',     'cto'],
  ['CTB',     'ctb'],
];

function attrToParam(attr) {
  if (!attr) return null;
  if (ATTR_MAP[attr]) return ATTR_MAP[attr];
  for (const [prefix, param] of ATTR_PREFIX_MAP) {
    if (attr.startsWith(prefix)) return param;
  }
  return null;
}

// ── Minimal ZIP reader (no npm deps) ──────────────────────────────────────
// Reads the ZIP central directory to find description.xml then decompresses it
function readZipEntry(buf, targetName) {
  // Search for End of Central Directory signature (0x06054b50)
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf[i]===0x50 && buf[i+1]===0x4b && buf[i+2]===0x05 && buf[i+3]===0x06) {
      eocd = i; break;
    }
  }
  if (eocd < 0) throw new Error('Not a valid ZIP file');

  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdEntries = buf.readUInt16LE(eocd + 10);

  let pos = cdOffset;
  for (let e = 0; e < cdEntries; e++) {
    if (buf[pos]!==0x50||buf[pos+1]!==0x4b||buf[pos+2]!==0x01||buf[pos+3]!==0x02) break;
    const compression    = buf.readUInt16LE(pos + 10);
    const compSize       = buf.readUInt32LE(pos + 20);
    const uncompSize     = buf.readUInt32LE(pos + 24);
    const nameLen        = buf.readUInt16LE(pos + 28);
    const extraLen       = buf.readUInt16LE(pos + 30);
    const commentLen     = buf.readUInt16LE(pos + 32);
    const localOffset    = buf.readUInt32LE(pos + 42);
    const entryName      = buf.slice(pos + 46, pos + 46 + nameLen).toString('utf8');

    if (entryName.toLowerCase() === targetName.toLowerCase() ||
        entryName.toLowerCase().endsWith('/' + targetName.toLowerCase())) {
      // Read from local file header
      const lh       = localOffset;
      const lNameLen = buf.readUInt16LE(lh + 26);
      const lExtraLen= buf.readUInt16LE(lh + 28);
      const dataStart= lh + 30 + lNameLen + lExtraLen;
      const compData  = buf.slice(dataStart, dataStart + compSize);

      if (compression === 0) return compData; // stored
      if (compression === 8) return zlib.inflateRawSync(compData); // deflated
      throw new Error(`Unsupported compression: ${compression}`);
    }
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

// ── Parse description.xml using regex (no DOM in Node.js main process) ────
function parseDescriptionXML(xmlStr) {
  // Extract FixtureType attributes
  const ftMatch = xmlStr.match(/<FixtureType([^>]*)>/);
  if (!ftMatch) return null;

  const getAttr = (str, attr) => {
    const m = str.match(new RegExp(`${attr}="([^"]*)"`));
    return m ? m[1] : '';
  };

  const ftAttrs     = ftMatch[1];
  const name        = getAttr(ftAttrs, 'Name')         || getAttr(ftAttrs, 'LongName') || 'Unknown';
  const shortName   = getAttr(ftAttrs, 'ShortName')    || name;
  const manufacturer= getAttr(ftAttrs, 'Manufacturer') || 'Unknown';
  const fixType     = getAttr(ftAttrs, 'FixtureTypeID')|| '';

  // Determine fixture type from attributes
  const fixtureType = inferFixtureType(xmlStr);

  // Extract all DMX modes
  const modes = [];
  const modeRegex = /<DMXMode\s+Name="([^"]*)"[^>]*>([\s\S]*?)<\/DMXMode>/g;
  let modeMatch;

  while ((modeMatch = modeRegex.exec(xmlStr)) !== null) {
    const modeName    = modeMatch[1];
    const modeContent = modeMatch[2];
    const channels    = parseDMXChannels(modeContent);

    // Count actual DMX footprint
    const channelCount = channels.reduce((max, ch) => {
      const offsets = ch.offsets || [ch.offset || 1];
      return Math.max(max, ...offsets);
    }, 0);

    modes.push({
      name:    modeName,
      count:   channelCount,
      channels: channels.map(ch => ({
        offset: ch.offsets?.[0] ?? ch.offset ?? 1,
        name:   ch.attribute || 'Unknown',
        param:  attrToParam(ch.attribute),
      })),
    });
  }

  if (!modes.length) return null;

  return { name, shortName, manufacturer, type: fixtureType, modes, fixType };
}

function parseDMXChannels(modeXML) {
  const channels  = [];
  const chRegex   = /<DMXChannel\s([^>]*)>([\s\S]*?)<\/DMXChannel>/g;
  let chMatch;

  while ((chMatch = chRegex.exec(modeXML)) !== null) {
    const attrs    = chMatch[1];
    const content  = chMatch[2];

    // Offset can be "1,2" for coarse+fine (16-bit channel)
    const offsetStr = attrs.match(/Offset="([^"]*)"/) ?.[1] || '';
    const offsets   = offsetStr === 'None' ? []
      : offsetStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));

    // Get attribute from first LogicalChannel
    const lcMatch  = content.match(/Attribute="([^"]*)"/);
    const attribute= lcMatch ? lcMatch[1] : null;

    if (offsets.length && attribute) {
      channels.push({ offsets, attribute });
    }
  }
  return channels;
}

function inferFixtureType(xmlStr) {
  const lower = xmlStr.toLowerCase();
  if (lower.includes('pan') && lower.includes('tilt')) {
    if (lower.includes('beam')) return 'BEAM';
    return 'SPOT';
  }
  if (lower.includes('coloradd_r') || lower.includes('color_r')) return 'LED';
  if (lower.includes('strobe')) return 'STROB';
  if (lower.includes('wash')) return 'WASH';
  return 'PAR';
}

// ── Main: scan a folder and parse all .gdtf files ─────────────────────────
function collectGDTFFiles(dir, depth=0) {
  if (depth > 4) return [];
  let results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) results = results.concat(collectGDTFFiles(full, depth+1));
      else if (e.name.toLowerCase().endsWith('.gdtf')) results.push(full);
    }
  } catch(e) {}
  return results;
}

function loadGDTFFolder(folderPath) {
  if (!folderPath || !fs.existsSync(folderPath)) {
    return { ok: false, error: `Folder not found: ${folderPath}`, profiles: [] };
  }

  const files = collectGDTFFiles(folderPath);
  if (!files.length) {
    return { ok: false, error: 'No .gdtf files found (searched recursively)', profiles: [] };
  }

  const profiles = [];
  const errors   = [];

  for (const filePath of files) {
    try {
      const buf      = fs.readFileSync(filePath);
      const xmlBuf   = readZipEntry(buf, 'description.xml');
      if (!xmlBuf) { errors.push(`${path.basename(filePath)}: description.xml not found`); continue; }

      const xmlStr   = xmlBuf.toString('utf8');
      const profile  = parseDescriptionXML(xmlStr);
      if (!profile)  { errors.push(`${path.basename(filePath)}: could not parse`); continue; }

      const parts = path.basename(filePath, '.gdtf').split('@');
      if (!profile.manufacturer || profile.manufacturer === 'Unknown') {
        profile.manufacturer = parts[0] || 'Unknown';
      }
      if (!profile.name || profile.name === 'Unknown') {
        profile.name = parts[1] || parts[0] || 'Unknown';
      }

      profile.id       = `gdtf_${path.basename(filePath)}`;
      profile.fileName = path.basename(filePath);
      profiles.push(profile);

    } catch (e) {
      errors.push(`${path.basename(filePath)}: ${e.message}`);
    }
  }

  profiles.sort((a, b) => {
    const mfr = a.manufacturer.localeCompare(b.manufacturer);
    return mfr !== 0 ? mfr : a.name.localeCompare(b.name);
  });

  console.log(`[GDTF] Loaded ${profiles.length} profiles from ${files.length} files (${errors.length} errors)`);
  if (errors.length) console.log('[GDTF] Errors:', errors.slice(0,5));

  return { ok: true, profiles, total: files.length, loaded: profiles.length, errors };
}

module.exports = { loadGDTFFolder, attrToParam };
