# LightScript v1.0 — Desktop App

Scriptable lighting console built with Electron.

## Quick Start

### Requirements
- [Node.js](https://nodejs.org) v18 or later
- npm (comes with Node.js)

### Run in development

```bash
# 1. Install dependencies
npm install

# 2. Launch the app
npm start
```

### Build a distributable

```bash
# Windows (.exe installer)
npm run build-win

# macOS (.dmg)
npm run build-mac

# Linux (.AppImage)
npm run build-linux
```

Built files appear in the `dist/` folder.

---

## Command Reference

| Command | Description |
|---|---|
| `SET FIX <id> [param] <value>` | Snap fixture parameter instantly |
| `FADE FIX <id> [param] <value> [ms]` | Fade to value over time |
| `EFFECT <hold_ms>` + steps | Looping effect |
| `STORE CUE.<n> <name>` | Record a cue |
| `STORE PRESET.<TYPE>.<n> <name>` | Record a preset |
| `STORE FADER.<n> <name>` | Label a fader |
| `TIMELINE <n>` + steps | One-shot timeline |
| `$ varname = value` | Assign a $VAR$ |
| `HELP` | Show command reference |

### Parameters
`dimmer` `red` `green` `blue` `pan` `tilt` `gobo` `color` `shutter` `zoom` `strobe` `focus`

### Fixture spec syntax
- Single: `SET FIX 3 dimmer 255`
- Range: `SET FIX 1-8 dimmer 128`
- Multiple: `SET FIX 1,3,5 dimmer 200`
- With param dot-notation: `SET FIX 1.red 255`

### Example show file (.lss)
Shows are saved as JSON files with the `.lss` extension via File → Save.

---

## Hotkeys

| Key | Action |
|---|---|
| Space | GO |
| ← Left | BACK |
| Ctrl+L | Focus command line |
| Ctrl+A | Select all fixtures |
| Escape | Clear selection |
| ↑ / ↓ | Command history |
| Tab | Autocomplete |
| F11 | Fullscreen |

---

## Raspberry Pi Note
When you're ready for hardware, the next version will add:
- DMX output via Enttec USB-DMX dongle (node-dmx)
- OSC listener (osc.js)
- Fullscreen kiosk mode
- Touchscreen-optimised layout
