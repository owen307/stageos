'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, Tray, nativeImage } = require('electron');
const path = require('path');
const fs   = require('fs');
const { SACNEngine }       = require('./sacn-engine');
const { USBDMXEngine }     = require('./usb-dmx-engine');
const { loadGDTFFolder }   = require('./gdtf-importer');
const { RemoteServer }     = require('./remote-server');
const { validateKey, activateLicense, loadLicense, deactivateLicense } = require('./license-validator');

let mainWindow;
const sacn      = new SACNEngine();
const usbDmx    = new USBDMXEngine();
const remote    = new RemoteServer();
let pendingShowFile = null;

// ── Handle file open from OS (double-click .lss) ────────────────────────────
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (mainWindow && mainWindow.webContents) {
    const data = fs.readFileSync(filePath, 'utf8');
    mainWindow.webContents.send('menu-action', 'load-show', data);
  } else {
    pendingShowFile = filePath; // window not ready yet, load after create
  }
});

// Windows: .lss file passed as process.argv[1]
if (process.platform === 'win32' && process.argv[1] && process.argv[1].endsWith('.lss')) {
  pendingShowFile = process.argv[1];
}

function createWindow() {
  const isProd = app.isPackaged; // true when installed, false during npm start

  mainWindow = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1024, minHeight: 640,
    backgroundColor: '#0a0b0d',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      nodeIntegration:    false,
      contextIsolation:   true,
      preload:            path.join(__dirname,'preload.js'),
      devTools:           !isProd, // DevTools only available during development
    },
    icon: path.join(__dirname,'assets', process.platform==='win32'?'icon.ico':process.platform==='darwin'?'icon.icns':'icon.png'),
    title: 'LightScript',
  });
  mainWindow.loadFile(path.join(__dirname,'src','index.html'));

  // Block all DevTools access in production
  if (isProd) {
    // Prevent F12 / Ctrl+Shift+I / Cmd+Opt+I
    mainWindow.webContents.on('before-input-event', (event, input) => {
      const isDevToolsKey =
        input.key === 'F12' ||
        (input.control && input.shift && input.key === 'I') ||
        (input.control && input.shift && input.key === 'J') ||
        (input.control && input.shift && input.key === 'C') ||
        (input.meta    && input.alt   && input.key === 'I') ||
        (input.meta    && input.alt   && input.key === 'J');
      if (isDevToolsKey) event.preventDefault();
    });

    // Block right-click context menu (which has Inspect Element)
    mainWindow.webContents.on('context-menu', (e) => e.preventDefault());

    // Close DevTools immediately if somehow opened
    mainWindow.webContents.on('devtools-opened', () => {
      mainWindow.webContents.closeDevTools();
    });
  }

  mainWindow.webContents.once('did-finish-load', () => {
    if (pendingShowFile) {
      try {
        const data = fs.readFileSync(pendingShowFile, 'utf8');
        mainWindow.webContents.send('menu-action', 'load-show', data);
      } catch(e) { console.error('Failed to load show file:', e.message); }
      pendingShowFile = null;
    }
  });

  // ── Close button minimizes; only Quit actually exits ──────────────────────
  let forceQuit = false;
  app.on('before-quit', () => { forceQuit = true; });

  mainWindow.on('close', (e) => {
    if (!forceQuit) {
      e.preventDefault();
      mainWindow.minimize();
    }
  });

  // ── Quit confirmation ─────────────────────────────────────────────────────
  // Called by File → Quit and tray Quit — shows dialog before actually quitting
  function confirmQuit() {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type:    'question',
      buttons: ['Quit LightScript', 'Cancel'],
      defaultId: 1,
      cancelId:  1,
      title:   'Quit LightScript?',
      message: 'Are you sure you want to quit LightScript?',
      detail:  'Make sure your show is saved before quitting.',
      icon:    path.join(__dirname, 'assets', 'icon.png'),
    });
    if (choice === 0) { forceQuit = true; app.quit(); }
  }

  // ── System tray ───────────────────────────────────────────────────────────
  const trayIconPath = path.join(__dirname, 'assets',
    process.platform === 'win32' ? 'icon.ico' : process.platform === 'darwin' ? 'icon.icns' : 'icon.png');
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(trayIconPath).resize({ width:16, height:16 });
  } catch(_) {
    trayIcon = nativeImage.createEmpty();
  }
  const tray = new Tray(trayIcon);
  tray.setToolTip('LightScript');
  const trayMenu = Menu.buildFromTemplate([
    { label: 'Show LightScript', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: 'separator' },
    { label: 'Quit LightScript', click: confirmQuit },
  ]);
  tray.setContextMenu(trayMenu);
  tray.on('click', () => { mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show(); });

  const send = (a, d) => mainWindow.webContents.send('menu-action', a, d);
  const menu = Menu.buildFromTemplate([
    { label:'File', submenu:[
      { label:'New Show',        accelerator:'CmdOrCtrl+N',       click:()=>send('new-show') },
      { label:'Open Show…',      accelerator:'CmdOrCtrl+O',       click:openShow },
      { label:'Save Show',       accelerator:'CmdOrCtrl+S',       click:()=>send('save-show') },
      { label:'Save Show As…',   accelerator:'CmdOrCtrl+Shift+S', click:()=>send('save-show-as') },
      { type:'separator' },
      { label:'Quit LightScript', accelerator:'CmdOrCtrl+Q', click: confirmQuit },
    ]},
    { label:'Output', submenu:[
      { label:'sACN: Start',     accelerator:'CmdOrCtrl+Shift+O', click:()=>send('sacn-start') },
      { label:'sACN: Stop',      accelerator:'CmdOrCtrl+Shift+P', click:()=>send('sacn-stop') },
      { label:'sACN Settings',   click:()=>send('sacn-settings') },
      { type:'separator' },
      { label:'USB DMX Settings',click:()=>send('usbdmx-settings') },
      { type:'separator' },
      { label:'Blackout All',    accelerator:'CmdOrCtrl+B',       click:()=>send('blackout-all') },
    ]},
    { label:'View', submenu:[
      { role:'reload' }, { role:'forceReload' }, { type:'separator' },
      { role:'togglefullscreen', accelerator:'F11' },
      { label:'DevTools', accelerator:'CmdOrCtrl+Shift+I', click:()=>mainWindow.webContents.toggleDevTools() },
      { type:'separator' }, { role:'zoomIn' }, { role:'zoomOut' }, { role:'resetZoom' },
    ]},
    { label:'Console', submenu:[
      { label:'GO',              accelerator:'Space',        click:()=>send('go') },
      { label:'Back',            accelerator:'Left',         click:()=>send('back') },
      { label:'Focus Cmd Line',  accelerator:'CmdOrCtrl+L',  click:()=>send('focus-cmd') },
      { label:'Select All',      accelerator:'CmdOrCtrl+A',  click:()=>send('select-all') },
      { label:'Clear Selection', accelerator:'Escape',       click:()=>send('clear-sel') },
    ]},
    { label:'Help', submenu:[
      { label:'Command Reference', click:()=>send('help') },
      { label:'About LightScript',  click:()=>dialog.showMessageBox(mainWindow,{type:'info',title:'LightScript',message:'LightScript v2.0',detail:'Scriptable DMX Lighting Console\nsACN (E1.31) + USB DMX output\nGDTF fixture library support'}) },
    ]},
  ]);
  Menu.setApplicationMenu(menu);
}

async function openShow() {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    filters:[{name:'LightScript Show',extensions:['lss']}], properties:['openFile'],
  });
  if (filePaths[0]) {
    const data = fs.readFileSync(filePaths[0], 'utf8');
    mainWindow.webContents.send('menu-action', 'load-show', data);
  }
}

// ── File I/O ─────────────────────────────────────────────────────────────────
ipcMain.handle('save-dialog',  async (_,name) => { const {filePath}=await dialog.showSaveDialog(mainWindow,{defaultPath:name||'myshow.lss',filters:[{name:'LightScript Show',extensions:['lss']}]}); return filePath||null; });
ipcMain.handle('write-file',   async (_,filePath,data) => { fs.writeFileSync(filePath,data,'utf8'); return true; });

// ── GDTF ─────────────────────────────────────────────────────────────────────
ipcMain.handle('gdtf-pick-folder', async () => { const{filePaths}=await dialog.showOpenDialog(mainWindow,{title:'Select GDTF Library Folder',properties:['openDirectory']}); return filePaths[0]||null; });
ipcMain.handle('gdtf-load-folder', async (_,folderPath) => loadGDTFFolder(folderPath));

// ── sACN ─────────────────────────────────────────────────────────────────────
ipcMain.handle('sacn-start',         (_,opts)         => sacn.start(opts||{}));
ipcMain.handle('sacn-stop',          ()               => { sacn.stop(); return {ok:true}; });
ipcMain.handle('sacn-push-fixtures', (_,fixtures)     => { if(!sacn.running)return{ok:false}; fixtures.forEach(f=>sacn.applyFixture(f)); return{ok:true}; });
ipcMain.handle('sacn-set-universe',  (_,univ,data)    => { if(!sacn.running)return{ok:false}; sacn.setUniverse(univ,Buffer.from(data)); return{ok:true}; });
ipcMain.handle('sacn-set-channel',   (_,u,ch,val)     => { sacn.setChannel(u,ch,val); return{ok:true}; });
ipcMain.handle('sacn-blackout',      ()               => { sacn.blackout(); return{ok:true}; });
ipcMain.handle('sacn-stats',         ()               => sacn.getStats());
ipcMain.handle('sacn-interfaces',    ()               => SACNEngine.getNetworkInterfaces());
ipcMain.handle('sacn-configure',     (_,opts)         => { if(opts.priority)sacn.priority=Math.max(1,Math.min(200,opts.priority)); if(opts.sourceName)sacn.sourceName=opts.sourceName; if(opts.fps)sacn.fps=Math.max(1,Math.min(44,opts.fps)); return{ok:true}; });

// ── USB DMX ───────────────────────────────────────────────────────────────────
ipcMain.handle('usbdmx-list-ports',    ()                           => USBDMXEngine.listSerialPorts());
ipcMain.handle('usbdmx-get-interfaces',()                           => USBDMXEngine.getInterfaces());
ipcMain.handle('usbdmx-connect',       (_,ifaceId,portOrIp,opts)    => usbDmx.connect(ifaceId,portOrIp,opts||{}));
ipcMain.handle('usbdmx-disconnect',    ()                           => { usbDmx.disconnect(); return{ok:true}; });
ipcMain.handle('usbdmx-push-fixtures', (_,fixtures)                 => { usbDmx.applyFixtures(fixtures); return{ok:true}; });
ipcMain.handle('usbdmx-set-buffer',    (_,data)                     => { usbDmx.setBuffer(data); return{ok:true}; });
ipcMain.handle('usbdmx-set-channel',   (_,ch,val)                   => { usbDmx.setChannel(ch,val); return{ok:true}; });
ipcMain.handle('usbdmx-blackout',      ()                           => { usbDmx.blackout(); return{ok:true}; });
ipcMain.handle('usbdmx-status',        ()                           => usbDmx.getStatus());

// ── Clipboard ─────────────────────────────────────────────────────────────────
const { clipboard } = require('electron');
ipcMain.handle('clipboard-read', () => clipboard.readText());

// Right-click context menu with paste
app.on('web-contents-created', (_, contents) => {
  contents.on('context-menu', (e, params) => {
    const menu = Menu.buildFromTemplate([
      { label: 'Cut',   role: 'cut',   enabled: params.editFlags.canCut   },
      { label: 'Copy',  role: 'copy',  enabled: params.editFlags.canCopy  },
      { label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { label: 'Select All', role: 'selectAll' },
    ]);
    menu.popup();
  });
});

// ── License ───────────────────────────────────────────────────────────────────
ipcMain.handle('license-load',       ()        => loadLicense(app));
ipcMain.handle('license-validate',   (_, key)  => validateKey(key));
ipcMain.handle('license-activate',   (_, key)  => activateLicense(key, app));
ipcMain.handle('license-deactivate', ()        => { deactivateLicense(app); return {ok:true}; });

// ── AI Proxy — Anthropic API key stored in userData, never exposed to renderer ─
const AI_KEY_FILE = path.join(app.getPath('userData'), 'ai_key.json');

function aiLoadConfig() {
  try { return JSON.parse(fs.readFileSync(AI_KEY_FILE,'utf8')); } catch(_) { return {}; }
}
function aiSaveConfig(cfg) {
  try { fs.writeFileSync(AI_KEY_FILE, JSON.stringify(cfg), 'utf8'); } catch(_) {}
}

ipcMain.handle('ai-has-key',   ()            => { const c=aiLoadConfig(); return { hasKey:!!c.key, provider:c.provider||'gemini' }; });
ipcMain.handle('ai-set-key',   (_, key, prov)=> { const c=aiLoadConfig(); aiSaveConfig({...c,key:key.trim(),provider:prov||c.provider||'gemini'}); return { ok:true }; });
ipcMain.handle('ai-clear-key', ()            => { try{fs.unlinkSync(AI_KEY_FILE);}catch(_){} return {ok:true}; });

// ── AI chat proxy — all API calls from main process, key never in renderer ────
ipcMain.handle('ai-chat', async (_, { messages, systemPrompt }) => {
  const https = require('https');
  const cfg = aiLoadConfig();
  const key = cfg.key; if (!key) return { ok:false, error:'no_key' };
  const provider = cfg.provider || 'gemini';

  // Build request params per provider
  let hostname, path_, headers, body;

  if (provider === 'gemini') {
    // Google Gemini — FREE tier (gemini-1.5-flash, 15 rpm, 1500/day)
    const model = 'gemini-1.5-flash';
    hostname = 'generativelanguage.googleapis.com';
    path_ = `/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
    headers = { 'Content-Type': 'application/json' };
    // Convert messages to Gemini format
    const geminiMsgs = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    body = JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: geminiMsgs,
      generationConfig: { maxOutputTokens: 1024, temperature: 0.7 },
    });
  } else if (provider === 'groq') {
    // Groq — FREE tier (llama-3.1-8b-instant, very fast)
    hostname = 'api.groq.com';
    path_ = '/openai/v1/chat/completions';
    headers = { 'Content-Type':'application/json', 'Authorization':`Bearer ${key}` };
    body = JSON.stringify({
      model: 'llama-3.1-8b-instant',
      max_tokens: 1024,
      messages: [{ role:'system', content:systemPrompt }, ...messages],
    });
  } else if (provider === 'openrouter') {
    // OpenRouter — free models available (meta-llama/llama-3.1-8b-instruct:free)
    hostname = 'openrouter.ai';
    path_ = '/api/v1/chat/completions';
    headers = { 'Content-Type':'application/json', 'Authorization':`Bearer ${key}`, 'HTTP-Referer':'https://lightscript.app', 'X-Title':'LightScript' };
    body = JSON.stringify({
      model: 'meta-llama/llama-3.1-8b-instruct:free',
      max_tokens: 1024,
      messages: [{ role:'system', content:systemPrompt }, ...messages],
    });
  } else {
    // Anthropic (claude-haiku — cheapest paid option)
    hostname = 'api.anthropic.com';
    path_ = '/v1/messages';
    headers = { 'Content-Type':'application/json', 'x-api-key':key, 'anthropic-version':'2023-06-01' };
    body = JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:1024, system:systemPrompt, messages });
  }

  headers['Content-Length'] = Buffer.byteLength(body);

  return new Promise(resolve => {
    const req = https.request({ hostname, path: path_, method:'POST', headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          let text = '';
          if (provider === 'gemini') {
            text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
            if (parsed.error) { resolve({ ok:false, error: parsed.error.message }); return; }
          } else if (provider === 'anthropic') {
            if (parsed.error) { resolve({ ok:false, error: parsed.error.message }); return; }
            text = parsed.content?.find(b=>b.type==='text')?.text || '';
          } else {
            // OpenAI-compatible (Groq, OpenRouter)
            if (parsed.error) { resolve({ ok:false, error: parsed.error.message||JSON.stringify(parsed.error) }); return; }
            text = parsed.choices?.[0]?.message?.content || '';
          }
          resolve({ ok:true, text, provider });
        } catch(e) { resolve({ ok:false, error:e.message+'\nRaw: '+data.slice(0,200) }); }
      });
    });
    req.on('error', e => resolve({ ok:false, error:e.message }));
    req.write(body); req.end();
  });
});

// ── ProPresenter OSC bridge (UDP) ──────────────────────────────────────────────
let _ppSocket = null;
ipcMain.handle('pp-connect', async (_, port) => {
  try {
    const dgram = require('dgram');
    if (_ppSocket) { try{_ppSocket.close();}catch(e){} _ppSocket=null; }
    _ppSocket = dgram.createSocket('udp4');
    _ppSocket.on('message', (msg) => {
      try {
        const addrEnd = msg.indexOf(0);
        if (addrEnd < 0) return;
        const addr = msg.slice(0, addrEnd).toString('ascii');
        if (!addr.includes('slide') && !addr.includes('current') && !addr.includes('presentation')) return;
        const pad4 = n => Math.ceil((n+1)/4)*4;
        let pos = pad4(addrEnd);
        const ttEnd = msg.indexOf(0, pos);
        pos = pad4(ttEnd);
        const strEnd = msg.indexOf(0, pos);
        const slideStr = msg.slice(pos, strEnd > pos ? strEnd : msg.length).toString('utf8').trim();
        if (slideStr && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.executeJavaScript(
            `try{const e=document.getElementById('pp-last-slide');if(e)e.textContent=${JSON.stringify(slideStr)};if(typeof ppHandleSlide==='function')ppHandleSlide({name:${JSON.stringify(slideStr)}});}catch(e){}`
          ).catch(()=>{});
        }
      } catch(e) {}
    });
    _ppSocket.bind(port || 9999, '0.0.0.0');
    return { ok: true, port: port || 9999 };
  } catch(e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('remote-start',      (_, port, passcode) => remote.start(port || 8080, passcode || ''));
ipcMain.handle('remote-stop',       ()                  => { remote.stop(); return { ok: true }; });
ipcMain.handle('remote-status',     ()                  => remote.getStatus());
ipcMain.handle('remote-broadcast',  (_, state)          => { remote.broadcast(state); return { ok: true }; });
ipcMain.handle('remote-passcode',   (_, p)              => { remote.setPasscode(p); return { ok: true }; });

// Forward remote commands from web clients into the renderer
remote.onCommand = (cmdStr) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('remote-command', cmdStr);
  }
};

// ── Lifecycle ─────────────────────────────────────────────────────────────────
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { sacn.stop(); usbDmx.disconnect(); remote.stop(); if(process.platform!=='darwin')app.quit(); });
app.on('activate',          () => { if(BrowserWindow.getAllWindows().length===0)createWindow(); });
app.on('before-quit',       () => { sacn.stop(); usbDmx.disconnect(); remote.stop(); });
