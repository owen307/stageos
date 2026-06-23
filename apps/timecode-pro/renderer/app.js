'use strict';

// ─────────────────────────────────────────────
//  CONSTANTS
// ─────────────────────────────────────────────
const CUE_TYPES = {
  audio:  { icon: '🔊', label: 'Audio'  },
  video:  { icon: '🎬', label: 'Video'  },
  midi:   { icon: '🎹', label: 'MIDI'   },
  osc:    { icon: '📡', label: 'OSC'    },
  fade:   { icon: '📉', label: 'Fade'   },
  wait:   { icon: '⏱',  label: 'Wait'   },
  group:  { icon: '📁', label: 'Group'  },
};
const CUE_COLORS = ['#00e5ff','#39ff80','#ff6b35','#ffd166','#a78bfa','#ff3a5c','#4ecdc4'];
const DEFAULT_FPS = 30;

// ─────────────────────────────────────────────
//  GLOBAL STATE
// ─────────────────────────────────────────────
let state = {
  show: { name: 'Untitled Show', fps: DEFAULT_FPS, cues: [], boothShows: [] },
  playback: { running: false, paused: false, frames: 0, lastRaf: null },
  ui: { selectedCueId: null, dirty: false },
  nextCueIndex: 0,
  recording: false,
  recordedEvents: [],    // { tc, tcFrames, type:'osc'|'midi', address, args, raw }
  osc: { running: false },
  midi: { inputOpen: false, outputOpen: false },
  video: { windowOpen: false, currentCueId: null },
  boothShows: [],        // [{ name, scenes:[{ name, duration, cues:[{name,time,osc,device}] }] }]
  selShow: -1, selScene: -1, selSceneCue: -1,
};

let audioCtx = null;
let audioBuffers = {};
let activeSources = {};
let rafHandle = null;
let _tcTick = 0;

// ─────────────────────────────────────────────
//  TIMECODE
// ─────────────────────────────────────────────
function pad(n) { return String(n).padStart(2,'0'); }
function framesToTC(f, fps) {
  fps = fps || state.show.fps;
  const s = Math.floor(f/fps);
  return `${pad(Math.floor(s/3600))}:${pad(Math.floor(s/60)%60)}:${pad(s%60)}:${pad(Math.floor(f%fps))}`;
}
function tcToFrames(tc, fps) {
  fps = fps || state.show.fps;
  const p = tc.replace(/[;,]/g,':').split(':');
  if (p.length < 4) return 0;
  return ((+p[0])*3600 + (+p[1])*60 + (+p[2]))*fps + (+p[3]);
}
function fmtDur(f, fps) {
  fps = fps || state.show.fps;
  if (!f || f <= 0) return '--:--';
  const s = f/fps;
  return s < 60 ? s.toFixed(1)+'s' : `${pad(Math.floor(s/60))}:${pad(Math.floor(s%60))}`;
}
function parseDur(str, fps) {
  fps = fps || state.show.fps;
  if (!str) return 0;
  if (str.includes(':')) return tcToFrames(str, fps);
  if (str.endsWith('s')) return parseFloat(str)*fps;
  return (parseFloat(str)||0)*fps;
}

// ─────────────────────────────────────────────
//  TAB NAVIGATION
// ─────────────────────────────────────────────
function showTab(id) {
  document.querySelectorAll('.tab-page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const pg = document.getElementById(id);
  if (pg) pg.classList.add('active');
  const btn = [...document.querySelectorAll('.nav-btn')].find(b => b.textContent.toLowerCase().includes(
    id==='booth'?'control':id==='osc-midi'?'osc':id
  ));
  if (btn) btn.classList.add('active');
}

function showSubTab(parent, id) {
  const container = document.getElementById(parent) || document.body;
  container.querySelectorAll('.sub-page').forEach(p => p.classList.remove('active'));
  container.querySelectorAll('.sub-btn').forEach(b => b.classList.remove('active'));
  const pg = document.getElementById(id);
  if (pg) pg.classList.add('active');
  event.target.classList.add('active');
}

// ─────────────────────────────────────────────
//  SHOW FILE
// ─────────────────────────────────────────────
function markDirty()  { state.ui.dirty=true;  document.getElementById('showDirty').textContent='●'; }
function markClean()  { state.ui.dirty=false; document.getElementById('showDirty').textContent=''; }

async function saveShow() {
  const eAPI = window.api;
  if (!eAPI) return;
  const path = await eAPI.saveShowDialog({ ...state.show, boothShows: state.boothShows });
  if (path) { markClean(); setStatus(`Saved: ${path}`); }
}

async function openShow() {
  const eAPI = window.api;
  if (!eAPI) return;
  const data = await eAPI.openShowDialog();
  if (!data) return;
  stopPlayback();
  state.show = data;
  state.boothShows = data.boothShows || [];
  state.ui.selectedCueId = null;
  state.nextCueIndex = 0;
  state.playback.frames = 0;
  markClean();
  document.getElementById('fpsSelect').value = data.fps || DEFAULT_FPS;
  renderAll();
  setStatus(`Loaded show: ${data.name}`);
}

// ─────────────────────────────────────────────
//  CLOCK / PLAYBACK
// ─────────────────────────────────────────────
function updateClock() {
  const tc = framesToTC(Math.floor(state.playback.frames));
  document.getElementById('tcClock').textContent = tc;
  if (++_tcTick % 8 === 0) {
    const eAPI = window.api;
    if (eAPI && state.video.windowOpen) eAPI.videoCommand({ type:'tc-tick', tc });
  }
}

function togglePlay() {
  if (state.playback.running) pausePlayback(); else startPlayback();
}
function startPlayback() {
  if (state.playback.running && !state.playback.paused) return;
  state.playback.running = true; state.playback.paused = false;
  state.playback.lastRaf = null;
  document.getElementById('btnPlay').textContent = '⏸';
  rafHandle = requestAnimationFrame(tick);
  setStatus('Playing…');
}
function pausePlayback() {
  state.playback.running = false; state.playback.paused = true;
  cancelAnimationFrame(rafHandle);
  document.getElementById('btnPlay').textContent = '▶';
  setStatus('Paused.');
}
function stopPlayback() {
  state.playback.running = false; state.playback.paused = false;
  cancelAnimationFrame(rafHandle);
  for (const src of Object.values(activeSources)) { try { src.stop(); } catch(e) {} }
  activeSources = {};
  stopVideoPlayback();
  state.show.cues.forEach(c => { if (c.status==='playing') c.status='ready'; });
  state.nextCueIndex = 0;
  document.getElementById('btnPlay').textContent = '▶';
  renderCueList(); setStatus('Stopped.');
}
function rewindToStart() {
  stopPlayback();
  state.playback.frames = 0;
  state.show.cues.forEach(c => c.status='ready');
  state.nextCueIndex = 0;
  updateClock(); renderCueList(); updateStatusBar();
}
function fullStop() { stopPlayback(); rewindToStart(); }

function tick(ts) {
  if (!state.playback.running) return;
  if (!state.playback.lastRaf) { state.playback.lastRaf = ts; rafHandle = requestAnimationFrame(tick); return; }
  const delta = ts - state.playback.lastRaf;
  state.playback.lastRaf = ts;
  state.playback.frames += (delta/1000) * state.show.fps;
  updateClock();
  maybeBroadcastTc();
  checkTimecodeTrigggers();
  drawTimeline();
  rafHandle = requestAnimationFrame(tick);
}

function checkTimecodeTrigggers() {
  const now = state.playback.frames;
  state.show.cues.forEach(c => {
    if (c.triggerMode !== 'timecode') return;
    if (c.status === 'playing' || c.status === 'done') return;
    if (now >= c.tcIn && now < c.tcIn + 1) fireCue(c);
  });
}

function goNextCue() {
  const cues = state.show.cues;
  if (state.nextCueIndex >= cues.length) { setStatus('End of cue list.'); return; }
  fireCue(cues[state.nextCueIndex++]);
  if (!state.playback.running) startPlayback();
  updateStatusBar();
}

function onFpsChange() {
  state.show.fps = parseFloat(document.getElementById('fpsSelect').value);
  markDirty(); drawTimeline();
}

// ─────────────────────────────────────────────
//  CUE MANAGEMENT
// ─────────────────────────────────────────────
function createCue(type, overrides) {
  const n = state.show.cues.length + 1;
  return Object.assign({
    id: `cue_${Date.now()}_${Math.random().toString(36).slice(2,5)}`,
    type, number: n,
    name: `${CUE_TYPES[type]?.label||type} ${n}`,
    tcIn: 0, duration: type==='wait' ? state.show.fps : 0,
    triggerMode: 'manual', autoFollow: false,
    volume: 1, pitch: 1, loop: false, fadeIn: 0, fadeOut: 0,
    filePath: null, videoFit: 'contain', color: null, notes: '',
    // OSC
    oscAddress: '/cue/fire', oscArgs: '[]',
    // MIDI
    midiStatus: 144, midiData1: 60, midiData2: 127,
    status: 'ready', flagged: false,
  }, overrides || {});
}

function addCue(type) {
  const cue = createCue(type);
  const si = state.show.cues.findIndex(c => c.id === state.ui.selectedCueId);
  if (si >= 0) state.show.cues.splice(si+1, 0, cue);
  else state.show.cues.push(cue);
  renumber();
  state.ui.selectedCueId = cue.id;
  markDirty(); renderCueList(); renderInspector(); drawTimeline(); updateStatusBar();
  setStatus(`Added ${CUE_TYPES[type].label} cue: "${cue.name}"`);
}

function renumber() { state.show.cues.forEach((c,i) => c.number=i+1); }
function getCue(id) { return state.show.cues.find(c => c.id===id); }

function updateCue(id, changes) {
  const c = getCue(id);
  if (!c) return;
  Object.assign(c, changes);
  markDirty(); renderCueRow(id); drawTimeline(); updateStatusBar();
}

function deleteSelectedCue() {
  const id = state.ui.selectedCueId;
  if (!id) return;
  const i = state.show.cues.findIndex(c => c.id===id);
  if (i < 0) return;
  if (!confirm(`Delete "${state.show.cues[i].name}"?`)) return;
  state.show.cues.splice(i, 1);
  renumber();
  state.ui.selectedCueId = (state.show.cues[i]||state.show.cues[i-1]||{}).id||null;
  markDirty(); renderCueList(); renderInspector(); drawTimeline(); updateStatusBar();
}

function selectCue(id) {
  state.ui.selectedCueId = id;
  document.querySelectorAll('.cue-row').forEach(el => el.classList.toggle('selected', el.dataset.id===id));
  renderInspector();
}

// ─────────────────────────────────────────────
//  CUE FIRING
// ─────────────────────────────────────────────
function fireCue(cue) {
  cue.status = 'playing';
  renderCueRow(cue.id);
  const row = document.querySelector(`.cue-row[data-id="${cue.id}"]`);
  if (row) { row.classList.add('fired'); setTimeout(() => row.classList.remove('fired'), 400); }

  switch(cue.type) {
    case 'audio':  playAudioCue(cue);  break;
    case 'video':  playVideoCue(cue);  break;
    case 'midi':   fireMidiCue(cue);   break;
    case 'osc':    fireOscCue(cue);    break;
    case 'wait':   fireWaitCue(cue);   break;
    default:       autoDone(cue);      break;
  }
  setStatus(`▶ Fired: "${cue.name}"`);
}

function autoDone(cue) {
  const dur = cue.duration > 0 ? cue.duration : state.show.fps;
  setTimeout(() => { if (cue.status==='playing') { cue.status='done'; renderCueRow(cue.id); } }, dur/state.show.fps*1000);
}

function fireWaitCue(cue) {
  const dur = cue.duration > 0 ? cue.duration : state.show.fps;
  setTimeout(() => {
    cue.status = 'done'; renderCueRow(cue.id);
    if (cue.autoFollow) { const i=state.show.cues.findIndex(c=>c.id===cue.id); if(i>=0&&i+1<state.show.cues.length) fireCue(state.show.cues[i+1]); }
  }, dur/state.show.fps*1000);
}

function playAudioCue(cue) {
  if (!cue.filePath) { autoDone(cue); return; }
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioBuffers[cue.id]) { _playBuf(cue, audioBuffers[cue.id]); return; }
  const eAPI = window.api;
  if (eAPI) {
    eAPI.readFile(cue.filePath).then(buf => {
      if (!buf) { cue.status='broken'; renderCueRow(cue.id); return; }
      audioCtx.decodeAudioData(buf.buffer||buf, dec => { audioBuffers[cue.id]=dec; _playBuf(cue,dec); });
    });
  } else autoDone(cue);
}
function _playBuf(cue, buf) {
  const gain = audioCtx.createGain(); gain.gain.value = cue.volume||1; gain.connect(audioCtx.destination);
  const src = audioCtx.createBufferSource(); src.buffer=buf; src.playbackRate.value=cue.pitch||1; src.loop=!!cue.loop;
  if (cue.fadeIn>0) { gain.gain.setValueAtTime(0,audioCtx.currentTime); gain.gain.linearRampToValueAtTime(cue.volume,audioCtx.currentTime+cue.fadeIn/state.show.fps); }
  src.connect(gain); src.start(0);
  activeSources[cue.id] = src;
  src.onended = () => { cue.status='done'; renderCueRow(cue.id); delete activeSources[cue.id]; };
  if (!cue.duration && !cue.loop) { cue.duration=Math.round(buf.duration*state.show.fps); renderCueRow(cue.id); }
}

function fireOscCue(cue) {
  const eAPI = window.api;
  if (!eAPI || !state.osc.running) { setStatus(`OSC not running — cue: ${cue.oscAddress}`); autoDone(cue); return; }
  try {
    const args = JSON.parse(cue.oscArgs||'[]');
    eAPI.oscSend(cue.oscAddress, args).then(r => {
      if (r.ok) setStatus(`OSC sent: ${cue.oscAddress}`);
      else setStatus(`OSC error: ${r.error}`);
    });
  } catch(e) { setStatus(`OSC args parse error: ${e.message}`); }
  autoDone(cue);
}

function fireMidiCue(cue) {
  const eAPI = window.api;
  if (!eAPI || !state.midi.outputOpen) {
    // Fallback to Web MIDI
    if (navigator.requestMIDIAccess) {
      navigator.requestMIDIAccess().then(acc => {
        const outs = Array.from(acc.outputs.values());
        if (outs.length) {
          outs[0].send([cue.midiStatus, cue.midiData1, cue.midiData2]);
          const dur = (cue.duration>0?cue.duration:state.show.fps)/state.show.fps*1000;
          setTimeout(() => { outs[0].send([cue.midiStatus&0xF0|0x80, cue.midiData1, 0]); cue.status='done'; renderCueRow(cue.id); }, dur);
        } else autoDone(cue);
      }).catch(() => autoDone(cue));
    } else autoDone(cue);
    return;
  }
  eAPI.midiSend(cue.midiStatus, cue.midiData1, cue.midiData2);
  const dur = (cue.duration>0?cue.duration:state.show.fps)/state.show.fps*1000;
  setTimeout(() => {
    eAPI.midiSend(cue.midiStatus & 0xF0 | 0x80, cue.midiData1, 0);
    cue.status='done'; renderCueRow(cue.id);
  }, dur);
}

async function playVideoCue(cue) {
  if (!cue.filePath) { autoDone(cue); setStatus('⚠ Video cue has no file.'); return; }
  const eAPI = window.api;
  if (!eAPI) { autoDone(cue); return; }
  if (!state.video.windowOpen) { await eAPI.videoWindowOpen(); state.video.windowOpen=true; updateVideoBtn(); }
  const url = await eAPI.pathToUrl(cue.filePath);
  await eAPI.videoCommand({ type:'load-and-play', cue:{ name:cue.name, fileUrl:url, volume:cue.volume, loop:cue.loop, fit:cue.videoFit } });
  state.video.currentCueId = cue.id;
  if (!cue.loop && cue.duration>0) {
    setTimeout(() => { if (cue.status==='playing') { cue.status='done'; renderCueRow(cue.id); state.video.currentCueId=null; } }, cue.duration/state.show.fps*1000);
  }
}
function stopVideoPlayback() {
  const eAPI = window.api;
  if (eAPI && state.video.windowOpen) eAPI.videoCommand({ type:'stop' });
  if (state.video.currentCueId) { const c=getCue(state.video.currentCueId); if(c){c.status='ready';renderCueRow(c.id);} state.video.currentCueId=null; }
}

// ─────────────────────────────────────────────
//  CUE LIST RENDERING
// ─────────────────────────────────────────────
function renderCueList() {
  const list = document.getElementById('cue-list');
  list.innerHTML = '';
  state.show.cues.forEach(c => list.appendChild(makeCueRowEl(c)));
  updateStatusBar();
}

function makeCueRowEl(cue) {
  const tmpl = document.getElementById('tmpl-cue-row');
  const el = tmpl.content.cloneNode(true).querySelector('.cue-row');
  el.dataset.id = cue.id;
  if (cue.id===state.ui.selectedCueId) el.classList.add('selected');
  if (cue.status==='playing') el.classList.add('playing');
  el.querySelector('.cue-num').textContent = String(cue.number).padStart(3,' ');
  el.querySelector('.cue-icon').textContent = CUE_TYPES[cue.type]?.icon||'?';
  el.querySelector('.cue-name-txt').textContent = cue.name;
  el.querySelector('.cue-tc').textContent = cue.tcIn>0||cue.triggerMode==='timecode' ? framesToTC(cue.tcIn) : '—';
  el.querySelector('.cue-dur').textContent = fmtDur(cue.duration);
  const badge = el.querySelector('.cue-badge');
  badge.textContent = cue.status.toUpperCase();
  badge.className = `cue-badge s-${cue.status}`;
  el.addEventListener('click', () => selectCue(cue.id));
  el.addEventListener('dblclick', () => fireCue(cue));
  el.addEventListener('contextmenu', e => { e.preventDefault(); showCueMenu(e, cue.id); });
  el.addEventListener('dragstart', e => e.dataTransfer.setData('cueId', cue.id));
  el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('drag-over'); });
  el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
  el.addEventListener('drop', e => { e.preventDefault(); el.classList.remove('drag-over'); moveCue(e.dataTransfer.getData('cueId'), cue.id); });
  return el;
}

function renderCueRow(id) {
  const cue = getCue(id);
  if (!cue) return;
  const ex = document.querySelector(`.cue-row[data-id="${id}"]`);
  if (ex) ex.replaceWith(makeCueRowEl(cue));
  updateStatusBar();
}

function moveCue(fromId, toId) {
  if (fromId===toId) return;
  const cues=state.show.cues, fi=cues.findIndex(c=>c.id===fromId), ti=cues.findIndex(c=>c.id===toId);
  if(fi<0||ti<0)return;
  const [c]=cues.splice(fi,1); cues.splice(ti,0,c);
  renumber(); markDirty(); renderCueList(); drawTimeline();
}

// ─────────────────────────────────────────────
//  INSPECTOR
// ─────────────────────────────────────────────
function renderInspector() {
  const cue = getCue(state.ui.selectedCueId);
  const pane = document.getElementById('inspectorContent');
  if (!cue) {
    pane.className='insp-empty';
    pane.innerHTML='<div style="font-size:28px;opacity:0.2">◈</div><span>No cue selected</span>';
    return;
  }
  pane.className=''; pane.innerHTML='';
  const scroll = mk('div','insp-scroll');

  // Identity
  scroll.appendChild(insSec('Identity',[
    insField('Name', inpEl('text',cue.name,v=>updateCue(cue.id,{name:v}))),
    insField('Type', `<span style="color:var(--accent)">${CUE_TYPES[cue.type]?.icon} ${CUE_TYPES[cue.type]?.label}</span>`),
    insField('Notes', taEl(cue.notes, v=>updateCue(cue.id,{notes:v}))),
  ]));

  // Timecode
  scroll.appendChild(insSec('Timecode',[
    insField('Trigger', triggerPills(cue)),
    insField('TC In', inpEl('text',framesToTC(cue.tcIn),v=>updateCue(cue.id,{tcIn:tcToFrames(v)}),'tc')),
    insField('Duration', inpEl('text',fmtDur(cue.duration),v=>updateCue(cue.id,{duration:parseDur(v)}))),
  ]));

  // Type-specific
  if (cue.type==='audio'||cue.type==='video') buildMediaFields(scroll, cue);
  if (cue.type==='osc')  buildOscFields(scroll, cue);
  if (cue.type==='midi') buildMidiFields(scroll, cue);
  if (cue.type==='wait') scroll.appendChild(insSec('Wait',[
    insField('Duration (s)', inpEl('number',(cue.duration/state.show.fps).toFixed(2),v=>updateCue(cue.id,{duration:parseFloat(v)*state.show.fps}))),
    insField('Auto Follow', chkEl(cue.autoFollow,v=>updateCue(cue.id,{autoFollow:v}))),
  ]));

  pane.appendChild(scroll);
  const fb = mk('button','fire-btn'); fb.textContent='▶  FIRE CUE'; fb.onclick=()=>fireCue(cue); pane.appendChild(fb);
}

function buildMediaFields(scroll, cue) {
  const sec = insSec('Media',[]);
  // File picker
  const fd = mk('div','insp-field');
  const fl = mk('div','f-lbl'); fl.textContent='File';
  const fi = mk('input','f-inp'); fi.type='text'; fi.readOnly=true; fi.style.cursor='pointer';
  fi.value=cue.filePath||''; fi.placeholder='Click to browse…';
  fi.onclick = async () => {
    const eAPI=window.api; if(!eAPI) return;
    const ext = cue.type==='audio' ? [{name:'Audio',extensions:['mp3','wav','aiff','ogg','flac','m4a']}] : [{name:'Video',extensions:['mp4','mov','avi','mkv','webm']}];
    const p = await eAPI.openFileDialog({filters:ext});
    if(p){updateCue(cue.id,{filePath:p});fi.value=p;}
  };
  fd.appendChild(fl); fd.appendChild(fi); sec.appendChild(fd);
  sec.appendChild(insField('Volume', sliderEl(cue.volume,0,1,0.01,v=>updateCue(cue.id,{volume:parseFloat(v)}))));
  if (cue.type==='audio') {
    sec.appendChild(insField('Pitch', sliderEl(cue.pitch,0.25,4,0.01,v=>updateCue(cue.id,{pitch:parseFloat(v)}))));
    sec.appendChild(insField('Fade In (fr)', inpEl('number',cue.fadeIn,v=>updateCue(cue.id,{fadeIn:parseInt(v)||0}))));
    sec.appendChild(insField('Loop', chkEl(cue.loop,v=>updateCue(cue.id,{loop:v}))));
  }
  if (cue.type==='video') {
    sec.appendChild(insField('Loop', chkEl(cue.loop,v=>updateCue(cue.id,{loop:v}))));
    const fd2=mk('div','insp-field'), fl2=mk('div','f-lbl'); fl2.textContent='Fit Mode';
    const sel=mk('select','f-inp'); sel.style.fontFamily='var(--font-mono)'; sel.style.fontSize='11px';
    ['contain','cover','fill','none'].forEach(o=>{const opt=mk('option');opt.value=o;opt.textContent=o.charAt(0).toUpperCase()+o.slice(1);if(cue.videoFit===o)opt.selected=true;sel.appendChild(opt);});
    sel.onchange=e=>{updateCue(cue.id,{videoFit:e.target.value});const ea=window.api;if(ea&&state.video.windowOpen)ea.videoCommand({type:'fit',value:e.target.value});};
    fd2.appendChild(fl2);fd2.appendChild(sel);sec.appendChild(fd2);
  }
  scroll.appendChild(sec);
}

function buildOscFields(scroll, cue) {
  scroll.appendChild(insSec('OSC',[
    insField('Address', inpEl('text',cue.oscAddress,v=>updateCue(cue.id,{oscAddress:v}))),
    insField('Args (JSON)', inpEl('text',cue.oscArgs,v=>updateCue(cue.id,{oscArgs:v}))),
  ]));
}

function buildMidiFields(scroll, cue) {
  scroll.appendChild(insSec('MIDI',[
    insField('Status', inpEl('number',cue.midiStatus,v=>updateCue(cue.id,{midiStatus:parseInt(v)||144}))),
    insField('Data 1 (Note)', inpEl('number',cue.midiData1,v=>updateCue(cue.id,{midiData1:parseInt(v)||60}))),
    insField('Data 2 (Vel)', inpEl('number',cue.midiData2,v=>updateCue(cue.id,{midiData2:parseInt(v)||127}))),
  ]));
}

// Inspector helpers
function mk(tag,cls){const e=document.createElement(tag);if(cls)e.className=cls;return e;}
function insSec(title,fields){const s=mk('div','insp-section'),t=mk('div','insp-sec-title');t.textContent=title;s.appendChild(t);fields.forEach(f=>{if(f)s.appendChild(f);});return s;}
function insField(lbl,content){const r=mk('div','insp-field'),l=mk('div','f-lbl');l.textContent=lbl;r.appendChild(l);if(typeof content==='string'){const v=mk('div');v.style.fontSize='11px';v.innerHTML=content;r.appendChild(v);}else r.appendChild(content);return r;}
function inpEl(type,val,onChange,extraCls){const i=mk('input','f-inp'+(extraCls?' '+extraCls:''));i.type=type;i.value=val;if(type==='number')i.step='any';i.onchange=e=>onChange(e.target.value);return i;}
function taEl(val,onChange){const t=mk('textarea','f-inp');t.value=val||'';t.rows=2;t.style.cssText='resize:vertical;font-family:var(--font-mono);font-size:11px;';t.onchange=e=>onChange(e.target.value);return t;}
function sliderEl(val,mn,mx,step,onChange){const w=mk('div'),s=mk('input','f-slider'),v=mk('span');s.type='range';s.min=mn;s.max=mx;s.step=step;s.value=val;v.style.cssText='font-family:var(--font-mono);font-size:10px;color:var(--text2);margin-left:6px;';v.textContent=parseFloat(val).toFixed(2);s.oninput=e=>{v.textContent=parseFloat(e.target.value).toFixed(2);onChange(e.target.value);};w.appendChild(s);w.appendChild(v);return w;}
function chkEl(val,onChange){const w=mk('label');w.style.cssText='display:flex;align-items:center;gap:8px;cursor:pointer;';const c=mk('input');c.type='checkbox';c.checked=!!val;c.style.cursor='pointer';const l=mk('span');l.style.cssText='font-family:var(--font-mono);font-size:10px;color:var(--text2);';l.textContent=val?'Enabled':'Disabled';c.onchange=e=>{l.textContent=e.target.checked?'Enabled':'Disabled';onChange(e.target.checked);};w.appendChild(c);w.appendChild(l);return w;}
function triggerPills(cue){const w=mk('div','trigger-pills');['manual','timecode','follow'].forEach(m=>{const p=mk('div','t-pill'+(cue.triggerMode===m?' active':''));p.textContent=m.charAt(0).toUpperCase()+m.slice(1);p.onclick=()=>{updateCue(cue.id,{triggerMode:m});renderInspector();};w.appendChild(p);});return w;}

// ─────────────────────────────────────────────
//  TIMELINE CANVAS
// ─────────────────────────────────────────────
function drawTimeline() {
  const canvas = document.getElementById('timeline-canvas');
  const container = canvas.parentElement;
  canvas.width = container.offsetWidth;
  canvas.height = container.offsetHeight;
  const ctx = canvas.getContext('2d');
  const W=canvas.width, H=canvas.height, fps=state.show.fps;
  const viewDur=fps*120, viewStart=Math.max(0,state.playback.frames-viewDur*0.15), ppf=W/viewDur;
  ctx.fillStyle='#07080e'; ctx.fillRect(0,0,W,H);
  // second grid
  ctx.strokeStyle='rgba(255,255,255,0.05)'; ctx.lineWidth=1;
  for(let f=Math.floor(viewStart/fps)*fps;f<=viewStart+viewDur;f+=fps){const x=(f-viewStart)*ppf;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}
  // 10-sec labels
  const ten=fps*10;
  for(let f=Math.floor(viewStart/ten)*ten;f<=viewStart+viewDur;f+=ten){
    const x=(f-viewStart)*ppf;
    ctx.strokeStyle='rgba(255,255,255,0.1)';ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();
    ctx.fillStyle='rgba(120,120,160,0.6)';ctx.font='9px JetBrains Mono,monospace';ctx.fillText(framesToTC(f),x+3,11);
  }
  // cue bars
  const barY=18;
  state.show.cues.forEach(c=>{
    const x=(c.tcIn-viewStart)*ppf; if(x<-20||x>W+20)return;
    const color=c.color||typeColor(c.type);
    if(c.duration>0){const w=Math.max(2,c.duration*ppf);ctx.fillStyle=hexA(color,0.18);ctx.fillRect(x,barY,w,H-barY-2);}
    ctx.strokeStyle=color;ctx.lineWidth=c.id===state.ui.selectedCueId?2:1;
    ctx.beginPath();ctx.moveTo(x,barY);ctx.lineTo(x,H);ctx.stroke();
    ctx.fillStyle=color;ctx.font='9px JetBrains Mono,monospace';ctx.fillText(c.name.slice(0,12),x+3,barY+11);
  });
  // playhead
  const phX=(state.playback.frames-viewStart)*ppf;
  document.getElementById('playhead').style.left=phX+'px';
}

function typeColor(t){return{audio:'#00e5ff',video:'#a78bfa',midi:'#ffd166',osc:'#39ff80',fade:'#ff6b35',wait:'#4ecdc4',group:'#ff3a5c'}[t]||'#fff';}
function hexA(hex,a){const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);return `rgba(${r},${g},${b},${a})`;}

// ─────────────────────────────────────────────
//  OSC ENGINE (main process bridge)
// ─────────────────────────────────────────────
async function startOsc() {
  const eAPI = window.api; if(!eAPI){setStatus('No Electron API');return;}
  const cfg = {
    localPort: parseInt(document.getElementById('oscLocalPort').value)||9000,
    remoteHost: document.getElementById('oscRemoteHost').value||'127.0.0.1',
    remotePort: parseInt(document.getElementById('oscRemotePort').value)||8000,
  };
  const r = await eAPI.oscStart(cfg);
  if (r.ok) {
    state.osc.running = true;
    document.getElementById('oscPill').textContent='OSC ON';
    document.getElementById('oscPill').classList.add('on');
    document.getElementById('oscStatusMsg').textContent=`Listening on :${cfg.localPort} → ${cfg.remoteHost}:${cfg.remotePort}`;
    setStatus(`OSC started on port ${cfg.localPort}`);
  } else {
    document.getElementById('oscStatusMsg').textContent='Error: '+r.error;
    setStatus('OSC error: '+r.error);
  }
}

async function stopOsc() {
  const eAPI = window.api; if(!eAPI) return;
  await eAPI.oscStop();
  state.osc.running = false;
  document.getElementById('oscPill').textContent='OSC OFF';
  document.getElementById('oscPill').classList.remove('on');
  document.getElementById('oscStatusMsg').textContent='Stopped.';
  setStatus('OSC stopped.');
}

function toggleOsc() { state.osc.running ? stopOsc() : startOsc(); }

async function sendOscNow() {
  const eAPI=window.api; if(!eAPI) return;
  const addr=document.getElementById('osc-send-addr').value;
  let args=[];
  try { args=JSON.parse(document.getElementById('osc-send-args').value||'[]'); } catch(e){setStatus('Args JSON invalid');return;}
  const r=await eAPI.oscSend(addr,args);
  document.getElementById('osc-send-status').textContent=r.ok?`Sent ${addr}`:`Error: ${r.error}`;
}

// ─────────────────────────────────────────────
//  MIDI ENGINE
// ─────────────────────────────────────────────
async function refreshMidi() {
  const eAPI=window.api; if(!eAPI) return;
  const {inputs,outputs,error}=await eAPI.midiGetPorts();
  if(error){document.getElementById('midiStatusMsg').textContent='Error: '+error;return;}
  const inSel=document.getElementById('midiInSel'), outSel=document.getElementById('midiOutSel');
  inSel.innerHTML='<option>— none —</option>';
  outSel.innerHTML='<option>— none —</option>';
  inputs.forEach((n,i)=>{const o=mk('option');o.value=i;o.textContent=n;inSel.appendChild(o);});
  outputs.forEach((n,i)=>{const o=mk('option');o.value=i;o.textContent=n;outSel.appendChild(o);});
  document.getElementById('midiStatusMsg').textContent=`${inputs.length} in, ${outputs.length} out`;
}

async function openMidiIn() {
  const eAPI=window.api; if(!eAPI) return;
  const idx=parseInt(document.getElementById('midiInSel').value);
  if(isNaN(idx)){return;}
  const r=await eAPI.midiOpenInput(idx);
  if(r.ok){state.midi.inputOpen=true;updateMidiPill();document.getElementById('midiStatusMsg').textContent='MIDI In open.';}
  else document.getElementById('midiStatusMsg').textContent='Error: '+r.error;
}

async function openMidiOut() {
  const eAPI=window.api; if(!eAPI) return;
  const idx=parseInt(document.getElementById('midiOutSel').value);
  if(isNaN(idx)){return;}
  const r=await eAPI.midiOpenOutput(idx);
  if(r.ok){state.midi.outputOpen=true;updateMidiPill();document.getElementById('midiStatusMsg').textContent='MIDI Out open.';}
  else document.getElementById('midiStatusMsg').textContent='Error: '+r.error;
}

async function closeMidi() {
  const eAPI=window.api; if(!eAPI) return;
  await eAPI.midiClose();
  state.midi.inputOpen=false; state.midi.outputOpen=false;
  updateMidiPill();
  document.getElementById('midiStatusMsg').textContent='MIDI closed.';
}

function openMidiSettings() { showTab('osc-midi'); showSubTab('osc-midi','midi-config-tab'); }

function updateMidiPill() {
  const on=state.midi.inputOpen||state.midi.outputOpen;
  const pill=document.getElementById('midiPill');
  pill.textContent=on?'MIDI ON':'MIDI OFF';
  pill.classList.toggle('on',on);
}

async function sendMidiNow() {
  const eAPI=window.api; if(!eAPI){setStatus('No API');return;}
  const s=parseInt(document.getElementById('midi-status').value)||144;
  const d1=parseInt(document.getElementById('midi-d1').value)||60;
  const d2=parseInt(document.getElementById('midi-d2').value)||127;
  const r=await eAPI.midiSend(s,d1,d2);
  document.getElementById('midi-send-status').textContent=r.ok?`Sent [${s},${d1},${d2}]`:`Error: ${r.error}`;
}

// ─────────────────────────────────────────────
//  RECORD ENGINE
// ─────────────────────────────────────────────
function toggleRecord() {
  state.recording = !state.recording;
  const pill = document.getElementById('recPill');
  const btn  = document.getElementById('recBtn');
  pill.classList.toggle('on', state.recording);
  if (btn) btn.classList.toggle('on', state.recording);
  setStatus(state.recording ? '⏺ Recording OSC/MIDI…' : 'Recording stopped.');
  if (state.recording && !state.playback.running) startPlayback();
}

function onOscIn(data) {
  // Add to live monitor
  addMonitorRow('osc', framesToTC(Math.floor(state.playback.frames)), data.address, JSON.stringify(data.args));
  // Record if active
  if (state.recording) {
    state.recordedEvents.push({ tc: framesToTC(Math.floor(state.playback.frames)), tcFrames: Math.floor(state.playback.frames), type:'osc', address:data.address, args:JSON.stringify(data.args) });
    updateRecordedList();
  }
}

function onMidiIn(data) {
  const desc = midiStatusName(data.status);
  const addr = `${desc} ch${(data.status&0xF)+1}`;
  const args = `${data.data1},${data.data2}`;
  addMonitorRow('midi', framesToTC(Math.floor(state.playback.frames)), addr, args);
  if (state.recording) {
    state.recordedEvents.push({ tc: framesToTC(Math.floor(state.playback.frames)), tcFrames: Math.floor(state.playback.frames), type:'midi', address:addr, args, raw:[data.status,data.data1,data.data2] });
    updateRecordedList();
  }
}

function midiStatusName(s) {
  const t=s&0xF0;
  return {0x80:'Note Off',0x90:'Note On',0xA0:'Aftertouch',0xB0:'CC',0xC0:'Prog',0xD0:'Chan Pressure',0xE0:'Pitch Bend'}[t]||`0x${s.toString(16)}`;
}

function addMonitorRow(type, tc, addr, args) {
  const list = document.getElementById('monitorList');
  if (!list) return;
  const row = mk('div','mon-row');
  row.innerHTML = `<span class="mon-ts">${new Date().toLocaleTimeString('en',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'})}</span><span class="mon-type mon-${type}">${type.toUpperCase()}</span><span class="mon-addr">${addr}</span><span class="mon-args">${args}</span><span class="mon-tc">${tc}</span>`;
  list.appendChild(row);
  list.scrollTop = list.scrollHeight;
  // Cap at 200 rows
  while (list.children.length > 200) list.removeChild(list.firstChild);
}

function clearMonitor() { document.getElementById('monitorList').innerHTML=''; }

function updateRecordedList() {
  const list = document.getElementById('recordedList');
  if (!list) return;
  list.innerHTML = '';
  state.recordedEvents.forEach((ev,i) => {
    const row = mk('div','rec-entry');
    row.innerHTML = `<span class="re-tc">${ev.tc}</span><span class="re-type mon-${ev.type}">${ev.type.toUpperCase()}</span><span class="re-addr">${ev.address}</span><span class="re-args">${ev.args}</span>`;
    list.appendChild(row);
  });
}

function clearRecorded() {
  if (!confirm('Clear all recorded events?')) return;
  state.recordedEvents = [];
  updateRecordedList();
}

// Convert recorded events → automation cues
function bakeRecordedCues() {
  if (!state.recordedEvents.length) { setStatus('No recorded events to bake.'); return; }
  const baked = state.recordedEvents.map(ev => {
    const type = ev.type==='osc' ? 'osc' : 'midi';
    const cue = createCue(type, {
      name: ev.address,
      tcIn: ev.tcFrames,
      triggerMode: 'timecode',
    });
    if (type==='osc') {
      cue.oscAddress = ev.address;
      cue.oscArgs = ev.args;
    } else {
      const raw = ev.raw || [144,60,127];
      cue.midiStatus = raw[0]; cue.midiData1=raw[1]; cue.midiData2=raw[2];
    }
    return cue;
  });
  // Sort by TC and append
  baked.sort((a,b)=>a.tcIn-b.tcIn);
  baked.forEach(c => state.show.cues.push(c));
  renumber();
  markDirty();
  renderCueList(); drawTimeline(); updateStatusBar();
  setStatus(`Baked ${baked.length} recorded events to cue list.`);
  showTab('automation');
}

// ─────────────────────────────────────────────
//  BOOTH: FADERS
// ─────────────────────────────────────────────
const CHANNEL_GROUPS = {
  'l-inputs1': Array.from({length:8},(_,i)=>`ch${i+1}`),
  'l-inputs2': Array.from({length:8},(_,i)=>`ch${i+9}`),
  'l-inputs3': Array.from({length:8},(_,i)=>`ch${i+17}`),
  'l-inputs4': Array.from({length:8},(_,i)=>`ch${i+25}`),
  'l-aux':  Array.from({length:8},(_,i)=>`aux${i+1}`),
  'l-main': ['main'],
};

function buildFaders() {
  Object.entries(CHANNEL_GROUPS).forEach(([layerId, channels]) => {
    const layer = document.getElementById(layerId);
    if (!layer) return;
    const cont = mk('div','fader-container');
    channels.forEach(ch => {
      const label = ch.startsWith('ch') ? 'Ch '+ch.slice(2) : ch.startsWith('aux') ? 'Aux '+ch.slice(3) : 'Main';
      const fader = mk('div','fader');
      fader.innerHTML = `
        <input class="ch-name" type="text" value="${label}" />
        <div class="volume-touch" data-channel="${ch}" style="height:140px;width:40px;background:var(--bg4);border-radius:6px;position:relative;touch-action:none;cursor:pointer;">
          <div class="volume-bar" style="position:absolute;bottom:0;width:100%;background:var(--accent);border-radius:0 0 6px 6px;height:75%;"></div>
        </div>
        <span class="db-span">0.0 dB</span>
        <button class="btn" style="padding:2px 5px;font-size:9px;width:100%;" data-ch="${ch}" data-action="mute" onclick="toggleMute(this)">Mute</button>
        <button class="btn" style="padding:2px 5px;font-size:9px;width:100%;" data-ch="${ch}" data-action="solo" onclick="toggleSolo(this)">Solo</button>
      `;
      // Touch/drag fader
      const vt = fader.querySelector('.volume-touch');
      const vb = fader.querySelector('.volume-bar');
      const db = fader.querySelector('.db-span');
      let dragging=false, startY=0, startH=0;
      function startDrag(y){dragging=true;startY=y;startH=parseFloat(vb.style.height)||75;}
      function onMove(y){if(!dragging)return;const dy=startY-y;const newH=Math.max(0,Math.min(100,startH+dy/140*100));vb.style.height=newH+'%';const dbVal=(newH/100*70)-60;db.textContent=newH===0?'−∞ dB':(dbVal>=0?'+':'')+dbVal.toFixed(1)+' dB';const norm=newH/100;sendFaderOsc(ch,norm);}
      vt.addEventListener('mousedown',e=>{startDrag(e.clientY);});
      document.addEventListener('mousemove',e=>{onMove(e.clientY);});
      document.addEventListener('mouseup',()=>{dragging=false;});
      vt.addEventListener('touchstart',e=>{startDrag(e.touches[0].clientY);},{passive:true});
      vt.addEventListener('touchmove',e=>{onMove(e.touches[0].clientY);},{passive:true});
      vt.addEventListener('touchend',()=>{dragging=false;});
      cont.appendChild(fader);
    });
    layer.appendChild(cont);
  });
}

function openLayer(id) {
  document.querySelectorAll('.layer-content').forEach(l=>l.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function toggleMute(btn) {
  btn.classList.toggle('muted');
  const ch=btn.dataset.ch, isMuted=btn.classList.contains('muted');
  btn.textContent=isMuted?'Unmute':'Mute';
  btn.style.background=isMuted?'var(--red)':'';
  sendOscFn(getMutePath(ch), [{type:'i',value:isMuted?0:1}]);
}
function toggleSolo(btn) {
  btn.classList.toggle('soloed');
  const isSoloed=btn.classList.contains('soloed');
  btn.style.background=isSoloed?'var(--yellow)':'';
  btn.style.color=isSoloed?'#000':'';
}
function sendFaderOsc(ch,norm) { sendOscFn(getFaderPath(ch),[{type:'f',value:norm}]); }
function getFaderPath(ch){const b=getChannelBase(ch);return b?b+'/mix/fader':'';}
function getMutePath(ch){const b=getChannelBase(ch);return b?b+'/mix/on':'';}
function getChannelBase(ch){
  const t=document.getElementById('mixerType')?.value||'Midas M32';
  if(ch.startsWith('ch'))return'/ch/'+ch.slice(2).padStart(2,'0');
  if(ch.startsWith('aux'))return t==='Behringer Wing'?'/aux/'+ch.slice(3).padStart(2,'0'):'/auxin/'+ch.slice(3).padStart(2,'0');
  if(ch==='main')return'/main/st';
  return '';
}
function sendOscFn(addr,args){const eAPI=window.api;if(eAPI&&state.osc.running)eAPI.oscSend(addr,args);}

// ─────────────────────────────────────────────
//  BOOTH: ETC ION
// ─────────────────────────────────────────────
function ionAppend(cmd){const el=document.getElementById('cmd-line');el.value=(el.value+' '+cmd).trim();}
function executeIonCmd(){
  const cmd=document.getElementById('cmd-line').value;
  if(!cmd)return;
  sendOscFn('/eos/cmd',[{type:'s',value:cmd}]);
  setStatus(`Ion CMD: ${cmd}`);
  document.getElementById('cmd-line').value='';
}

// ─────────────────────────────────────────────
//  BOOTH: ATEM
// ─────────────────────────────────────────────
let atemPreview=1, atemProgram=3;
function buildAtem(){
  ['atem-preview','atem-program'].forEach(id=>{
    const grid=document.getElementById(id);
    grid.innerHTML='';
    for(let i=1;i<=10;i++){
      const btn=mk('button','atem-btn');
      btn.textContent=i;
      const isPre=id==='atem-preview';
      if((isPre&&i===atemPreview)||(!isPre&&i===atemProgram))btn.classList.add(isPre?'prev':'prog');
      btn.onclick=()=>selectAtem(id,i,btn);
      grid.appendChild(btn);
    }
  });
}
function selectAtem(gridId,num,btn){
  const isPre=gridId==='atem-preview';
  if(isPre)atemPreview=num; else atemProgram=num;
  document.querySelectorAll(`#${gridId} .atem-btn`).forEach(b=>b.classList.remove('prev','prog'));
  btn.classList.add(isPre?'prev':'prog');
  sendOscFn(isPre?'/atem/preview':'/atem/program',[{type:'i',value:num}]);
}
function atemSwitch(){
  [atemPreview,atemProgram]=[atemProgram,atemPreview];
  buildAtem();
  sendOscFn('/atem/cut',[]);
  setStatus('ATEM cut executed.');
}

// ─────────────────────────────────────────────
//  PROGRAMMING (Booth shows/scenes/cues)
// ─────────────────────────────────────────────
function renderBoothProgramming() {
  // Shows
  const sb = document.getElementById('shows-tbody');
  sb.innerHTML='';
  state.boothShows.forEach((show,i)=>{
    const tr=mk('tr'); if(i===state.selShow)tr.classList.add('sel');
    tr.innerHTML=`<td>${show.name}</td>`;
    tr.onclick=()=>{state.selShow=i;state.selScene=-1;state.selSceneCue=-1;renderBoothProgramming();};
    sb.appendChild(tr);
  });
  // Scenes
  const scb=document.getElementById('scenes-tbody');
  scb.innerHTML='';
  if(state.selShow>=0){
    (state.boothShows[state.selShow].scenes||[]).forEach((sc,i)=>{
      const tr=mk('tr');if(i===state.selScene)tr.classList.add('sel');
      tr.innerHTML=`<td>${sc.name}</td><td>${sc.duration}s</td>`;
      tr.onclick=()=>{state.selScene=i;state.selSceneCue=-1;renderBoothProgramming();};
      scb.appendChild(tr);
    });
  }
  // Cues
  const ccb=document.getElementById('scene-cues-tbody');
  ccb.innerHTML='';
  if(state.selShow>=0&&state.selScene>=0){
    const cues=(state.boothShows[state.selShow].scenes[state.selScene].cues||[]);
    cues.forEach((c,i)=>{
      const tr=mk('tr');if(i===state.selSceneCue)tr.classList.add('sel');
      tr.innerHTML=`<td>${c.name}</td><td>${c.time}s</td><td>${c.osc}</td><td>${c.device}</td>`;
      tr.onclick=()=>{state.selSceneCue=i;renderBoothProgramming();};
      ccb.appendChild(tr);
    });
  }
}

function addShow(){
  const n=prompt('Show name:'); if(!n)return;
  state.boothShows.push({name:n,scenes:[]}); markDirty(); renderBoothProgramming();
}
function deleteShow(){
  if(state.selShow<0){alert('Select a show.');return;}
  if(!confirm('Delete show?'))return;
  state.boothShows.splice(state.selShow,1);state.selShow=-1;state.selScene=-1;state.selSceneCue=-1;
  markDirty();renderBoothProgramming();
}
function addScene(){
  if(state.selShow<0){alert('Select a show first.');return;}
  const n=prompt('Scene name:'),d=prompt('Duration (s):','60');
  if(!n||!d)return;
  state.boothShows[state.selShow].scenes.push({name:n,duration:parseFloat(d),cues:[]});
  markDirty();renderBoothProgramming();
}
function deleteScene(){
  if(state.selShow<0||state.selScene<0){alert('Select a scene.');return;}
  if(!confirm('Delete scene?'))return;
  state.boothShows[state.selShow].scenes.splice(state.selScene,1);state.selScene=-1;state.selSceneCue=-1;
  markDirty();renderBoothProgramming();
}
function addSceneCue(){
  if(state.selShow<0||state.selScene<0){alert('Select a scene first.');return;}
  const n=prompt('Cue name:'),t=prompt('Time (s):','0'),osc=prompt('OSC command:','/cue/fire'),dev=prompt('Device:','Lighting');
  if(!n||!t||!osc||!dev)return;
  state.boothShows[state.selShow].scenes[state.selScene].cues.push({name:n,time:parseFloat(t),osc,device:dev});
  markDirty();renderBoothProgramming();
}
function deleteSceneCue(){
  if(state.selShow<0||state.selScene<0||state.selSceneCue<0){alert('Select a cue.');return;}
  if(!confirm('Delete cue?'))return;
  state.boothShows[state.selShow].scenes[state.selScene].cues.splice(state.selSceneCue,1);state.selSceneCue=-1;
  markDirty();renderBoothProgramming();
}

// ─────────────────────────────────────────────
//  HTTP SERVER (mobile hosting)
// ─────────────────────────────────────────────
async function startHttpSrv() {
  const eAPI = window.api; if (!eAPI) return;
  const port = parseInt(document.getElementById('httpPort')?.value) || 3141;
  const r = await eAPI.httpStart(port);
  document.getElementById('httpStatus').textContent = r.ok ? `Running on port ${r.port}` : 'Failed to start';
}

async function stopHttpSrv() {
  const eAPI = window.api; if (!eAPI) return;
  await eAPI.httpStop();
  document.getElementById('httpStatus').textContent = 'Stopped.';
  document.getElementById('httpUrl').textContent = 'Server stopped.';
}

function onHttpStarted(data) {
  const urlEl = document.getElementById('httpUrl');
  const statusEl = document.getElementById('httpStatus');
  if (urlEl) urlEl.textContent = data.url;
  if (statusEl) statusEl.textContent = `Running — ${data.ip}:${data.port}`;
  setStatus(`📱 Mobile server: ${data.url}`);
}

// Broadcast timecode to mobile clients every ~10 frames
let _mobTcTick = 0;
function maybeBroadcastTc() {
  if (++_mobTcTick % 10 !== 0) return;
  const eAPI = window.api;
  if (eAPI) eAPI.httpBroadcast({ type:'tc-tick', tc: framesToTC(Math.floor(state.playback.frames)) });
}


async function toggleVideoWindow() {
  const eAPI=window.api; if(!eAPI)return;
  if(state.video.windowOpen){await eAPI.videoWindowClose();state.video.windowOpen=false;}
  else{await eAPI.videoWindowOpen();state.video.windowOpen=true;}
  updateVideoBtn();
}
function updateVideoBtn(){
  const b=document.getElementById('btnVideo');
  if(!b)return;
  b.style.color=state.video.windowOpen?'var(--accent)':'';
  b.style.borderColor=state.video.windowOpen?'var(--border-a)':'';
}
async function moveVideoToDisplay(){
  const eAPI=window.api; if(!eAPI)return;
  const idx=parseInt(document.getElementById('videoDispSel')?.value)||0;
  await eAPI.videoWindowMoveToDisplay(idx);
}

// ─────────────────────────────────────────────
//  CONTEXT MENU
// ─────────────────────────────────────────────
function showCueMenu(e, cueId) {
  document.querySelectorAll('.ctx-menu').forEach(m=>m.remove());
  selectCue(cueId);
  const cue=getCue(cueId);
  const menu=mk('div','ctx-menu');
  menu.style.cssText=`position:fixed;left:${e.clientX}px;top:${e.clientY}px;background:var(--bg3);border:1px solid var(--border);border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,0.6);z-index:999;min-width:160px;overflow:hidden;`;
  const items=[
    {l:'▶  Fire Cue',fn:()=>fireCue(cue)},
    {l:'✎  Rename…',fn:()=>{const n=prompt('Rename:',cue.name);if(n)updateCue(cue.id,{name:n});}},
    {sep:true},
    {l:'⧉  Duplicate',fn:()=>{const d=Object.assign({},cue,{id:`cue_${Date.now()}`,name:cue.name+' (copy)',status:'ready',tcIn:cue.tcIn+(cue.duration||state.show.fps)});const i=state.show.cues.findIndex(c=>c.id===cue.id);state.show.cues.splice(i+1,0,d);renumber();markDirty();renderCueList();drawTimeline();}},
    {sep:true},
    {l:'✕  Delete',fn:()=>deleteSelectedCue(),danger:true},
  ];
  items.forEach(item=>{
    if(item.sep){const s=mk('div');s.style.cssText='height:1px;background:var(--border);';menu.appendChild(s);return;}
    const el=mk('div');el.style.cssText='padding:8px 14px;font-family:var(--font-mono);font-size:11px;cursor:pointer;transition:background 0.1s;'+(item.danger?'color:var(--red)':'color:var(--text)');
    el.textContent=item.l;
    el.onmouseenter=()=>el.style.background='var(--bg4)';
    el.onmouseleave=()=>el.style.background='';
    el.onclick=()=>{item.fn();menu.remove();};
    menu.appendChild(el);
  });
  document.body.appendChild(menu);
  setTimeout(()=>document.addEventListener('click',()=>menu.remove(),{once:true}),0);
}

// ─────────────────────────────────────────────
//  STATUS BAR
// ─────────────────────────────────────────────
function setStatus(msg){document.getElementById('statusMsg').textContent=msg;}
function updateStatusBar(){
  const n=state.show.cues.length;
  document.getElementById('cueCountMsg').textContent=`${n} cue${n!==1?'s':''}`;
  document.getElementById('showName').textContent=state.show.name;
  const next=state.show.cues[state.nextCueIndex];
  document.getElementById('nextCueMsg').textContent=next?`Next: #${next.number} "${next.name}"`:'End of list';
}

function renderAll(){
  document.getElementById('fpsSelect').value=state.show.fps;
  updateClock();
  renderCueList();
  renderInspector();
  drawTimeline();
  updateStatusBar();
}

// ─────────────────────────────────────────────
//  CUE PICKER
// ─────────────────────────────────────────────
function toggleCuePicker(e) {
  e.stopPropagation();
  const picker=document.getElementById('cuePicker');
  picker.style.display=picker.style.display==='none'?'flex':'none';
}

// ─────────────────────────────────────────────
//  SETTINGS
// ─────────────────────────────────────────────
function saveDeviceSettings(){setStatus('Device settings saved.');}

async function loadDisplays(){
  const eAPI=window.api; if(!eAPI)return;
  const displays=await eAPI.getDisplays().catch(()=>[]);
  const sel=document.getElementById('videoDispSel'); if(!sel)return;
  sel.innerHTML='';
  displays.forEach(d=>{const o=mk('option');o.value=d.index;o.textContent=d.label;sel.appendChild(o);});
}

// ─────────────────────────────────────────────
//  KEYBOARD SHORTCUTS
// ─────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA'||e.target.tagName==='SELECT')return;
  switch(e.code){
    case 'Space':     e.preventDefault(); togglePlay(); break;
    case 'Escape':    fullStop(); break;
    case 'KeyG':      e.preventDefault(); goNextCue(); break;
    case 'Delete':
    case 'Backspace': deleteSelectedCue(); break;
    case 'ArrowUp': e.preventDefault(); {const i=state.show.cues.findIndex(c=>c.id===state.ui.selectedCueId);if(i>0)selectCue(state.show.cues[i-1].id);}break;
    case 'ArrowDown':e.preventDefault();{const i=state.show.cues.findIndex(c=>c.id===state.ui.selectedCueId);if(i<state.show.cues.length-1)selectCue(state.show.cues[i+1].id);}break;
  }
});

// ─────────────────────────────────────────────
//  INIT
// ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Wire cue type picker buttons
  document.querySelectorAll('.ct-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      addCue(btn.dataset.type);
      document.getElementById('cuePicker').style.display='none';
    });
  });
  document.getElementById('cuePicker').addEventListener('click', e => e.stopPropagation());
  document.addEventListener('click', () => { document.getElementById('cuePicker').style.display='none'; });

  // Timeline click to seek
  document.getElementById('timeline-canvas').addEventListener('click', e => {
    const rect=e.currentTarget.getBoundingClientRect();
    const fps=state.show.fps, viewDur=fps*120;
    const viewStart=Math.max(0,state.playback.frames-viewDur*0.15);
    state.playback.frames=Math.max(0,viewStart+(e.clientX-rect.left)/rect.width*viewDur);
    updateClock();drawTimeline();
  });

  window.addEventListener('resize', drawTimeline);

  // IPC wiring
  const eAPI = window.api;
  if (eAPI) {
    eAPI.onOscIn(onOscIn);
    eAPI.onMidiIn(onMidiIn);
    eAPI.onOscError(e => setStatus('OSC error: '+e));
    eAPI.onVideoWindowClosed(() => { state.video.windowOpen=false; updateVideoBtn(); });
    eAPI.onHttpStarted(onHttpStarted);
    eAPI.onHttpError(e => setStatus('HTTP error: '+e));
    eAPI.onMenuSave(saveShow);
    eAPI.onMenuSaveAs(saveShow);
    eAPI.onMenuPlayPause(togglePlay);
    eAPI.onMenuStop(fullStop);
    eAPI.onMenuGo(goNextCue);
    eAPI.onMenuRecordStart(()=>{ if(!state.recording)toggleRecord(); });
    eAPI.onMenuRecordStop(()=>{ if(state.recording)toggleRecord(); });
  }

  // Build booth UI
  buildFaders();
  buildAtem();

  // Load displays for settings
  loadDisplays();

  // Set default tab active
  showTab('booth');
  showSubTab('booth','booth-lighting');
  showSubTab('osc-midi','osc-config-tab');
  setStatus('Welcome to Booth Copilot — OSC/MIDI ready · Press Space to play · G for GO');
});
