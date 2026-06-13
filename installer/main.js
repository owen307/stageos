const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const { execSync, spawn } = require('child_process');

let win;
const platform = process.platform;

// ISO can be next to the exe or in payload/
function findISO() {
  const locations = [
    path.join(process.resourcesPath || __dirname, 'payload', 'StageOS-v1.0.iso'),
    path.join(__dirname, 'payload', 'StageOS-v1.0.iso'),
    path.join(__dirname, 'StageOS-v1.0.iso'),
    path.join(app.getPath('downloads'), 'StageOS-v1.0.iso'),
  ];
  for (const p of locations) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function createWindow() {
  win = new BrowserWindow({
    width: 820, height: 640, minWidth: 760, minHeight: 560,
    frame: false, backgroundColor: '#0a0b0e',
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
  });
  win.loadFile('installer.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (platform !== 'darwin') app.quit(); });

ipcMain.on('minimize', () => win.minimize());
ipcMain.on('close',    () => app.quit());
ipcMain.on('open-url', (_, url) => shell.openExternal(url));

// ── System info ──────────────────────────────────────────────
ipcMain.handle('get-sysinfo', () => {
  const isoPath = findISO();
  let diskFreeGB = '?';
  try {
    if (platform === 'win32') {
      const out = execSync('wmic logicaldisk where "DeviceID=\'C:\'" get FreeSpace /value').toString();
      diskFreeGB = Math.floor(parseInt(out.split('=')[1]) / 1e9);
    } else {
      diskFreeGB = parseInt(execSync("df -BG / | awk 'NR==2{print $4}'").toString());
    }
  } catch(e) {}
  return {
    platform, arch: os.arch(),
    cores: os.cpus().length,
    totalGB: (os.totalmem() / 1e9).toFixed(1),
    diskFreeGB,
    isoFound: !!isoPath,
    isoPath: isoPath || '',
    isoSizeMB: isoPath ? Math.round(fs.statSync(isoPath).size / 1e6) : 0
  };
});

// ── Browse for ISO ───────────────────────────────────────────
ipcMain.handle('browse-iso', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Select StageOS ISO',
    filters: [{ name: 'ISO Files', extensions: ['iso'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// ── Real drive scanning ──────────────────────────────────────
ipcMain.handle('scan-drives', async () => {
  try {
    if (platform === 'win32') return scanWindows();
    if (platform === 'darwin') return scanMac();
    return scanLinux();
  } catch(e) { return { drives: [], error: e.message }; }
});

function scanWindows() {
  const drives = [];
  try {
    // Use PowerShell Get-Disk for reliable results
    const out = execSync(
      'powershell -NoProfile -Command "Get-Disk | Select-Object Number,FriendlyName,Size,BusType | ConvertTo-Json"',
      { timeout: 10000 }
    ).toString();
    const disks = JSON.parse(out.trim());
    const arr = Array.isArray(disks) ? disks : [disks];
    for (const d of arr) {
      // Only show USB/removable drives
      if (!['USB','SD','FireWire'].includes(d.BusType)) continue;
      const bytes = d.Size || 0;
      if (bytes < 7e9) continue; // must be 7GB+
      drives.push({
        id:   String(d.Number),
        path: `\\\\.\\PhysicalDrive${d.Number}`,
        name: d.FriendlyName || `Disk ${d.Number}`,
        size: (bytes / 1e9).toFixed(1) + ' GB',
        bytes
      });
    }
  } catch(e) {
    // Fallback: wmic
    try {
      const out = execSync('wmic diskdrive get Index,Model,Size,InterfaceType /format:csv', { timeout: 10000 }).toString();
      for (const line of out.split('\n').slice(2)) {
        const parts = line.trim().split(',');
        if (parts.length < 5) continue;
        const [,idx,,iface,model,size] = parts;
        if (!['USB','IEEE 1394'].includes((iface||'').trim())) continue;
        const bytes = parseInt(size) || 0;
        if (bytes < 7e9) continue;
        drives.push({
          id:   (idx||'').trim(),
          path: `\\\\.\\PhysicalDrive${(idx||'').trim()}`,
          name: (model||'').trim(),
          size: (bytes/1e9).toFixed(1)+' GB',
          bytes
        });
      }
    } catch(e2) {}
  }
  return { drives };
}

function scanMac() {
  const drives = [];
  const out = execSync('diskutil list external').toString();
  for (const line of out.split('\n')) {
    const m = line.match(/^(\/dev\/disk\d+)\s+\(external/);
    if (!m) continue;
    try {
      const info  = execSync(`diskutil info ${m[1]}`).toString();
      const sizeM = info.match(/Disk Size:\s+[\d.]+ [A-Z]+\s+\(([\d,]+) Bytes/);
      const nameM = info.match(/Device \/ Media Name:\s+(.+)/);
      const bytes = sizeM ? parseInt(sizeM[1].replace(/,/g,'')) : 0;
      if (bytes >= 7e9) drives.push({
        id: m[1].replace('/dev/',''), path: m[1],
        name: nameM ? nameM[1].trim() : 'External Drive',
        size: (bytes/1e9).toFixed(1)+' GB', bytes
      });
    } catch(e) {}
  }
  return { drives };
}

function scanLinux() {
  const drives = [];
  try {
    const json = JSON.parse(execSync('lsblk -J -o NAME,SIZE,MODEL,RM').toString());
    for (const d of json.blockdevices || []) {
      if (!d.rm) continue;
      const bytes = parseSize(d.size);
      if (bytes >= 7e9) drives.push({ id: d.name, path: '/dev/'+d.name, name: d.model||'USB Drive', size: d.size, bytes });
    }
  } catch(e) {}
  return { drives };
}

function parseSize(str) {
  if (!str) return 0;
  const m = str.match(/([\d.]+)\s*([KMGT])/i);
  if (!m) return 0;
  return parseFloat(m[1]) * ({K:1e3,M:1e6,G:1e9,T:1e12}[m[2].toUpperCase()]||1);
}

// ── Real USB write ───────────────────────────────────────────
let writeProc = null;

ipcMain.handle('write-usb', async (event, { drivePath, isoPath: customISO }) => {
  const isoPath = customISO || findISO();
  if (!isoPath || !fs.existsSync(isoPath)) {
    return { error: 'ISO not found. Please browse for the StageOS ISO file.' };
  }
  if (!drivePath) return { error: 'No drive selected.' };

  const send = (type, data) => win.webContents.send('write-progress', { type, ...data });

  try {
    if (platform === 'win32') await writeWindows(isoPath, drivePath, send);
    else if (platform === 'darwin') await writeMac(isoPath, drivePath, send);
    else await writeLinux(isoPath, drivePath, send);
    return { success: true };
  } catch(e) {
    send('error', { msg: e.message });
    return { error: e.message };
  }
});

function writeWindows(isoPath, drivePath, send) {
  return new Promise((resolve, reject) => {
    const isoSize   = fs.statSync(isoPath).size;
    const startTime = Date.now();
    send('status', { msg: 'Writing StageOS to USB… do not remove the drive', pct: 2 });

    // PowerShell raw disk write — works on Win 10/11, requires admin
    const ps = `
$ErrorActionPreference = 'Stop'
$src = [System.IO.File]::OpenRead('${isoPath.replace(/\\/g,'/')}')
$dst = [System.IO.File]::OpenWrite('${drivePath}')
$buf = New-Object byte[] (4 * 1024 * 1024)
$total = $src.Length
$written = 0
try {
  while (($n = $src.Read($buf, 0, $buf.Length)) -gt 0) {
    $dst.Write($buf, 0, $n)
    $written += $n
    $pct = [int](($written / $total) * 95)
    Write-Host "P:$written/$pct"
  }
  $dst.Flush()
} finally { $src.Close(); $dst.Close() }
Write-Host "DONE"
`;
    const proc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps]);
    writeProc = proc;

    proc.stdout.on('data', data => {
      for (const line of data.toString().split('\n')) {
        const l = line.trim();
        if (l.startsWith('P:')) {
          const [written, pct] = l.slice(2).split('/').map(Number);
          const elapsed = (Date.now()-startTime)/1000;
          const speed   = elapsed > 0 ? Math.round(written/elapsed/1e6) : 0;
          const eta     = speed > 0 ? Math.ceil((isoSize-written)/1e6/speed)+'s' : '—';
          send('progress', {
            pct, msg: `Writing… ${Math.round(written/1e6)} MB of ${Math.round(isoSize/1e6)} MB`,
            written: Math.round(written/1e6)+' MB', speed: speed+' MB/s', eta
          });
        } else if (l === 'DONE') {
          send('status', { msg: 'Write complete! Safely remove the USB drive.', pct: 100 });
          resolve();
        }
      }
    });

    proc.stderr.on('data', data => {
      const msg = data.toString().trim();
      if (msg) send('error', { msg });
    });

    proc.on('close', code => {
      if (code !== 0) reject(new Error('Write failed. Make sure you ran the installer as Administrator.'));
    });
    proc.on('error', reject);
  });
}

function writeMac(isoPath, drivePath, send) {
  return new Promise((resolve, reject) => {
    const isoSize = fs.statSync(isoPath).size;
    const startTime = Date.now();
    try { execSync(`diskutil unmountDisk force ${drivePath}`); } catch(e) {}
    send('status', { msg: 'Writing StageOS to USB…', pct: 3 });
    const raw  = drivePath.replace('/dev/disk', '/dev/rdisk');
    const proc = spawn('sudo', ['dd', `if=${isoPath}`, `of=${raw}`, 'bs=4m', 'conv=sync']);
    writeProc  = proc;
    const t    = setInterval(() => { try { proc.kill('SIGINFO'); } catch(e) {} }, 2000);
    proc.stderr.on('data', data => {
      const m = data.toString().match(/(\d+)\s+bytes transferred/);
      if (m) {
        const written = parseInt(m[1]);
        const pct   = Math.min(95, Math.round(written/isoSize*100));
        const elapsed = (Date.now()-startTime)/1000;
        const speed = elapsed>0 ? Math.round(written/elapsed/1e6) : 0;
        const eta   = speed>0 ? Math.ceil((isoSize-written)/1e6/speed)+'s' : '—';
        send('progress', { pct, msg: `Writing… ${Math.round(written/1e6)} MB`, written: Math.round(written/1e6)+' MB', speed: speed+' MB/s', eta });
      }
    });
    proc.on('close', code => {
      clearInterval(t);
      if (code===0) { try { execSync(`diskutil eject ${drivePath}`); } catch(e) {} send('status',{msg:'Done! Eject and boot.',pct:100}); resolve(); }
      else reject(new Error('Write failed.'));
    });
    proc.on('error', e => { clearInterval(t); reject(e); });
  });
}

function writeLinux(isoPath, drivePath, send) {
  return new Promise((resolve, reject) => {
    const isoSize = fs.statSync(isoPath).size;
    const startTime = Date.now();
    send('status', { msg: 'Writing…', pct: 3 });
    const proc = spawn('sudo', ['dd', `if=${isoPath}`, `of=${drivePath}`, 'bs=4M', 'status=progress']);
    writeProc  = proc;
    proc.stderr.on('data', data => {
      const m = data.toString().match(/(\d+)\s+bytes/);
      if (m) {
        const written = parseInt(m[1]);
        const pct = Math.min(95, Math.round(written/isoSize*100));
        const elapsed = (Date.now()-startTime)/1000;
        const speed = elapsed>0?Math.round(written/elapsed/1e6):0;
        const eta = speed>0?Math.ceil((isoSize-written)/1e6/speed)+'s':'—';
        send('progress',{pct,msg:`Writing… ${Math.round(written/1e6)} MB`,written:Math.round(written/1e6)+' MB',speed:speed+' MB/s',eta});
      }
    });
    proc.on('close', code => {
      if(code===0){execSync('sudo sync');send('status',{msg:'Done!',pct:100});resolve();}
      else reject(new Error('Write failed.'));
    });
    proc.on('error', reject);
  });
}

ipcMain.handle('cancel-write', () => {
  if (writeProc) { try { writeProc.kill(); } catch(e) {} writeProc = null; return { cancelled: true }; }
  return { cancelled: false };
});

ipcMain.handle('request-admin', async () => {
  if (platform !== 'darwin') return { ok: true };
  try { execSync('sudo -n true 2>/dev/null'); return { ok: true }; } catch(e) {}
  try { execSync(`osascript -e 'do shell script "true" with administrator privileges'`); return { ok: true }; }
  catch(e) { return { ok: false, error: e.message }; }
});
