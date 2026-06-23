# StageFlow — Live Presentation Visual Software

A lightweight Electron-based live presentation tool for displaying slides, lyrics, and scripture on a second screen or projector.

## Features
- **Dual-window design** — Operator window (you) + Output window (audience screen)
- **Cue list** — Organize slides into labeled cue groups (songs, scriptures, announcements, etc.)
- **Live preview** — See what's live vs. what's selected next side by side
- **Themes** — Apply visual themes (Minimal Black, Worship Blue, Deep Purple, Warm Amber, White)
- **Transitions** — Cut, Fade, Slide Up, Zoom
- **Multi-display** — Pick which monitor/projector to output to
- **Keyboard control** — Arrow keys to advance, Enter/Space to go live, Escape to black

## Setup

```bash
npm install
npm start
```

## Build for Distribution

```bash
npm run build
```
Output will be in the `dist/` folder.

## Controls

| Key | Action |
|-----|--------|
| `Enter` / `Space` | Go Live (send selected slide to output) |
| `→` / `↓` | Next slide + Go Live |
| `←` / `↑` | Previous slide + Go Live |
| `Escape` | Black / Clear output |
| Double-click | Select + Go Live immediately |

## Workflow

1. Click **Launch Output** to open the fullscreen output window on your projector
2. Click a slide in the **Cue List** or **Slide Strip** to preview it on the right
3. Press **Enter** or click **GO LIVE** to push it to the output
4. Use **Arrow keys** to advance through slides
5. Click **Clear Output** or press **Escape** to go to black

## File Structure

```
stageflow/
  main.js           ← Electron main process
  src/
    operator.html   ← Operator control interface
    output.html     ← Fullscreen output window
  package.json
```
