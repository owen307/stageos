const { app, BrowserWindow, ipcMain, Menu, screen } = require('electron');
const path = require('path');
let operatorWin, outputWin;

function createWindows() {
  const displays = screen.getAllDisplays();
  const outputDisplay = displays[1] || displays[0];

  operatorWin = new BrowserWindow({ width:1200, height:800, backgroundColor:'#0a0b0e',
    webPreferences:{ nodeIntegration:false, contextIsolation:true, preload:path.join(__dirname,'preload.js') }
  });
  operatorWin.loadFile('operator.html');

  outputWin = new BrowserWindow({
    x: outputDisplay.bounds.x, y: outputDisplay.bounds.y,
    width: outputDisplay.bounds.width, height: outputDisplay.bounds.height,
    fullscreen: displays.length > 1, frame:false, backgroundColor:'#000',
    webPreferences:{ nodeIntegration:false, contextIsolation:true, preload:path.join(__dirname,'preload.js') }
  });
  outputWin.loadFile('output.html');
  Menu.setApplicationMenu(null);
}

app.whenReady().then(createWindows);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.on('go-live', (_, slide) => { outputWin?.webContents.send('show-slide', slide); });
ipcMain.on('blackout', () => { outputWin?.webContents.send('blackout'); });
ipcMain.on('clear', () => { outputWin?.webContents.send('clear'); });
