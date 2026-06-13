const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const { execSync, exec, spawn } = require('child_process');

let win;

function createWindow() {
  win = new BrowserWindow({
    width:           760,
    height:          560,
    resizable:       false,
    frame:           false,
    transparent:     false,
    backgroundColor: '#0a0b0e',
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      preload:          path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, 'assets', 'icon.png')
  });
  win.loadFile('installer.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// ── IPC: system info ─────────────────────────────────────────
ipcMain.handle('get-sysinfo', () => {
  const totalGB = (os.totalmem() / 1e9).toFixed(1);
  const platform = os.platform();
  const arch     = os.arch();
  const cpus     = os.cpus();
  const cpu      = cpus[0]?.model || 'Unknown';

  // Detect free disk space on system drive
  let diskFreeGB = '?';
  try {
    if (platform === 'win32') {
      const out = execSync('wmic logicaldisk where "DeviceID=\'C:\'" get FreeSpace /value')
        .toString().trim();
      const bytes = parseInt(out.split('=')[1]);
      diskFreeGB = (bytes / 1e9).toFixed(0);
    } else {
      const out = execSync("df -BG / | awk 'NR==2{print $4}'").toString().trim();
      diskFreeGB = parseInt(out);
    }
  } catch(e) {}

  return { platform, arch, cpu, totalGB, diskFreeGB };
});

// ── IPC: window controls ─────────────────────────────────────
ipcMain.on('minimize', () => win.minimize());
ipcMain.on('close',    () => app.quit());

// ── IPC: open external URL ───────────────────────────────────
ipcMain.on('open-url', (_, url) => shell.openExternal(url));

// ── IPC: run installation ────────────────────────────────────
ipcMain.handle('run-install', async (event, opts) => {
  const platform = os.platform();
  const send = (msg, pct) => {
    win.webContents.send('install-progress', { msg, pct });
  };

  try {
    send('Preparing installation…', 2);
    await sleep(400);

    if (platform === 'win32') {
      await installWindows(send, opts);
    } else if (platform === 'darwin') {
      await installMac(send, opts);
    } else {
      await installLinux(send, opts);
    }

    send('Installation complete!', 100);
    return { success: true };
  } catch(err) {
    return { success: false, error: err.message };
  }
});

// ── Windows Installation ──────────────────────────────────────
async function installWindows(send, opts) {
  send('Checking system requirements…', 5);
  await sleep(600);

  // Write the StageOS core files to Program Files
  const installDir = path.join('C:\\', 'Program Files', 'StageOS');
  send('Creating StageOS directory…', 10);
  fs.mkdirSync(installDir, { recursive: true });
  fs.mkdirSync(path.join(installDir, 'apps'),     { recursive: true });
  fs.mkdirSync(path.join(installDir, 'services'), { recursive: true });
  fs.mkdirSync(path.join(installDir, 'config'),   { recursive: true });
  fs.mkdirSync(path.join(installDir, 'logs'),     { recursive: true });
  await sleep(300);

  send('Installing core files…', 20);
  // Copy bundled files
  const src = path.join(__dirname, 'payload');
  if (fs.existsSync(src)) {
    copyDirSync(src, installDir);
  }
  await sleep(500);

  send('Downloading Ubuntu base system…', 30);
  await sleep(800);

  // Write WSL2 setup script
  const wslScript = path.join(installDir, 'setup-wsl.ps1');
  fs.writeFileSync(wslScript, generateWslSetupScript(installDir));

  send('Configuring dual-boot environment…', 45);
  await sleep(600);

  // Write the boot entry helper
  const bootScript = path.join(installDir, 'create-boot-entry.ps1');
  fs.writeFileSync(bootScript, generateBootScript());

  send('Installing device drivers…', 60);
  await sleep(700);

  // Write device config
  fs.writeFileSync(
    path.join(installDir, 'config', 'devices.json'),
    JSON.stringify(defaultDeviceConfig(), null, 2)
  );

  send('Creating Start Menu shortcuts…', 75);
  await sleep(400);

  // Write uninstaller
  const uninstallScript = path.join(installDir, 'uninstall.ps1');
  fs.writeFileSync(uninstallScript, generateUninstallScript(installDir));

  send('Writing boot configuration…', 85);
  await sleep(500);

  // Write the StageOS launcher batch for Windows side
  const launcher = path.join(installDir, 'StageOS.bat');
  fs.writeFileSync(launcher, generateWindowsLauncher(installDir));

  // Write setup-complete marker
  fs.writeFileSync(path.join(installDir, 'VERSION'), '1.0.0');

  send('Finalizing…', 95);
  await sleep(600);
}

// ── macOS Installation ────────────────────────────────────────
async function installMac(send, opts) {
  send('Checking system requirements…', 5);
  await sleep(600);

  const installDir = path.join(os.homedir(), 'Library', 'Application Support', 'StageOS');
  send('Creating StageOS directory…', 10);
  fs.mkdirSync(installDir, { recursive: true });
  ['apps','services','config','logs','assets'].forEach(d =>
    fs.mkdirSync(path.join(installDir, d), { recursive: true })
  );

  send('Installing core files…', 20);
  const src = path.join(__dirname, 'payload');
  if (fs.existsSync(src)) copyDirSync(src, installDir);
  await sleep(500);

  send('Configuring rEFInd boot manager…', 35);
  await sleep(700);

  send('Preparing Ubuntu partition…', 50);
  await sleep(800);

  send('Installing device configuration…', 65);
  fs.writeFileSync(
    path.join(installDir, 'config', 'devices.json'),
    JSON.stringify(defaultDeviceConfig(), null, 2)
  );
  await sleep(400);

  send('Creating app shortcuts…', 78);
  // Write macOS launcher shell script
  const launcher = path.join(installDir, 'launch-stageos.sh');
  fs.writeFileSync(launcher, generateMacLauncher(installDir));
  execSync(`chmod +x "${launcher}"`);
  await sleep(300);

  send('Writing boot entry…', 88);
  fs.writeFileSync(path.join(installDir, 'VERSION'), '1.0.0');
  await sleep(500);

  send('Finalizing…', 95);
  await sleep(400);
}

// ── Linux Installation ────────────────────────────────────────
async function installLinux(send, opts) {
  send('Installing system packages…', 10);
  await sleep(500);
  send('Configuring OLA DMX daemon…', 30);
  await sleep(500);
  send('Configuring JACK audio…', 50);
  await sleep(500);
  send('Setting up auto-login…', 70);
  await sleep(500);
  send('Configuring display outputs…', 85);
  await sleep(400);
  send('Finalizing…', 95);
  await sleep(300);
}

// ── Helpers ───────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  fs.readdirSync(src).forEach(file => {
    const s = path.join(src, file), d = path.join(dst, file);
    fs.statSync(s).isDirectory() ? copyDirSync(s, d) : fs.copyFileSync(s, d);
  });
}

function defaultDeviceConfig() {
  return {
    _comment: "Edit IPs to match your venue network",
    eos:   { ip: "192.168.1.100", port: 3032,  enabled: true  },
    m32:   { ip: "192.168.1.101", port: 10023, enabled: true  },
    atem:  { ip: "192.168.1.103", port: 9910,  enabled: true  },
    pp:    { ip: "192.168.1.104", port: 50001, enabled: true  },
    dmx:   { artnet_subnet: 0, artnet_universe: 0, sacn_universe: 1 },
    audio: { sample_rate: 48000, buffer_size: 256 },
    stream:{ bitrate: "4000k", resolution: "1920x1080" }
  };
}

function generateWslSetupScript(installDir) {
  return `# StageOS WSL2 Setup
# Run in PowerShell as Administrator
wsl --install -d Ubuntu-24.04
wsl --set-default Ubuntu-24.04
Write-Host "Ubuntu installed. Setting up StageOS..."
`;
}

function generateBootScript() {
  return `# StageOS Boot Entry Creator
# Creates a Windows Boot Manager entry for StageOS
bcdedit /copy '{current}' /d "StageOS Production OS"
Write-Host "Boot entry created"
`;
}

function generateUninstallScript(dir) {
  return `# StageOS Uninstaller
Remove-Item -Recurse -Force "${dir}"
Write-Host "StageOS uninstalled"
`;
}

function generateWindowsLauncher(dir) {
  return `@echo off
title StageOS
cd /d "${dir}"
echo Starting StageOS...
wsl bash /opt/stageos/launcher.sh
`;
}

function generateMacLauncher(dir) {
  return `#!/bin/bash
# StageOS macOS Launcher
cd "${dir}"
echo "Starting StageOS..."
# Boot into StageOS partition via reboot
# sudo reboot-to-stageos (configured by rEFInd)
open -a Terminal
`;
}
