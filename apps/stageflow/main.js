const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

// ── StageOS Event Bus ────────────────────────────────────────
// Lets StageFlow tell Booth, LightScript, and Timecode Pro when a
// slide goes live or output clears, and react when THEY trigger a
// show-wide blackout. Safe no-op if the output daemon isn't running.
const stageBus = require('./stageos-eventbus')('stageflow');

let operatorWindow = null;
let outputWindow = null;

function createOperatorWindow() {
  operatorWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 600,
    title: 'StageFlow — Operator',
    backgroundColor: '#0f1117',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  operatorWindow.loadFile(path.join(__dirname, 'src', 'operator.html'));
  operatorWindow.on('closed', () => {
    operatorWindow = null;
    if (outputWindow) outputWindow.close();
  });
}

function createOutputWindow(displayId) {
  const displays = screen.getAllDisplays();
  let targetDisplay = displays.find(d => d.id === displayId) || displays[displays.length - 1];

  if (outputWindow) outputWindow.close();

  outputWindow = new BrowserWindow({
    x: targetDisplay.bounds.x,
    y: targetDisplay.bounds.y,
    width: targetDisplay.bounds.width,
    height: targetDisplay.bounds.height,
    frame: false,
    fullscreen: true,
    backgroundColor: '#000000',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  outputWindow.loadFile(path.join(__dirname, 'src', 'output.html'));
  outputWindow.on('closed', () => { outputWindow = null; });
}

app.whenReady().then(() => {
  createOperatorWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC: send slide content to output window
ipcMain.on('show-slide', (event, slideData) => {
  if (outputWindow) {
    outputWindow.webContents.send('render-slide', slideData);
  }
  stageBus.emit('slide-changed', { slide: slideData });
});

ipcMain.on('clear-output', () => {
  if (outputWindow) outputWindow.webContents.send('clear-screen');
  stageBus.emit('blackout', { on: true });
});

ipcMain.on('open-output-window', (event, displayId) => {
  createOutputWindow(displayId);
});

ipcMain.on('close-output-window', () => {
  if (outputWindow) outputWindow.close();
});

ipcMain.handle('get-displays', () => {
  return screen.getAllDisplays().map(d => ({
    id: d.id,
    label: `Display ${d.id} (${d.bounds.width}x${d.bounds.height})`,
    bounds: d.bounds,
    primary: d.id === screen.getPrimaryDisplay().id,
  }));
});

// ── StageOS Event Bus: react to other apps ──────────────────
// If Booth, LightScript, or Timecode Pro calls a show-wide blackout,
// clear StageFlow's output screen too so every app stays in sync.
stageBus.on('blackout', (data, source) => {
  if (data && data.on && outputWindow) {
    outputWindow.webContents.send('clear-screen');
  }
  if (operatorWindow && !operatorWindow.isDestroyed()) {
    operatorWindow.webContents.send('stagebus-blackout', { source });
  }
});

// Surface cue fires / transport events from other apps in the operator UI
stageBus.onAny((event, data, source) => {
  if (operatorWindow && !operatorWindow.isDestroyed()) {
    operatorWindow.webContents.send('stagebus-event', { event, data, source });
  }
});
