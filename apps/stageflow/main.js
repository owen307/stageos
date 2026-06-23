const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');

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
});

ipcMain.on('clear-output', () => {
  if (outputWindow) outputWindow.webContents.send('clear-screen');
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
