'use strict';
// ─── FIXTURE PROFILE DATABASE ─────────────────────────────────────────────────
// Each profile defines the fixture type, channel layout, and parameter ranges.
// "channels" is an ordered array of channel descriptors.
// Users can also add custom profiles.

const FIXTURE_PROFILES = [
  {
    id: 'generic-dimmer',
    name: 'Generic Dimmer',
    manufacturer: 'Generic',
    type: 'Dimmer',
    modes: [
      {
        name: '1CH',
        channels: [
          { param: 'dimmer', name: 'Intensity', min: 0, max: 255, default: 0 }
        ]
      }
    ]
  },
  {
    id: 'generic-rgb',
    name: 'Generic RGB LED',
    manufacturer: 'Generic',
    type: 'LED',
    modes: [
      {
        name: '3CH',
        channels: [
          { param: 'red',   name: 'Red',   min: 0, max: 255, default: 0 },
          { param: 'green', name: 'Green', min: 0, max: 255, default: 0 },
          { param: 'blue',  name: 'Blue',  min: 0, max: 255, default: 0 },
        ]
      },
      {
        name: '4CH',
        channels: [
          { param: 'dimmer', name: 'Master', min: 0, max: 255, default: 0 },
          { param: 'red',    name: 'Red',    min: 0, max: 255, default: 0 },
          { param: 'green',  name: 'Green',  min: 0, max: 255, default: 0 },
          { param: 'blue',   name: 'Blue',   min: 0, max: 255, default: 0 },
        ]
      }
    ]
  },
  {
    id: 'generic-rgba',
    name: 'Generic RGBA LED',
    manufacturer: 'Generic',
    type: 'LED',
    modes: [
      {
        name: '4CH',
        channels: [
          { param: 'red',   name: 'Red',   min: 0, max: 255, default: 0 },
          { param: 'green', name: 'Green', min: 0, max: 255, default: 0 },
          { param: 'blue',  name: 'Blue',  min: 0, max: 255, default: 0 },
          { param: 'amber', name: 'Amber', min: 0, max: 255, default: 0 },
        ]
      }
    ]
  },
  {
    id: 'generic-par',
    name: 'Generic PAR',
    manufacturer: 'Generic',
    type: 'PAR',
    modes: [
      {
        name: '6CH',
        channels: [
          { param: 'dimmer',  name: 'Dimmer',  min: 0, max: 255, default: 0 },
          { param: 'red',     name: 'Red',     min: 0, max: 255, default: 255 },
          { param: 'green',   name: 'Green',   min: 0, max: 255, default: 255 },
          { param: 'blue',    name: 'Blue',    min: 0, max: 255, default: 255 },
          { param: 'strobe',  name: 'Strobe',  min: 0, max: 255, default: 0 },
          { param: 'program', name: 'Program', min: 0, max: 255, default: 0 },
        ]
      }
    ]
  },
  {
    id: 'generic-moving-head',
    name: 'Generic Moving Head',
    manufacturer: 'Generic',
    type: 'Moving Head',
    modes: [
      {
        name: '8CH',
        channels: [
          { param: 'pan',    name: 'Pan',     min: 0, max: 255, default: 127 },
          { param: 'tilt',   name: 'Tilt',    min: 0, max: 255, default: 127 },
          { param: 'dimmer', name: 'Dimmer',  min: 0, max: 255, default: 0 },
          { param: 'shutter',name: 'Shutter', min: 0, max: 255, default: 255 },
          { param: 'gobo',   name: 'Gobo',    min: 0, max: 255, default: 0 },
          { param: 'color',  name: 'Color',   min: 0, max: 255, default: 0 },
          { param: 'focus',  name: 'Focus',   min: 0, max: 255, default: 127 },
          { param: 'zoom',   name: 'Zoom',    min: 0, max: 255, default: 127 },
        ]
      },
      {
        name: '16CH',
        channels: [
          { param: 'pan',       name: 'Pan',       min: 0, max: 255, default: 127 },
          { param: 'pan_fine',  name: 'Pan Fine',  min: 0, max: 255, default: 0 },
          { param: 'tilt',      name: 'Tilt',      min: 0, max: 255, default: 127 },
          { param: 'tilt_fine', name: 'Tilt Fine', min: 0, max: 255, default: 0 },
          { param: 'speed',     name: 'P/T Speed', min: 0, max: 255, default: 0 },
          { param: 'dimmer',    name: 'Dimmer',    min: 0, max: 255, default: 0 },
          { param: 'shutter',   name: 'Shutter',   min: 0, max: 255, default: 255 },
          { param: 'red',       name: 'Red',       min: 0, max: 255, default: 255 },
          { param: 'green',     name: 'Green',     min: 0, max: 255, default: 255 },
          { param: 'blue',      name: 'Blue',      min: 0, max: 255, default: 255 },
          { param: 'white',     name: 'White',     min: 0, max: 255, default: 0 },
          { param: 'gobo',      name: 'Gobo',      min: 0, max: 255, default: 0 },
          { param: 'gobo_rot',  name: 'Gobo Rot',  min: 0, max: 255, default: 0 },
          { param: 'color',     name: 'Color',     min: 0, max: 255, default: 0 },
          { param: 'focus',     name: 'Focus',     min: 0, max: 255, default: 127 },
          { param: 'zoom',      name: 'Zoom',      min: 0, max: 255, default: 127 },
        ]
      }
    ]
  },
  {
    id: 'generic-wash',
    name: 'Generic LED Wash',
    manufacturer: 'Generic',
    type: 'Wash',
    modes: [
      {
        name: '7CH',
        channels: [
          { param: 'dimmer', name: 'Dimmer', min: 0, max: 255, default: 0 },
          { param: 'red',    name: 'Red',    min: 0, max: 255, default: 255 },
          { param: 'green',  name: 'Green',  min: 0, max: 255, default: 255 },
          { param: 'blue',   name: 'Blue',   min: 0, max: 255, default: 255 },
          { param: 'white',  name: 'White',  min: 0, max: 255, default: 0 },
          { param: 'strobe', name: 'Strobe', min: 0, max: 255, default: 0 },
          { param: 'zoom',   name: 'Zoom',   min: 0, max: 255, default: 127 },
        ]
      }
    ]
  },
  {
    id: 'generic-strobe',
    name: 'Generic Strobe',
    manufacturer: 'Generic',
    type: 'Strobe',
    modes: [
      {
        name: '2CH',
        channels: [
          { param: 'dimmer', name: 'Intensity', min: 0, max: 255, default: 0 },
          { param: 'strobe', name: 'Strobe',    min: 0, max: 255, default: 0 },
        ]
      }
    ]
  },
  {
    id: 'generic-smoke',
    name: 'Generic Hazer/Fogger',
    manufacturer: 'Generic',
    type: 'Hazer',
    modes: [
      {
        name: '1CH',
        channels: [
          { param: 'dimmer', name: 'Output', min: 0, max: 255, default: 0 }
        ]
      },
      {
        name: '2CH',
        channels: [
          { param: 'dimmer', name: 'Output', min: 0, max: 255, default: 0 },
          { param: 'fan',    name: 'Fan',    min: 0, max: 255, default: 0 },
        ]
      }
    ]
  },
];

// Custom profiles added by user at runtime
let customProfiles = [];

function getAllProfiles() {
  return [...FIXTURE_PROFILES, ...customProfiles];
}

function getProfileById(id) {
  return getAllProfiles().find(p => p.id === id) || null;
}

function addCustomProfile(profile) {
  customProfiles.push(profile);
}

function getProfileDefaults(profileId, modeName) {
  const profile = getProfileById(profileId);
  if (!profile) return {};
  const mode = profile.modes.find(m => m.name === modeName) || profile.modes[0];
  const defaults = { dimmer:0, red:255, green:255, blue:255, pan:127, tilt:127, gobo:0, color:0, shutter:255, zoom:127, strobe:0, focus:127 };
  mode.channels.forEach(ch => { if (ch.param in defaults || true) defaults[ch.param] = ch.default; });
  return defaults;
}

if (typeof window !== 'undefined') {
  window.FixtureDB = { getAllProfiles, getProfileById, addCustomProfile, getProfileDefaults };
}
