'use strict';

// ─── STATE ────────────────────────────────────────────────────────────────────
const state = {
  fixtures: [], selected: new Set(), cues: [], presets: [], faders: [],
  links: [], patchData: [], currentCue: -1, vars: {}, presetFilter: 'ALL',
  showName: 'Untitled Show', gridCols: 8, timelines: {}, effects: {}, groups: {},
  cmdHistory: [], histIdx: -1, fadeTimers: {}, bitmaps: {},
  panelLayout: ['fixtures','cuelist','presets','faders'],
  viz3d: { canvas:null, ctx:null, camAngle:0.3, camElev:-0.5, camDist:700 },
  stageObjects: [], // [{id,type:'box'|'truss',x,y,z,w,h,d,label,color}]
  customProfiles: [], // [{id,manufacturer,name,type,modes:[{name,count,channels:[{name,param,offset}]}]}]
  _editingCue: null, _faderDragCleanups: [],
};

const programmer = {}; // live programmer buffer: fixtureId -> {param:val}
const tlPlayers  = {}; // timeline runtime: name -> {running,startWall,offsetMs,_raf,_fired:Set}
const remoteState = {running:false,port:8080,urls:[],clients:0};
let _remoteBroadcastPending = false;
let tlRecordState = { active:false, name:'', startMs:null, steps:[], _keyHandler:null };

// ── License state ─────────────────────────────────────────────────────────────
const licenseState = {
  plan: 'free', channels: 25, label: 'Free', activated: false,
  expires: null, email: '', id: ''
};

const PARAMS = ['dimmer','red','green','blue','white','amber','uv',
                'pan','tilt','panFine','tiltFine','gobo','color',
                'shutter','strobe','zoom','focus','iris','prism','frost','speed'];

const PANEL_TYPES = {
  fixtures:{ label:'Grouping Grid' }, groups:{ label:'Groups' }, cuelist:{ label:'Cuelist' },
  presets:{ label:'Presets' }, faders:{ label:'Faders' }, viz3d:{ label:'3D Visualizer' },
  timeline:{ label:'Timeline' }, ai:{ label:'AI Agent' }, ml:{ label:'ML Controls' },
};

const CHANNEL_NAME_MAP = {
  'dimmer':'dimmer','intensity':'dimmer','master dimmer':'dimmer','dim':'dimmer','brightness':'dimmer',
  'red':'red','r':'red','coloradd_r':'red','color_r':'red',
  'green':'green','g':'green','coloradd_g':'green','color_g':'green',
  'blue':'blue','b':'blue','coloradd_b':'blue','color_b':'blue',
  'white':'white','w':'white','coloradd_w':'white','warm white':'white',
  'amber':'amber','a':'amber','coloradd_a':'amber',
  'uv':'uv','ultraviolet':'uv','coloradd_uv':'uv',
  'pan':'pan','pan coarse':'pan','x axis':'pan',
  'tilt':'tilt','tilt coarse':'tilt','y axis':'tilt',
  'pan fine':'panFine','tilt fine':'tiltFine',
  'zoom':'zoom','focus':'focus','iris':'iris','speed':'speed',
};

function escHTML(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function mkBtn(label, fn, active=false) {
  const b=document.createElement('button');
  b.className='panel-btn'+(active?' on':''); b.textContent=label; b.onclick=fn; return b;
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
function init() {
  renderAll(); setupInput(); setupElectronMenuBridge(); setup3D(); setupMultilineEditor();
  cceSetupTA(); pceSetupTA();
  // Load license (shows activation screen on first launch)
  licenseInit().catch(()=>{});
  // Check Ollama silently on startup
  setTimeout(()=>aiCheckOllama(true),1000);
  // Init AI backend (check for saved Anthropic key)
  setTimeout(()=>aiInit(),500);
  // Init MIDI
  setTimeout(()=>midiInit(),800);
  setInterval(updateClock, 1000); updateClock();
  logHistory('·','LightScript v2.0  —  File → New Show  or  Open Show','info');
  logHistory('·','HELP for commands  |  PATCH FIX 1 addr 1  |  SET FIX 1 dimmer 255','info');
  document.getElementById('cmd-input').focus();
  setTimeout(gdtfInit, 300);
}

function newBlankShow() {
  state.cues=[]; state.presets=[]; state.faders=Array.from({length:8},(_,i)=>({name:'FADER '+(i+1),val:0,fixtures:[],param:'dimmer'}));
  state.fixtures=[]; state.patchData=[]; state.links=[]; state.vars={};
  state.timelines={}; state.effects={}; state.groups={}; state.bitmaps={};
  state.selected.clear(); state.currentCue=-1; state._editingCue=null;
  state.showName='Untitled Show';
  Object.keys(state.fadeTimers).forEach(k=>{clearInterval(state.fadeTimers[k]);delete state.fadeTimers[k];});
  Object.keys(programmer).forEach(k=>delete programmer[k]);
}

// ─── RENDER ───────────────────────────────────────────────────────────────────
function renderAll()  { renderPanels(); renderPatch(); renderLinks(); updateProgBar(); remoteBroadcast(); }

function renderPanels() { state.panelLayout.forEach((t,i)=>renderPanel(i,t)); }

function renderPanel(idx, type) {
  const slot=document.getElementById('panel-slot-'+idx); if(!slot) return;
  cleanupFaderDrag(); slot.innerHTML='';
  const hdr=document.createElement('div'); hdr.className='panel-header';
  const ts=document.createElement('div'); ts.style.cssText='display:flex;align-items:center;gap:8px;flex:1;min-width:0';
  const sel=document.createElement('select'); sel.className='panel-picker';
  Object.entries(PANEL_TYPES).forEach(([id,def])=>{
    const o=document.createElement('option'); o.value=id; o.textContent=def.label;
    if(id===type) o.selected=true; sel.appendChild(o);
  });
  sel.onchange=()=>{ state.panelLayout[idx]=sel.value; renderPanel(idx,sel.value); };
  const ctrl=document.createElement('div'); ctrl.className='panel-controls';
  ts.appendChild(sel); hdr.appendChild(ts); hdr.appendChild(ctrl); slot.appendChild(hdr);
  const body=document.createElement('div');
  body.style.cssText='flex:1;overflow:hidden;display:flex;flex-direction:column;min-height:0';
  switch(type){
    case 'fixtures': buildFixturesPanel(body,ctrl,idx); break;
    case 'groups':   buildGroupsPanel(body,ctrl,idx); break;
    case 'cuelist':  buildCuelistPanel(body,ctrl,idx);  break;
    case 'presets':  buildPresetsPanel(body,ctrl,idx);  break;
    case 'faders':   buildFadersPanel(body,ctrl,idx);   break;
    case 'viz3d':    buildViz3dPanel(body,ctrl,idx);    break;
    case 'timeline': body.dataset.panelType='timeline-content'; buildTimelinePanelEmbed(body,ctrl); break;
    case 'ai':       buildAIPanel(body,ctrl); break;
    case 'ml':       buildMLPanel(body,ctrl); break;
  }
  slot.appendChild(body);
}

// ── Grouping Grid ─────────────────────────────────────────────────────────────
function buildFixturesPanel(body, ctrl, idx) {
  [['ALL',selectAll],['NONE',clearSel],['GROUP',selectGroup]].forEach(([l,f])=>ctrl.appendChild(mkBtn(l,f)));
  const toolbar=document.createElement('div'); toolbar.className='grid-toolbar';
  [['COPY',gridCopy],['PASTE',gridPaste],['FLIP',gridFlip],
   ['FULL',()=>setSelectedParam('dimmer',255)],['OUT',()=>setSelectedParam('dimmer',0)],
   ['@50',()=>setSelectedParam('dimmer',128)]
  ].forEach(([l,f])=>{
    const b=document.createElement('button'); b.className='grid-toolbar-btn';
    b.textContent=l; b.onclick=f; toolbar.appendChild(b);
  });
  body.appendChild(toolbar);
  const grid=document.createElement('div');
  grid.dataset.panelType='fixture-grid'; grid.dataset.panelIdx=idx;
  grid.style.cssText='flex:1;overflow-y:auto;padding:6px';
  body.appendChild(grid); fillFixtureGrid(grid);
}

function buildGroupsPanel(body, ctrl, idx) {
  ctrl.appendChild(mkBtn('+ Group', ()=>{
    const name=prompt('Group name:'); if(!name) return;
    if(!state.selected.size){logHistory('!','Select fixtures first','err');return;}
    state.groups[name]=[...state.selected];
    logHistory('·',`GROUP "${name}" stored — ${state.groups[name].length} fixtures`,'ok');
    renderGroupsPanels();
  }));
  const wrap=document.createElement('div');
  wrap.dataset.panelType='groups-content';
  wrap.style.cssText='flex:1;overflow-y:auto;padding:6px;display:flex;flex-wrap:wrap;gap:6px;align-content:flex-start';
  body.appendChild(wrap);
  fillGroupsPanel(wrap);
}

function fillGroupsPanel(el) {
  el.innerHTML='';
  const groups=Object.entries(state.groups);
  if(!groups.length){
    el.innerHTML='<div style="padding:20px;color:var(--text2);font-family:var(--mono);font-size:11px;width:100%;text-align:center">No groups stored.<br>Select fixtures then: STORE GROUP Name</div>';
    return;
  }
  groups.forEach(([name,ids])=>{
    const card=document.createElement('div');
    card.style.cssText='background:var(--bg3);border:1px solid var(--border2);border-radius:4px;padding:10px 12px;cursor:pointer;min-width:90px;text-align:center;user-select:none;transition:border-color .1s';
    const isActive=ids.every(id=>state.selected.has(id))&&ids.length>0;
    if(isActive) card.style.borderColor='var(--accent2)';
    card.innerHTML=`<div style="font-family:var(--ui);font-weight:700;font-size:11px;color:${isActive?'var(--accent2)':'var(--text0)'}">${escHTML(name)}</div>
      <div style="font-family:var(--mono);font-size:9px;color:var(--text2);margin-top:3px">${ids.length} fix</div>`;
    card.onclick=(e)=>{
      if(e.shiftKey){
        // Add to selection
        ids.forEach(id=>state.selected.add(id));
      } else if(e.ctrlKey||e.metaKey){
        // Remove from selection
        ids.forEach(id=>state.selected.delete(id));
      } else {
        // Replace selection
        state.selected=new Set(ids);
      }
      renderFixtures(); updateProgBar(); fillGroupsPanel(el);
    };
    card.oncontextmenu=(e)=>{
      e.preventDefault();
      if(confirm(`Delete group "${name}"?`)){delete state.groups[name];renderGroupsPanels();}
    };
    el.appendChild(card);
  });
}

function renderGroupsPanels(){
  document.querySelectorAll('[data-panel-type="groups-content"]').forEach(el=>fillGroupsPanel(el));
}

function setSelectedParam(param, val) {
  const ids=[...state.selected];
  if(!ids.length){logHistory('!','Select fixtures first','err');return;}
  ids.forEach(id=>{
    const f=state.fixtures.find(x=>x.id===id); if(!f) return;
    f[param]=val; programmer[id]=programmer[id]||{}; programmer[id][param]=val;
  });
  renderFixtures(); drawIfVisible();
}

let _dragSrcIdx=null;
function fillFixtureGrid(el) {
  el.style.display='grid'; el.style.gridTemplateColumns=`repeat(${state.gridCols},1fr)`; el.style.gap='3px'; el.innerHTML='';
  state.fixtures.forEach(f=>{
    const d=Math.round(f.dimmer/255*100);
    const div=document.createElement('div');
    div.className='fix-cell'+(state.selected.has(f.id)?' selected':'')+(f.dimmer>0?' active':'');
    div.style.setProperty('--fix-color',f.dimmer>0?`rgb(${f.red},${f.green},${f.blue})`:'transparent');
    div.setAttribute('draggable','true');
    // Show fixture name, type, address, dimmer
    const pdata=state.patchData.find(p=>p.id===f.id);
    div.innerHTML=`<span class="fix-num">${f.id}</span><span class="fix-name">${escHTML(pdata?.name||f.type)}</span><span class="fix-dimmer">${d}%</span><span style="font-size:8px;color:var(--text2);font-family:var(--mono)">${f.address||'?'}</span>`;
    div.onclick=()=>toggleFixture(f.id);
    div.ondblclick=()=>openFix3DEdit(f.id);
    el.appendChild(div);
  });
  setupGridDragDrop(el);
}

function setupGridDragDrop(grid) {
  grid.ondragstart=e=>{const c=e.target.closest('.fix-cell');if(!c)return;_dragSrcIdx=[...grid.querySelectorAll('.fix-cell')].indexOf(c);c.classList.add('dragging');e.dataTransfer.effectAllowed='move';};
  grid.ondragend=()=>{grid.querySelectorAll('.fix-cell.dragging,.fix-cell.drag-over').forEach(c=>{c.classList.remove('dragging','drag-over');});};
  grid.ondragover=e=>{e.preventDefault();const c=e.target.closest('.fix-cell');grid.querySelectorAll('.fix-cell.drag-over').forEach(x=>x.classList.remove('drag-over'));if(c)c.classList.add('drag-over');};
  grid.ondrop=e=>{e.preventDefault();const c=e.target.closest('.fix-cell');if(!c||_dragSrcIdx===null)return;const d=[...grid.querySelectorAll('.fix-cell')].indexOf(c);if(d!==-1&&d!==_dragSrcIdx){const m=state.fixtures.splice(_dragSrcIdx,1)[0];state.fixtures.splice(d,0,m);renderFixtures();}  _dragSrcIdx=null;};
}

function renderFixtures() { document.querySelectorAll('[data-panel-type="fixture-grid"]').forEach(el=>fillFixtureGrid(el)); mlRefreshPanel(); remoteBroadcast(); }

// Grid clipboard
const gridClipboard={params:null};
function gridCopy() {
  const ids=[...state.selected]; if(!ids.length){logHistory('!','Select fixtures to copy','err');return;}
  gridClipboard.params=ids.map(id=>{const f=state.fixtures.find(x=>x.id===id);if(!f)return null;const s={};PARAMS.forEach(p=>{if(p in f)s[p]=f[p];});return s;}).filter(Boolean);
  logHistory('·',`Copied ${gridClipboard.params.length} fixture(s)  (includes all params)  — select targets then PASTE`,'ok');
}
function gridPaste() {
  if(!gridClipboard.params?.length){logHistory('!','Nothing in clipboard','err');return;}
  const ids=[...state.selected]; if(!ids.length){logHistory('!','Select destination fixtures','err');return;}
  ids.forEach((id,i)=>{const f=state.fixtures.find(x=>x.id===id);if(!f)return;Object.assign(f,gridClipboard.params[i%gridClipboard.params.length]);});
  renderFixtures(); drawIfVisible(); logHistory('·',`Pasted to ${ids.length} fixture(s)`,'ok');
}
function gridFlip() {
  const ids=[...state.selected]; if(ids.length<2){logHistory('!','Select 2+ fixtures to flip','err');return;}
  const idxs=ids.map(id=>state.fixtures.findIndex(f=>f.id===id)).filter(i=>i!==-1);
  idxs.sort((a,b)=>a-b);
  const items=idxs.map(i=>state.fixtures[i]); items.reverse();
  idxs.forEach((orig,pos)=>state.fixtures[orig]=items[pos]);
  renderFixtures(); logHistory('·',`Flipped ${ids.length} fixtures`,'ok');
}

// ── Cuelist ───────────────────────────────────────────────────────────────────
function buildCuelistPanel(body, ctrl, idx) {
  [['GO ▶','on',goCue],['◀ BACK','',backCue],['■ STOP','',stopCue]].forEach(([l,c,f])=>ctrl.appendChild(mkBtn(l,f,c==='on')));
  const colH=document.createElement('div'); colH.className='cue-col-header';
  colH.innerHTML='<span></span><span>NUM</span><span>NAME</span><span style="text-align:right">FADE</span><span style="text-align:right">DELAY</span><span style="text-align:right">ST</span><span style="text-align:right">MIB</span>';
  body.appendChild(colH);
  const list=document.createElement('div'); list.dataset.panelType='cuelist-content'; list.dataset.panelIdx=idx;
  list.style.cssText='flex:1;overflow-y:auto'; body.appendChild(list); fillCuelist(list);
}

function fillCuelist(el) {
  el.innerHTML='';
  state.cues.forEach((c,i)=>{
    const active=i===state.currentCue, editing=state._editingCue===i;
    const row=document.createElement('div');
    row.className='cue-row'+(active?' active':'')+(editing?' editing':'');
    if(editing){
      row.innerHTML=`<button class="cue-go-btn" onclick="jumpCue(${i})">▶</button>
        <span class="cue-num" style="color:var(--text2)">${c.num}</span>
        <input class="cue-edit-input" id="cedit-name-${i}" value="${escHTML(c.name)}" placeholder="Name">
        <input class="cue-edit-input" id="cedit-fade-${i}" value="${c.fade}" type="number" min="0" style="width:52px;text-align:right">
        <input class="cue-edit-input" id="cedit-delay-${i}" value="${c.delay}" type="number" min="0" style="width:52px;text-align:right">
        <span></span><button class="panel-btn on" style="font-size:9px;padding:1px 5px" onclick="saveCueEdit(${i})">SAVE</button>`;
      setTimeout(()=>{
        const ni=document.getElementById('cedit-name-'+i); if(ni){ni.focus();ni.select();}
        ['cedit-name-','cedit-fade-','cedit-delay-'].forEach(pre=>{
          const inp=document.getElementById(pre+i);
          if(inp) inp.addEventListener('keydown',e=>{if(e.key==='Enter')saveCueEdit(i);if(e.key==='Escape')cancelCueEdit();});
        });
      },0);
    } else {
      const snapCount=c.snapshot?Object.keys(c.snapshot).length:0;
      row.innerHTML=`<button class="cue-go-btn" onclick="jumpCue(${i})">▶</button>
        <span class="cue-num">${c.num}</span>
        <span class="cue-name" ondblclick="openCueCodeEditor(${i})" title="${snapCount} fixtures tracked">${escHTML(c.name)}${snapCount?`<span style="color:var(--text2);font-size:9px;margin-left:4px">(${snapCount}f)</span>`:''}</span>
        <span class="cue-fade" ondblclick="openCueCodeEditor(${i})">${c.fade>0?(c.fade/1000).toFixed(1)+'s':'—'}</span>
        <span class="cue-delay" ondblclick="openCueCodeEditor(${i})">${c.delay>0?(c.delay/1000).toFixed(1)+'s':'—'}</span>
        <span class="cue-status"><span class="cue-badge ${active?'go':'ready'}">${active?'GO':'RDY'}</span></span>
        <span class="cue-mib" onclick="toggleMIB(${i})" title="Move In Black" style="cursor:pointer;text-align:center;opacity:${c.mib?1:0.25}">${c.mib?'MIB':'○'}</span>`;
    }
    el.appendChild(row);
  });
  const ar=el.querySelector('.active'); if(ar) ar.scrollIntoView({block:'nearest'});
  updateProgBar();
}

function renderCues() { document.querySelectorAll('[data-panel-type="cuelist-content"]').forEach(el=>fillCuelist(el)); }
function startCueEdit(i) { state._editingCue=i; renderCues(); }
function cancelCueEdit() { state._editingCue=null; renderCues(); }
function saveCueEdit(i) {
  const n=document.getElementById('cedit-name-'+i),f=document.getElementById('cedit-fade-'+i),d=document.getElementById('cedit-delay-'+i);
  if(!n) return;
  if(n.value.trim()) state.cues[i].name=n.value.trim();
  state.cues[i].fade=Math.max(0,parseInt(f?.value)||0); state.cues[i].delay=Math.max(0,parseInt(d?.value)||0);
  state._editingCue=null; logHistory('·',`CUE ${state.cues[i].num} updated`,'ok'); renderCues();
}
function toggleMIB(i) { state.cues[i].mib=!state.cues[i].mib; logHistory('·',`CUE ${state.cues[i].num} MIB ${state.cues[i].mib?'ON':'OFF'}`,'info'); renderCues(); }

// ── Presets ───────────────────────────────────────────────────────────────────
function buildPresetsPanel(body, ctrl, idx) {
  ['INT','COL','POS','ALL'].forEach(t=>ctrl.appendChild(mkBtn(t,()=>filterPreset(t))));
  const grid=document.createElement('div'); grid.dataset.panelType='presets-content'; grid.dataset.panelIdx=idx;
  grid.style.cssText='display:grid;grid-template-columns:repeat(4,1fr);gap:3px;padding:6px;overflow-y:auto;flex:1;align-content:start';
  body.appendChild(grid); fillPresets(grid);
}
function fillPresets(el) {
  el.innerHTML='';
  const list=state.presetFilter==='ALL'?state.presets:state.presets.filter(p=>p.type===state.presetFilter);
  list.forEach(p=>{
    const btn=document.createElement('div'); btn.className='preset-btn stored';
    btn.innerHTML=`<div class="preset-type">${p.type}</div><div class="preset-name">${escHTML(p.name)}</div><div class="preset-num">${p.num}</div>`;
    btn.onclick=()=>recallPreset(p);
    btn.ondblclick=(e)=>{e.stopPropagation();openPresetCodeEditor(state.presets.indexOf(p));};
    el.appendChild(btn);
  });
  const add=document.createElement('div'); add.className='preset-btn';
  add.innerHTML='<div class="preset-type" style="color:var(--text2)">NEW</div><div class="preset-name" style="color:var(--text2)">+</div>';
  add.onclick=()=>document.getElementById('cmd-input').focus(); el.appendChild(add);
}
function renderPresets() { document.querySelectorAll('[data-panel-type="presets-content"]').forEach(el=>fillPresets(el)); }
function filterPreset(t) { state.presetFilter=t; renderPresets(); }

// ── Faders — storable ─────────────────────────────────────────────────────────
function buildFadersPanel(body, ctrl, idx) {
  ctrl.appendChild(mkBtn('RELEASE ALL',releaseAll));
  ctrl.appendChild(mkBtn('+ FADER',addFader));
  const wrap=document.createElement('div'); wrap.dataset.panelType='faders-content'; wrap.dataset.panelIdx=idx;
  wrap.style.cssText='display:flex;gap:2px;padding:8px 6px;overflow-x:auto;flex:1;align-items:flex-end';
  body.appendChild(wrap); fillFaders(wrap);
}

function addFader() {
  state.faders.push({name:'FADER '+(state.faders.length+1),val:0,fixtures:[],param:'dimmer'});
  renderFaders();
}

function cleanupFaderDrag() { state._faderDragCleanups.forEach(fn=>fn()); state._faderDragCleanups=[]; }

function fillFaders(el) {
  el.innerHTML='';
  state.faders.forEach((f,i)=>{
    const strip=document.createElement('div'); strip.className='fader-strip';
    // Show what's assigned to this fader
    const assignInfo=f.fixtures?.length?`${f.fixtures.length}f/${f.param||'dim'}`:f.name;
    strip.innerHTML=`<div class="fader-val" id="fv${i}">${f.val}</div>
      <div class="fader-track" id="ft${i}">
        <div class="fader-fill" id="ff${i}" style="height:${f.val}%"></div>
        <div class="fader-thumb" id="fth${i}" style="bottom:calc(${f.val}% - 3px)"></div>
      </div>
      <div class="fader-name" ondblclick="renameFader(${i})" title="Double-click to rename">${escHTML(f.name)}</div>
      <button class="fader-go ${f.val>0?'active':''}" onclick="toggleFader(${i})">${f.val>0?'ON':'GO'}</button>`;
    el.appendChild(strip);
  });
  attachFaderDrag();
}

function attachFaderDrag() {
  cleanupFaderDrag();
  state.faders.forEach((_,i)=>{
    const track=document.getElementById('ft'+i); if(!track) return;
    let dragging=false;
    const getVal=e=>{
      const rect=track.getBoundingClientRect();
      const clientY=e.touches?e.touches[0].clientY:e.clientY;
      return Math.max(0,Math.min(100,Math.round((1-(clientY-rect.top)/rect.height)*100)));
    };
    const onDown=e=>{
      dragging=true;
      if(e.pointerId!=null) track.setPointerCapture(e.pointerId);
      state.faders[i].val=getVal(e);
      updateFaderUI(i); applyFaderOutput(i);
      e.preventDefault();
    };
    const onMove=e=>{
      if(!dragging) return;
      state.faders[i].val=getVal(e);
      updateFaderUI(i); applyFaderOutput(i);
      e.preventDefault();
    };
    const onUp=()=>{ dragging=false; };
    track.addEventListener('pointerdown',onDown,{passive:false});
    track.addEventListener('pointermove',onMove,{passive:false});
    track.addEventListener('pointerup',onUp);
    track.addEventListener('pointercancel',onUp);
    // Touch fallback
    track.addEventListener('touchstart',onDown,{passive:false});
    track.addEventListener('touchmove',onMove,{passive:false});
    track.addEventListener('touchend',onUp);
    state._faderDragCleanups.push(()=>{
      track.removeEventListener('pointerdown',onDown);
      track.removeEventListener('pointermove',onMove);
      track.removeEventListener('pointerup',onUp);
      track.removeEventListener('pointercancel',onUp);
      track.removeEventListener('touchstart',onDown);
      track.removeEventListener('touchmove',onMove);
      track.removeEventListener('touchend',onUp);
    });
  });
}

function applyFaderOutput(i) {
  const fader=state.faders[i]; if(!fader) return;
  const ids=fader.fixtures?.length?fader.fixtures:[...state.selected];
  if(!ids.length) return;
  const param=fader.param||'dimmer';
  const val=Math.round(fader.val/100*255);
  ids.forEach(id=>{const f=state.fixtures.find(x=>x.id===id);if(f&&param in f)f[param]=val;});
  renderFixtures(); drawIfVisible(); remoteBroadcast();
}

function updateFaderUI(i) {
  const v=state.faders[i].val;
  const fv=document.getElementById('fv'+i),ff=document.getElementById('ff'+i),fth=document.getElementById('fth'+i);
  if(fv) fv.textContent=v; if(ff) ff.style.height=v+'%'; if(fth) fth.style.bottom=`calc(${v}% - 3px)`;
}

function renderFaders() { document.querySelectorAll('[data-panel-type="faders-content"]').forEach(el=>fillFaders(el)); }

function renameFader(i) {
  const name=prompt('Fader name:',state.faders[i].name); if(!name) return;
  state.faders[i].name=name; renderFaders();
}

// ── 3D Viz ────────────────────────────────────────────────────────────────────
function buildViz3dPanel(body, ctrl, idx) {
  [['↺',reset3DCamera],['↑',top3DCamera],['→',front3DCamera]].forEach(([l,f])=>ctrl.appendChild(mkBtn(l,f)));
  const objBtn=document.createElement('button');
  objBtn.textContent='+ Object';
  objBtn.title='Add box or truss to stage layout';
  objBtn.style.cssText='background:var(--bg3);border:1px solid var(--border2);color:var(--accent);font-family:var(--ui);font-weight:700;font-size:9px;letter-spacing:1px;padding:2px 8px;cursor:pointer;border-radius:2px;text-transform:uppercase;margin-left:4px';
  objBtn.onclick=()=>openStageObjectModal();
  ctrl.appendChild(objBtn);
  const canvas=document.createElement('canvas'); canvas.className='panel-canvas3d'; canvas.dataset.panelIdx=idx;
  body.appendChild(canvas); requestAnimationFrame(()=>setupPanelCanvas(canvas));
}

function buildTimelinePanelEmbed(body, ctrl) {
  ctrl.appendChild(mkBtn('+NEW', tcNewTimeline));
  ctrl.appendChild(mkBtn('⏺ REC', ()=>{const n=prompt('Record as:','REC_'+Date.now());if(n)parseCommand('TIMELINE RECORD '+n);}));
  body.style.overflow='hidden';
  const layout=document.createElement('div');
  layout.style.cssText='display:flex;flex:1;overflow:hidden;height:100%';
  const leftPane=document.createElement('div');
  leftPane.style.cssText='width:160px;flex-shrink:0;border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden';
  leftPane.innerHTML='<div style="padding:5px 8px;font-family:var(--ui);font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--text2);border-bottom:1px solid var(--border);flex-shrink:0">Timelines</div>';
  const tlList=document.createElement('div');
  tlList.id='tl-embed-list';
  tlList.style.cssText='flex:1;overflow-y:auto;padding:4px';
  leftPane.appendChild(tlList);
  const rightPane=document.createElement('div');
  rightPane.style.cssText='flex:1;display:flex;flex-direction:column;overflow:hidden';
  rightPane.innerHTML='<div id="tl-embed-transport" style="padding:5px 8px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:4px;flex-shrink:0"><span id="tl-embed-name" style="font-family:var(--mono);font-size:10px;color:var(--text2);flex:1">Select a timeline</span></div>';
  const cueRows=document.createElement('div');
  cueRows.id='tl-embed-cues';
  cueRows.style.cssText='flex:1;overflow-y:auto;font-family:var(--mono);font-size:10px';
  rightPane.appendChild(cueRows);
  layout.appendChild(leftPane);
  layout.appendChild(rightPane);
  body.appendChild(layout);
  _tlEmbedRefresh();
}

let _tlEmbedSelected = null;

function _tlEmbedRefresh(){
  const tlList=document.getElementById('tl-embed-list'); if(!tlList) return;
  tlList.innerHTML='';
  Object.entries(state.timelines).forEach(([name,tl])=>{
    const p=tlGetPlayer(name);
    const isActive=_tlEmbedSelected===name;
    const dur=tl.steps?.length?Math.max(...tl.steps.map(s=>s.timeMs||0)):0;
    const pct=dur>0?Math.min(tlElapsed(name)/dur*100,100):0;
    const row=document.createElement('div');
    row.style.cssText=`padding:5px 6px;border-radius:3px;cursor:pointer;margin-bottom:2px;border:1px solid ${isActive?'var(--accent3)':'transparent'};background:${isActive?'rgba(80,200,120,0.07)':'transparent'}`;
    row.innerHTML=`<div style="display:flex;align-items:center;gap:4px">
      <div style="width:6px;height:6px;border-radius:50%;flex-shrink:0;background:${p.running?'var(--accent3)':'var(--border2)'}"></div>
      <span style="font-family:var(--ui);font-weight:700;font-size:10px;color:${p.running?'var(--accent3)':'var(--text0)'};flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${name}</span>
      <span style="font-family:var(--mono);font-size:8px;color:var(--text2)">${tl.steps?.length||0}</span>
    </div>
    <div style="height:2px;background:var(--bg4);border-radius:1px;margin-top:4px;overflow:hidden"><div style="height:100%;width:${pct}%;background:${p.running?'var(--accent3)':'var(--border2)'}"></div></div>
    <div style="display:flex;gap:2px;margin-top:4px">
      <button onclick="event.stopPropagation();tlPlay('${name}');_tlEmbedRefresh()" style="background:${p.running?'var(--bg3)':'var(--accent3)'};border:none;color:${p.running?'var(--text2)':'#000'};font-family:var(--ui);font-weight:700;font-size:8px;padding:2px 6px;cursor:pointer;border-radius:2px">▶</button>
      <button onclick="event.stopPropagation();tlPause('${name}');_tlEmbedRefresh()" style="background:var(--bg3);border:1px solid var(--border2);color:var(--text2);font-family:var(--ui);font-size:8px;padding:2px 5px;cursor:pointer;border-radius:2px">⏸</button>
      <button onclick="event.stopPropagation();tlStop('${name}');_tlEmbedRefresh()" style="background:var(--bg3);border:1px solid var(--border2);color:var(--text2);font-family:var(--ui);font-size:8px;padding:2px 5px;cursor:pointer;border-radius:2px">■</button>
      <button onclick="event.stopPropagation();tlReset('${name}');_tlEmbedRefresh()" style="background:var(--bg3);border:1px solid var(--border2);color:var(--text2);font-family:var(--ui);font-size:8px;padding:2px 4px;cursor:pointer;border-radius:2px">⏮</button>
    </div>`;
    row.onclick=()=>{_tlEmbedSelected=name;_tlEmbedRefresh();_tlEmbedRenderCues(name);};
    tlList.appendChild(row);
  });
  if(!Object.keys(state.timelines).length){
    tlList.innerHTML='<div style="color:var(--text2);font-family:var(--ui);font-size:10px;padding:12px 6px;text-align:center">No timelines</div>';
  }
  if(_tlEmbedSelected) _tlEmbedRenderCues(_tlEmbedSelected);
}

function _tlEmbedRenderCues(name){
  const cueRows=document.getElementById('tl-embed-cues'); if(!cueRows) return;
  const nameEl=document.getElementById('tl-embed-name');
  const transport=document.getElementById('tl-embed-transport');
  const tl=state.timelines[name]; if(!tl){cueRows.innerHTML='';return;}
  const p=tlGetPlayer(name);
  const elapsed=tlElapsed(name);
  if(nameEl) nameEl.textContent=name+(tl.looping?' ⟳':'')+(p.running?' ▶ '+formatTC(elapsed):'');
  if(transport&&!transport.querySelector('.tl-edit-btn')){
    const editBtn=document.createElement('button');
    editBtn.className='tl-edit-btn';
    editBtn.textContent='EDIT →';
    editBtn.style.cssText='background:var(--bg3);border:1px solid var(--border2);color:var(--accent);font-family:var(--ui);font-size:8px;padding:2px 6px;cursor:pointer;border-radius:2px;flex-shrink:0';
    editBtn.onclick=()=>{switchTab('timelines');_tcSelectedName=name;tcSelectTimeline(name);};
    transport.appendChild(editBtn);
  }
  cueRows.innerHTML='';
  if(!tl.steps?.length){
    cueRows.innerHTML='<div style="padding:12px 8px;color:var(--text2);font-size:10px">No cue rows — click EDIT → to add</div>';
    return;
  }
  tl.steps.forEach((s,i)=>{
    const fired=p.running&&s.timeMs<=elapsed;
    const isCurrent=p.running&&s.timeMs<=elapsed&&(i===tl.steps.length-1||tl.steps[i+1].timeMs>elapsed);
    const row=document.createElement('div');
    row.style.cssText=`display:grid;grid-template-columns:80px 1fr;gap:0;padding:4px 8px;border-bottom:1px solid var(--border);background:${isCurrent?'rgba(80,200,120,0.07)':'transparent'}`;
    row.innerHTML=`<span style="color:${fired?'var(--accent3)':'var(--text2)'}">${formatTC(s.timeMs)}</span><span style="color:${fired?'var(--text0)':'var(--text1)'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHTML(s.cmd||'')}">${escHTML(s.cmd||'')}</span>`;
    cueRows.appendChild(row);
  });
}

function setupPanelCanvas(canvas) {
  if(!canvas) return;
  state.viz3d.canvas=canvas; state.viz3d.ctx=canvas.getContext('2d');
  const resize=()=>{const w=canvas.offsetWidth,h=canvas.offsetHeight;if(w>0&&h>0){canvas.width=w;canvas.height=h;draw3D();}};
  resize(); new ResizeObserver(resize).observe(canvas);
  let drag=false,lx=0,ly=0;
  canvas.addEventListener('mousedown',e=>{drag=true;lx=e.clientX;ly=e.clientY;canvas.style.cursor='grabbing';});
  canvas.addEventListener('mousemove',e=>{if(!drag)return;state.viz3d.camAngle+=(e.clientX-lx)*0.008;state.viz3d.camElev+=(e.clientY-ly)*0.008;state.viz3d.camElev=state.viz3d.camElev%(Math.PI*2);lx=e.clientX;ly=e.clientY;draw3D();});
  canvas.addEventListener('mouseup',()=>{drag=false;canvas.style.cursor='grab';});
  canvas.addEventListener('mouseleave',()=>{drag=false;canvas.style.cursor='grab';});
  canvas.addEventListener('wheel',e=>{state.viz3d.camDist=Math.max(200,Math.min(1400,state.viz3d.camDist+e.deltaY*0.6));draw3D();e.preventDefault();},{passive:false});
  canvas.addEventListener('dblclick',e=>{const id=pick3DFixture(e);if(id!==null)openFix3DEdit(id);});
  draw3D();
}

// ─── PATCH RENDER ──────────────────────────────────────────────────────────────
function renderPatch() {
  const tbody=document.getElementById('patch-body'); if(!tbody) return;
  tbody.innerHTML='';
  state.patchData.forEach(f=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`<td>${f.id}</td><td>${escHTML(f.name)}</td><td>${escHTML(f.profileName||f.profileId||'—')}</td><td>${f.addr}</td><td style="color:var(--accent2)">${f.modeName||'—'}</td><td style="color:var(--text2)">${f.ch}</td><td><span style="cursor:pointer;color:var(--text2)" onclick="removePatch(${f.id})">✕</span></td>`;
    tbody.appendChild(tr);
  });
}

function renderLinks() {
  const el=document.getElementById('links-list'),empty=document.getElementById('links-empty'); if(!el) return;
  el.innerHTML='';
  if(!state.links.length){if(empty)empty.style.display='block';return;}
  if(empty)empty.style.display='none';
  state.links.forEach((l,i)=>{
    const row=document.createElement('div'); row.className='link-row';
    const fmt=s=>s.replace(/\$[^$]+\$/g,m=>`<span class="link-var">${m}</span>`);
    row.innerHTML=`<span class="link-source">${fmt(l.source)}</span><span class="link-arrow">→</span><span class="link-target">${fmt(l.target)}</span><span class="link-edit-btn" onclick="editLink(${i})">✎</span><span class="link-del" onclick="deleteLink(${i})">✕</span>`;
    el.appendChild(row);
  });
}

function updateProgBar() {
  const selArr=[...state.selected];
  const selEl=document.getElementById('prog-sel'),cueEl=document.getElementById('prog-cue'),nxtEl=document.getElementById('prog-next');
  if(selEl) selEl.textContent=selArr.length?selArr.join(','):'—';
  const cur=state.cues[state.currentCue],nxt=state.cues[state.currentCue+1];
  if(cueEl) cueEl.textContent=cur?`${cur.num} ${cur.name}`:'—';
  if(nxtEl) nxtEl.textContent=nxt?`${nxt.num} ${nxt.name}`:'—';
  const progCount=Object.keys(programmer).length;
  const pp=document.getElementById('prog-param');
  if(pp){pp.textContent=progCount>0?`PROG(${progCount})`:'—';pp.style.color=progCount>0?'var(--accent)':'';}
}

// ─── FIXTURE / SELECTION ───────────────────────────────────────────────────────
function toggleFixture(id) { if(state.selected.has(id))state.selected.delete(id);else state.selected.add(id); renderFixtures();updateProgBar(); }
function selectAll() { state.fixtures.forEach(f=>state.selected.add(f.id)); renderFixtures();updateProgBar(); }
function clearSel() { state.selected.clear(); renderFixtures();updateProgBar(); }
function selectGroup() { const g=prompt('Select fixture range (e.g. 1-8):'); if(!g)return; expandFixSpec(g).forEach(id=>state.selected.add(id)); renderFixtures();updateProgBar(); }
function setGridCols(v) { const n=parseInt(v); if(n>=4&&n<=16){state.gridCols=n;renderFixtures();} }

// ─── FADER CONTROLS ───────────────────────────────────────────────────────────
function toggleFader(i) { state.faders[i].val=state.faders[i].val>0?0:80; updateFaderUI(i); applyFaderOutput(i); renderFaders(); }
function releaseAll() { state.faders.forEach((_,i)=>{state.faders[i].val=0;updateFaderUI(i);}); renderFaders(); logHistory('>','RELEASE ALL','ok'); }

// ─── CUE CONTROL ──────────────────────────────────────────────────────────────
function goCue() {
  if(!state.cues.length)return;
  if(state.currentCue<state.cues.length-1){state.currentCue++;fireCue(state.currentCue);}
  else logHistory('·','End of cuelist','info');
}
function backCue() {
  if(!state.cues.length)return;
  if(state.currentCue<=0){logHistory('·','Already at first cue','info');return;}
  state.currentCue--; logHistory('>',`BACK → CUE ${state.cues[state.currentCue].num}`,'info'); renderCues();
}
function jumpCue(i) { state.currentCue=i; fireCue(i); }
function stopCue() { Object.keys(state.fadeTimers).forEach(k=>{clearInterval(state.fadeTimers[k]);delete state.fadeTimers[k];}); logHistory('>','STOP','info'); }

function fireCue(i) {
  const c=state.cues[i]; if(!c) return;
  logHistory('>',`GO CUE ${c.num} "${c.name}"${c.mib?' [MIB]':''}`,'ok');
  const runCue=()=>{
    if(c.snapshot&&Object.keys(c.snapshot).length>0){
      Object.entries(c.snapshot).forEach(([idStr,params])=>{
        const id=parseInt(idStr),f=state.fixtures.find(x=>x.id===id); if(!f) return;
        Object.entries(params).forEach(([param,val])=>{
          if(c.fade>0) fadeFixtureParam([id],param,val,c.fade);
          else{if(param in f)f[param]=val;}
        });
      });
      if(c.fade<=0){renderFixtures();drawIfVisible();}
    } else {
      const name=c.name.toLowerCase(),ids=state.fixtures.map(f=>f.id);
      if(name.includes('black'))fadeFixtureParam(ids,'dimmer',0,c.fade||0);
      else if(name.includes('full'))fadeFixtureParam(ids,'dimmer',255,c.fade||0);
      else{const lvl=120+Math.floor(Math.random()*135);fadeFixtureParam(ids,'dimmer',lvl,c.fade||0);}
    }
  };
  if(c.mib){fadeFixtureParam(state.fixtures.map(f=>f.id),'dimmer',0,500);setTimeout(runCue,600);}
  else runCue();
  renderCues();
  remoteBroadcast();
}
function fadeFixtureParam(ids, param, targetVal, durationMs) {
  if(durationMs<=0){ids.forEach(id=>{const f=state.fixtures.find(x=>x.id===id);if(f&&param in f)f[param]=targetVal;});renderFixtures();drawIfVisible();return;}
  const key=ids.join(',')+'.'+param;
  if(state.fadeTimers[key])clearInterval(state.fadeTimers[key]);
  const steps=Math.max(20,Math.round(durationMs/40)); let step=0;
  const startVals={};ids.forEach(id=>{const f=state.fixtures.find(x=>x.id===id);if(f)startVals[id]=f[param]??0;});
  state.fadeTimers[key]=setInterval(()=>{
    step++;const t=step/steps;
    ids.forEach(id=>{const f=state.fixtures.find(x=>x.id===id);if(!f||!(param in f))return;f[param]=Math.round(startVals[id]+(targetVal-startVals[id])*t);});
    renderFixtures();drawIfVisible();
    if(step>=steps){clearInterval(state.fadeTimers[key]);delete state.fadeTimers[key];remoteBroadcast();}
  },40);
}

function drawIfVisible() {
  if(!state.viz3d.canvas) return;
  if(state.viz3d.canvas.offsetParent!==null||document.getElementById('viz3d-panel')?.style.display!=='none') draw3D();
}

// ─── PRESETS ──────────────────────────────────────────────────────────────────
function recallPreset(p) {
  const selIds=[...state.selected];
  if(!selIds.length){logHistory('!','Select fixtures first','err');return;}
  logHistory('>',`RECALL PRESET ${p.type}.${p.num} "${p.name}"`,'ok');
  if(p.snapshot){
    // Stored as tracking preset
    selIds.forEach(id=>{
      const f=state.fixtures.find(x=>x.id===id); if(!f) return;
      const src=p.snapshot[id]||Object.values(p.snapshot)[0]; if(!src) return;
      Object.entries(src).forEach(([param,val])=>{if(param in f)fadeFixtureParam([id],param,val,1000);});
    });
  } else if(p.type==='INT'){
    const vals={'1':255,'2':128,'3':40};fadeFixtureParam(selIds,'dimmer',vals[p.num]??128,1000);
  } else if(p.type==='COL'){
    const cols={'1':[255,180,80],'2':[200,220,255],'3':[255,0,0],'4':[0,60,255]};
    const rgb=cols[p.num]||[255,255,255];
    selIds.forEach(id=>{const f=state.fixtures.find(x=>x.id===id);if(f){f.red=rgb[0];f.green=rgb[1];f.blue=rgb[2];}});
    renderFixtures();drawIfVisible();
  }
  remoteBroadcast();
}
function buildChannelMap(fixture) {
  if(fixture.gdtf&&fixture.gdtfChannels?.length){
    const map={};fixture.gdtfChannels.forEach(ch=>{if(ch.param&&!(ch.param in map))map[ch.param]=ch.offset-1;});
    return{map,channelCount:fixture.channels};
  }
  if(!window.FixtureDB||!fixture.profileId) return null;
  const profile=window.FixtureDB.getProfileById(fixture.profileId); if(!profile) return null;
  const mode=profile.modes.find(m=>m.name===fixture.modeName)||profile.modes[0]; if(!mode) return null;
  const map={};
  mode.channels.forEach((ch,idx)=>{const param=CHANNEL_NAME_MAP[ch.name.toLowerCase().trim()];if(param&&!(param in map))map[param]=idx;});
  return{map,channelCount:mode.channels.length};
}

function buildDMXOutput() {
  const universes={};
  state.fixtures.forEach(f=>{
    const base=(f.address||1)-1,universe=Math.floor(base/512)+1,offset=base%512;
    if(!universes[universe])universes[universe]=new Uint8Array(512);
    const buf=universes[universe],chMap=buildChannelMap(f);
    if(chMap&&chMap.map){
      const vals={dimmer:f.dimmer??0,red:f.red??255,green:f.green??255,blue:f.blue??255,white:f.white??0,amber:f.amber??0,uv:f.uv??0,pan:f.pan??127,tilt:f.tilt??127,panFine:f.panFine??0,tiltFine:f.tiltFine??0,gobo:f.gobo??0,color:f.color??0,shutter:f.shutter??255,strobe:f.strobe??0,zoom:f.zoom??127,focus:f.focus??127,iris:f.iris??0,prism:f.prism??0,frost:f.frost??0,speed:f.speed??128};
      Object.entries(chMap.map).forEach(([param,chIdx])=>{const addr=offset+chIdx;if(addr>=0&&addr<512)buf[addr]=Math.max(0,Math.min(255,Math.round(vals[param]??0)));});
    } else {
      // Generic fallback — only write within the fixture's actual channel footprint
      const chCount = f.channels || 8;
      const gv = [f.dimmer??0,f.red??255,f.green??255,f.blue??255,f.pan??127,f.tilt??127,f.gobo??0,f.color??0,f.shutter??255,f.zoom??127,f.strobe??0,f.focus??127];
      for (let i = 0; i < Math.min(chCount, gv.length); i++) {
        const a = offset + i; if (a < 512) buf[a] = Math.max(0, Math.min(255, Math.round(gv[i])));
      }
    }
  });
  return universes;
}

function openAddFixtureModal() {
  const overlay=document.getElementById('add-fixture-overlay'); if(!overlay) return;
  const searchEl=document.getElementById('af-search'); if(searchEl)searchEl.value='';
  rebuildFixturePicker();
  const last=state.patchData[state.patchData.length-1];
  document.getElementById('af-name').value='Fix '+((last?.id||0)+1);
  // Auto-advance address — wrap to next universe at 512
  const lastEnd=(last?.addr||0)+(last?.ch||0);
  if(lastEnd>512){ document.getElementById('af-addr').value='1'; document.getElementById('af-universe').value=((last?.universe||1)+1); }
  else { document.getElementById('af-addr').value=lastEnd||1; document.getElementById('af-universe').value=last?.universe||1; }
  document.getElementById('af-qty').value='1';
  overlay.style.display='flex';
}

function rebuildFixturePicker() {
  const sel=document.getElementById('af-profile'); if(!sel) return;
  sel.innerHTML='';
  if(gdtfState.loaded&&gdtfState.profiles.length){
    if(!document.getElementById('af-search')){
      const inp=document.createElement('input'); inp.className='modal-input'; inp.id='af-search';
      inp.placeholder='Search fixtures… e.g. "Robe" "moving" "LED PAR"'; inp.style.cssText='width:100%;margin-bottom:6px';
      sel.parentNode.insertBefore(inp,sel);
      inp.addEventListener('input',()=>{
        const q=inp.value.toLowerCase();
        sel.querySelectorAll('optgroup').forEach(g=>{let any=false;g.querySelectorAll('option').forEach(o=>{const show=!q||(o.textContent+' '+g.label).toLowerCase().includes(q);o.style.display=show?'':'none';if(show)any=true;});g.style.display=any?'':'none';});
      });
    }
    // Custom profiles group (always first if any exist)
    if(state.customProfiles?.length){
      const grp=document.createElement('optgroup'); grp.label='★ My Custom Fixtures';
      state.customProfiles.forEach(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=`${p.manufacturer} — ${p.name}`;o.dataset.gdtf=JSON.stringify(p);grp.appendChild(o);});
      sel.appendChild(grp);
    }
    const byMfr={};gdtfState.profiles.forEach(p=>{const m=p.manufacturer||'Unknown';if(!byMfr[m])byMfr[m]=[];byMfr[m].push(p);});
    Object.entries(byMfr).sort(([a],[b])=>a.localeCompare(b)).forEach(([mfr,fixtures])=>{
      const grp=document.createElement('optgroup'); grp.label=mfr;
      fixtures.forEach(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=p.name;o.dataset.gdtf=JSON.stringify(p);grp.appendChild(o);});
      sel.appendChild(grp);
    });
  } else if(state.customProfiles?.length){
    // No GDTF but we have custom profiles
    const grp=document.createElement('optgroup'); grp.label='★ My Custom Fixtures';
    state.customProfiles.forEach(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=`${p.manufacturer} — ${p.name}`;o.dataset.gdtf=JSON.stringify(p);grp.appendChild(o);});
    sel.appendChild(grp);
    updateAddFixtureModes();
  } else if(window.FixtureDB){
    window.FixtureDB.getAllProfiles().forEach(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=`${p.manufacturer} — ${p.name}`;sel.appendChild(o);});
  }
  updateAddFixtureModes();
}

function updateAddFixtureModes() {
  const sel=document.getElementById('af-profile'),modeSel=document.getElementById('af-mode'); if(!sel||!modeSel) return;
  modeSel.innerHTML='';
  const opt=sel.options[sel.selectedIndex];
  if(opt?.dataset?.gdtf){try{const p=JSON.parse(opt.dataset.gdtf);p.modes.forEach(m=>{const o=document.createElement('option');o.value=m.name;o.textContent=`${m.name} (${m.count} ch)`;modeSel.appendChild(o);});updateAddFixtureChInfo();return;}catch(_){}}
  if(window.FixtureDB){const profile=window.FixtureDB.getProfileById(sel.value);if(profile)profile.modes.forEach(m=>{const o=document.createElement('option');o.value=m.name;o.textContent=`${m.name} (${m.channels.length} ch)`;modeSel.appendChild(o);});}
  updateAddFixtureChInfo();
}

function updateAddFixtureChInfo() {
  const sel=document.getElementById('af-profile'),modeSel=document.getElementById('af-mode'),chInfo=document.getElementById('af-ch-info'); if(!sel||!modeSel||!chInfo) return;
  const opt=sel.options[sel.selectedIndex];
  if(opt?.dataset?.gdtf){try{const p=JSON.parse(opt.dataset.gdtf);const mode=p.modes.find(m=>m.name===modeSel.value)||p.modes[0];if(mode){chInfo.textContent=mode.channels.map(c=>c.name).join(', ');return;}}catch(_){}}
  if(window.FixtureDB){const profile=window.FixtureDB.getProfileById(sel.value);const mode=profile?.modes?.find(m=>m.name===modeSel.value)||profile?.modes?.[0];if(mode)chInfo.textContent=mode.channels.map(c=>c.name).join(', ');}
}

function confirmAddFixture() {
  const sel=document.getElementById('af-profile'),modeSel=document.getElementById('af-mode');
  const baseName=document.getElementById('af-name').value.trim()||'New Fix';
  const startAddr=parseInt(document.getElementById('af-addr')?.value||'1');
  const universe=Math.max(1,parseInt(document.getElementById('af-universe')?.value||'1'));
  const qty=Math.max(1,Math.min(64,parseInt(document.getElementById('af-qty')?.value||'1')));
  // Convert universe+addr to absolute address
  const absAddr=(universe-1)*512+startAddr;
  const opt=sel?.options[sel.selectedIndex];

  // Helper to patch one fixture
  const patchOne=(q, addrOffset, profile, mode, ch, swatchColor, isGdtf)=>{
    const id=(state.patchData[state.patchData.length-1]?.id||0)+1;
    const ix=(id-1)%8, iz=Math.floor((id-1)/8);
    const name=qty>1?`${baseName} ${q+1}`:baseName;
    const thisAddr=absAddr+addrOffset;
    const thisUniverse=Math.floor((thisAddr-1)/512)+1;
    const thisOffset=((thisAddr-1)%512)+1;
    if(isGdtf){
      const swatches={'SPOT':'#e8a020','BEAM':'#e8f020','WASH':'#20a8e8','LED':'#48d888','STROB':'#f8f8f8','PAR':'#e87030'};
      state.fixtures.push({id,type:profile.type||'FIX',profileId:profile.id,modeName:mode?.name||'Default',gdtf:true,gdtfChannels:mode?.channels||[],address:thisAddr,universe:thisUniverse,channels:ch,dimmer:0,red:255,green:255,blue:255,white:0,amber:0,uv:0,pan:127,tilt:127,gobo:0,color:0,shutter:255,zoom:127,strobe:0,focus:127,swatch:swatches[profile.type]||'#38a8f8',stageX:ix*120-420,stageZ:iz*160-160,stageY:300});
      state.patchData.push({id,name,profileId:profile.id,profileName:`${profile.manufacturer} ${profile.name}`,modeName:mode?.name,addr:thisOffset,universe:thisUniverse,ch});
    } else {
      state.fixtures.push({id,type:profile?.type||'PAR',profileId:profile?.id||'generic',modeName:mode?.name||'8CH',address:thisAddr,universe:thisUniverse,channels:ch,...(swatchColor?{swatch:swatchColor}:{swatch:'#38a8f8'}),dimmer:0,red:255,green:255,blue:255,pan:127,tilt:127,gobo:0,shutter:255,zoom:127,stageX:ix*120-420,stageZ:iz*160-160,stageY:300});
      state.patchData.push({id,name,profileId:profile?.id||'generic',profileName:profile?.name||'Generic',modeName:mode?.name||'8CH',addr:thisOffset,universe:thisUniverse,ch});
    }
  };

  if(opt?.dataset?.gdtf){
    try{
      const profile=JSON.parse(opt.dataset.gdtf);
      const mode=profile.modes.find(m=>m.name===modeSel?.value)||profile.modes[0];
      const ch=mode?.count||8;
      for(let q=0;q<qty;q++) patchOne(q,q*ch,profile,mode,ch,null,true);
      closeAddFixtureModal();renderAll();
      logHistory('>',`Patched ${qty}× "${baseName}" — ${profile.manufacturer} ${profile.name} ${mode?.name} @ U${universe}/${startAddr}`,'ok');
      return;
    }catch(e){console.error('GDTF patch:',e);}
  }
  const profId=sel?.value||'generic-par',modeName=modeSel?.value||'8CH';
  const profile=window.FixtureDB?window.FixtureDB.getProfileById(profId):null;
  const modeObj=profile?(profile.modes.find(m=>m.name===modeName)||profile.modes[0]):null;
  const chCount=modeObj?modeObj.channels.length:16;
  for(let q=0;q<qty;q++) patchOne(q,q*chCount,profile,modeObj,chCount,null,false);
  closeAddFixtureModal();renderAll();
  logHistory('>',`Patched ${qty}× "${baseName}" @ U${universe}/${startAddr} — ${profile?.name||'Generic'} ${modeName}`,'ok');
}

function closeAddFixtureModal() { document.getElementById('add-fixture-overlay').style.display='none'; }
function removePatch(id) { state.patchData=state.patchData.filter(p=>p.id!==id);state.fixtures=state.fixtures.filter(f=>f.id!==id);state.selected.delete(id);renderAll(); }
function clearPatch() { if(confirm('Clear all patched fixtures?')){state.patchData=[];state.fixtures=[];state.selected.clear();renderAll();} }

// ─── CUSTOM FIXTURE BUILDER ───────────────────────────────────────────────────
const CUSTOM_PARAM_OPTIONS=['dimmer','red','green','blue','white','amber','uv','pan','tilt','pan_fine','tilt_fine','zoom','focus','gobo','color','shutter','strobe','speed','iris','prism','frost','macro','reserved'];
let _cfbChannels=[]; // [{name,param}]
let _cfbModes=[];    // [{name,channels:[indices]}]

function openCustomFixtureBuilder(){
  _cfbChannels=[{name:'Dimmer',param:'dimmer'},{name:'Red',param:'red'},{name:'Green',param:'green'},{name:'Blue',param:'blue'}];
  _cfbModes=[{name:'4CH',channels:[0,1,2,3]}];
  document.getElementById('cfb-fix-name').value='My Fixture';
  document.getElementById('cfb-mfr').value='Custom';
  document.getElementById('cfb-type').value='LED';
  document.getElementById('cfb-addr').value=((state.patchData[state.patchData.length-1]?.addr||0)+(state.patchData[state.patchData.length-1]?.ch||0))||1;
  document.getElementById('cfb-qty').value='1';
  cfbRenderChannels(); cfbRenderModes();
  document.getElementById('cfb-overlay').style.display='flex';
}
function closeCustomFixtureBuilder(){document.getElementById('cfb-overlay').style.display='none';}

function cfbRenderChannels(){
  const list=document.getElementById('cfb-ch-list'); if(!list) return;
  list.innerHTML='';
  _cfbChannels.forEach((ch,i)=>{
    const row=document.createElement('div');
    row.style.cssText='display:grid;grid-template-columns:28px 1fr 1fr 28px;gap:4px;align-items:center;margin-bottom:4px';
    row.innerHTML=`
      <span style="font-family:var(--mono);font-size:10px;color:var(--text2);text-align:center">${i+1}</span>
      <input value="${escHTML(ch.name)}" oninput="_cfbChannels[${i}].name=this.value" style="background:var(--bg3);border:1px solid var(--border2);color:var(--text0);font-family:var(--mono);font-size:10px;padding:3px 6px;border-radius:2px;outline:none">
      <select onchange="_cfbChannels[${i}].param=this.value" style="background:var(--bg3);border:1px solid var(--border2);color:var(--text0);font-family:var(--mono);font-size:10px;padding:3px 4px;border-radius:2px;outline:none">
        ${CUSTOM_PARAM_OPTIONS.map(p=>`<option value="${p}"${p===ch.param?' selected':''}>${p}</option>`).join('')}
      </select>
      <button onclick="cfbRemoveCh(${i})" style="background:none;border:none;color:var(--danger);font-size:12px;cursor:pointer;padding:0">✕</button>`;
    list.appendChild(row);
  });
}
function cfbAddCh(){_cfbChannels.push({name:'Ch'+(_cfbChannels.length+1),param:'reserved'});cfbRenderChannels();}
function cfbRemoveCh(i){_cfbChannels.splice(i,1);_cfbModes.forEach(m=>{m.channels=m.channels.filter(c=>c!==i).map(c=>c>i?c-1:c);});cfbRenderChannels();cfbRenderModes();}

function cfbRenderModes(){
  const list=document.getElementById('cfb-mode-list'); if(!list) return;
  list.innerHTML='';
  _cfbModes.forEach((mode,mi)=>{
    const row=document.createElement('div');
    row.style.cssText='background:var(--bg3);border:1px solid var(--border2);border-radius:3px;padding:8px 10px;margin-bottom:6px';
    const chkBoxes=_cfbChannels.map((ch,ci)=>`<label style="font-family:var(--mono);font-size:9px;cursor:pointer;display:flex;align-items:center;gap:2px;background:var(--bg4);padding:2px 5px;border-radius:2px;border:1px solid ${mode.channels.includes(ci)?'var(--accent)':'var(--border2)'};color:${mode.channels.includes(ci)?'var(--accent)':'var(--text2)'}"><input type="checkbox" ${mode.channels.includes(ci)?'checked':''} onchange="cfbToggleModeChannel(${mi},${ci},this.checked)" style="display:none">${ci+1}:${escHTML(ch.name)}</label>`).join('');
    row.innerHTML=`<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px"><input value="${escHTML(mode.name)}" oninput="_cfbModes[${mi}].name=this.value" style="background:var(--bg2);border:1px solid var(--border2);color:var(--text0);font-family:var(--mono);font-size:10px;padding:3px 6px;border-radius:2px;outline:none;width:80px"><span style="font-family:var(--mono);font-size:9px;color:var(--text2)">${mode.channels.length} ch</span><button onclick="cfbRemoveMode(${mi})" style="background:none;border:none;color:var(--danger);font-size:10px;cursor:pointer;margin-left:auto">✕</button></div><div style="display:flex;flex-wrap:wrap;gap:3px">${chkBoxes}</div>`;
    list.appendChild(row);
  });
}
function cfbToggleModeChannel(mi,ci,on){if(on){if(!_cfbModes[mi].channels.includes(ci))_cfbModes[mi].channels.push(ci);}else{_cfbModes[mi].channels=_cfbModes[mi].channels.filter(c=>c!==ci);}_cfbModes[mi].channels.sort((a,b)=>a-b);cfbRenderModes();}
function cfbAddMode(){_cfbModes.push({name:_cfbChannels.length+'CH',channels:_cfbChannels.map((_,i)=>i)});cfbRenderModes();}
function cfbRemoveMode(i){_cfbModes.splice(i,1);cfbRenderModes();}

function cfbSaveAndPatch(){
  const fixName=document.getElementById('cfb-fix-name').value.trim()||'Custom Fix';
  const mfr=document.getElementById('cfb-mfr').value.trim()||'Custom';
  const type=document.getElementById('cfb-type').value||'LED';
  const addr=parseInt(document.getElementById('cfb-addr').value)||1;
  const qty=Math.max(1,Math.min(64,parseInt(document.getElementById('cfb-qty').value)||1));
  if(!_cfbModes.length){logHistory('!','Add at least one mode','err');return;}
  if(!_cfbChannels.length){logHistory('!','Add at least one channel','err');return;}
  const modes=_cfbModes.map(m=>({name:m.name,count:m.channels.length,channels:m.channels.map((ci,pos)=>({name:_cfbChannels[ci].name,param:_cfbChannels[ci].param,offset:pos+1}))}));
  const profId='custom_'+Date.now();

  // Save to custom profile library so it shows up in future Add Fixture sessions
  if(!state.customProfiles) state.customProfiles=[];
  const newProfile={id:profId,manufacturer:mfr,name:fixName,type,modes,custom:true};
  state.customProfiles.push(newProfile);

  const mode=modes[0]; let nextAddr=addr;
  for(let q=0;q<qty;q++){
    const id=(state.patchData[state.patchData.length-1]?.id||0)+1;
    const ix=(id-1)%8,iz=Math.floor((id-1)/8);
    state.fixtures.push({id,type,profileId:profId,modeName:mode.name,gdtf:true,gdtfChannels:mode.channels,address:nextAddr,channels:mode.count,dimmer:0,red:255,green:255,blue:255,white:0,amber:0,uv:0,pan:127,tilt:127,gobo:0,color:0,shutter:255,zoom:127,strobe:0,focus:127,swatch:'#38d8b8',stageX:ix*120-420,stageZ:iz*160-160,stageY:300});
    state.patchData.push({id,name:qty>1?fixName+' '+(q+1):fixName,profileId:profId,profileName:`${mfr} ${fixName}`,modeName:mode.name,addr:nextAddr,ch:mode.count,universe:1});
    nextAddr+=mode.count;
  }
  closeCustomFixtureBuilder(); renderAll();
  logHistory('>',`Patched ${qty}× "${fixName}" (${mode.count}ch) @ ${addr} — saved to library`,'ok');
}

// ─── LINKS ────────────────────────────────────────────────────────────────────
function addLink() { openLinkEditor(); }
function deleteLink(i) { state.links.splice(i,1); renderLinks(); }

function linksShowSection(name, btn) {
  ['osc','midi','pp'].forEach(s => {
    const el = document.getElementById('links-section-'+s);
    if (el) el.style.display = s === name ? 'flex' : 'none';
  });
  document.querySelectorAll('.link-nav-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  if (name === 'midi') { midiRefreshPanel(); renderMIDILinks(); }
  if (name === 'pp') renderPPLinks();
}

async function ppOSCInit() {
  const port = parseInt(document.getElementById('pp-osc-port')?.value || '9999');
  const statusEl = document.getElementById('pp-status');
  if (statusEl) statusEl.textContent = 'Connecting…';
  // ProPresenter OSC is received via WebSocket in main process (OSC→WS bridge)
  if (window.electronAPI?.ppConnect) {
    const r = await window.electronAPI.ppConnect(port);
    if (statusEl) statusEl.textContent = r.ok ? `Listening on :${port}` : 'Failed: ' + r.error;
    if (statusEl) statusEl.style.color = r.ok ? 'var(--accent3)' : 'var(--danger)';
  } else {
    if (statusEl) statusEl.textContent = 'OSC bridge not available — update Electron';
    if (statusEl) statusEl.style.color = 'var(--accent2)';
  }
}

// ─── COMMAND PARSING ──────────────────────────────────────────────────────────
function parseCommand(raw) {
  if(!raw.trim()) return;
  // Record hook — capture commands into timeline record
  _tlRecordHook(raw.trim());
  // Support semicolon-separated multiple commands
  if(raw.includes(';')){raw.split(';').forEach(c=>{if(c.trim())parseCommand(c.trim());});return;}
  const resolved=raw.trim().replace(/\$([^$]+)\$/g,(_,n)=>state.vars[n.toLowerCase()]??`$${n}$`);
  const parts=resolved.split(/\s+/),action=parts[0].toUpperCase();

  if(action==='HELP'){showHelp();return;}
  if(action==='GO'){goCue();logHistory('>','GO','ok');return;}
  if(action==='BACK'){backCue();logHistory('>','BACK','ok');return;}
  if(action==='STOP'){stopCue&&stopCue();logHistory('>','STOP','ok');return;}
  if(action==='JUMP'&&parts[1]?.toUpperCase()==='CUE'){const i=parseInt(parts[2]);if(!isNaN(i))jumpCue(i);logHistory('>',raw,'ok');return;}
  if(action==='SELECT'){
    if(parts[1]?.toUpperCase()==='ALL'){selectAll();logHistory('>',raw,'ok');return;}
    if(parts[1]?.toUpperCase()==='GROUP'){
      const gname=parts.slice(2).join(' '),group=state.groups[gname];
      if(!group){logHistory('!',`Group "${gname}" not found`,'err');return;}
      state.selected=new Set(group);renderFixtures();updateProgBar();
      logHistory('>',raw,'ok');logHistory('·',`Selected GROUP "${gname}" (${group.length} fixtures)`,'ok');return;
    }
    if(parts[1]?.toUpperCase()==='FIX'){
      const ids=parts.slice(2).join(',').split(',').map(Number).filter(Boolean);
      state.selected.clear(); ids.forEach(id=>state.selected.add(id));
      renderFixtures();updateProgBar();logHistory('>',raw,'ok');return;
    }
    logHistory('!','SELECT ALL | SELECT GROUP <name> | SELECT FIX <ids>','err');return;
  }
  if(action==='FADER'){
    const idx=parseInt(parts[1])-1,val=Math.max(0,Math.min(255,parseInt(parts[2])||0));
    if(idx>=0&&idx<state.faders.length){state.faders[idx].val=val;applyFaderOutput(idx);logHistory('>',raw,'ok');}
    else logHistory('!',`FADER ${parts[1]} not found`,'err');return;
  }
  if(action==='TIMELINE'){
    const sub=parts[1]?.toUpperCase();
    const tname=parts.slice(2).join(' ');
    if(sub==='PLAY'&&tname){tlPlay(tname);logHistory('>',raw,'ok');return;}
    if(sub==='PAUSE'&&tname){tlPause(tname);logHistory('>',raw,'ok');return;}
    if(sub==='STOP'){if(tname)tlStop(tname);else Object.keys(state.timelines).forEach(tlStop);logHistory('>',raw,'ok');return;}
    if(sub==='RESET'&&tname){tlReset(tname);logHistory('>',raw,'ok');return;}
    if(sub==='RECORD'||sub==='REC'){tlStartRecord(tname||('REC_'+Date.now()));logHistory('>',raw,'ok');return;}
    if(sub==='STOPREC'||sub==='STOPRECORD'){tlStopRecord();logHistory('>',raw,'ok');return;}
    mlOpen('TIMELINE',parts[1]||('TL'+(Object.keys(state.timelines).length+1)));return;
  }
  // RECALL PRESET <type>.<num>  or  RECALL PRESET <type> <num>
  if(action==='RECALL'){
    if(parts[1]?.toUpperCase()==='PRESET'){
      const spec=parts[2]||'';
      let ptype,pnum;
      if(spec.includes('.')){[ptype,pnum]=spec.split('.');}
      else{ptype=spec;pnum=parts[3];}
      const p=state.presets.find(x=>x.type===ptype&&String(x.num)===String(pnum));
      if(!p){logHistory('!',`PRESET ${ptype}.${pnum} not found`,'err');return;}
      recallPreset(p);logHistory('>',raw,'ok');logHistory('·',`PRESET "${p.name}" recalled`,'ok');return;
    }
    logHistory('!','RECALL PRESET <type>.<num>','err');return;
  }
  if(action==='SET'||action==='FADE'){handleSetFade(parts,action,raw);return;}
  if(action==='BITMAP'){handleBitmap(parts,raw);return;}
  if(action==='RECALL'){
    const sub=parts[1]?.toUpperCase();
    if(sub==='PRESET'){
      const pspec=parts[2]||''; const [ptype,pnum]=pspec.includes('.')?pspec.split('.'):['',pspec];
      const preset=state.presets.find(p=>(ptype?p.type===ptype:true)&&p.num===pnum);
      if(!preset){logHistory('!',`Preset ${pspec} not found`,'err');return;}
      recallPreset(preset);logHistory('>',raw,'ok');return;
    }
    if(sub==='CUE'){
      const cnum=parts[2]; const ci=state.cues.findIndex(c=>c.num===String(cnum));
      if(ci<0){logHistory('!',`Cue ${cnum} not found`,'err');return;}
      fireCue(ci);logHistory('>',raw,'ok');return;
    }
    if(sub==='TIMELINE'||sub==='TL'){
      const tname=parts.slice(2).join(' ');
      if(state.timelines[tname]){tlPlay(tname);logHistory('>',raw,'ok');}
      else{logHistory('!',`Timeline "${tname}" not found`,'err');}
      return;
    }
    logHistory('!','RECALL PRESET <type>.<num> | RECALL CUE <num> | RECALL TIMELINE <name>','err');return;
  }
  if(action==='STORE'){handleStore(parts,raw);return;}
  if(action==='DELETE'||action==='DEL'){handleDelete(parts,raw);return;}
  if(action==='PATCH'){handlePatch(parts,raw);return;}
  if(action==='EFFECT'){handleEffectCommand(parts,raw);return;}
  if(action==='$'){const n=parts[1]?.toLowerCase(),v=parts.slice(3).join(' ');if(n){state.vars[n]=v;logHistory('>',raw,'ok');logHistory('·',`$${n}$ = "${v}"`,'ok');}return;}
  if(action==='PLACEHOLDER'){
    logHistory('·','PLACEHOLDER — edit this cue row in the Timeline tab','info');
    return;
  }
  if(action==='SNEAK'||action==='E'){
    // SNEAK [time_ms] — fade current output to programmer values, then clear programmer
    // MA-style: smoothly takes fixtures from their current state to what's in the programmer
    const sneakMs=parseInt(parts[1])||2000;
    const progIds=Object.keys(programmer).map(Number).filter(id=>state.fixtures.find(f=>f.id===id));
    if(!progIds.length){
      logHistory('!','Programmer is empty — SET values first, then SNEAK to fade them in','err');
      return;
    }
    let count=0;
    progIds.forEach(id=>{
      const prog=programmer[id]; if(!prog) return;
      Object.entries(prog).forEach(([param,val])=>{
        fadeFixtureParam([id],param,val,sneakMs);
        count++;
      });
    });
    // Clear programmer after sneak completes
    setTimeout(()=>{
      progIds.forEach(id=>delete programmer[id]);
      const pp=document.getElementById('prog-param');if(pp){pp.textContent='—';pp.style.color='';}
    }, sneakMs+50);
    logHistory('>',raw,'ok');
    logHistory('·',`SNEAK — ${progIds.length} fixtures, ${count} params over ${sneakMs}ms`,'ok');
    return;
  }
  if(action==='CLEAR'){
    Object.keys(programmer).forEach(k=>delete programmer[k]);
    const pp=document.getElementById('prog-param');if(pp){pp.textContent='—';pp.style.color='';}
    logHistory('>',raw,'ok');logHistory('·','Programmer cleared','info');return;
  }
  logHistory('>',raw,'err');logHistory('!',`Unknown command "${action}" — type HELP`,'err');
}

// ─── PATCH COMMAND ─────────────────────────────────────────────────────────────
// PATCH FIX <id> ADDR <addr>           — set address of existing fixture
// PATCH FIX <id> NAME <name>           — rename fixture
// PATCH FIX <id> MODE <modename>       — change mode
// PATCH ADD <name> ADDR <addr> [PROFILE <id>]  — add new fixture
function handlePatch(parts, raw) {
  if(parts.length<3){logHistory('!','PATCH: PATCH FIX <id> ADDR <n>  |  PATCH ADD <name> ADDR <n>','err');return;}
  const sub=parts[1].toUpperCase();
  if(sub==='FIX'){
    const fixId=parseInt(parts[2]);
    const f=state.fixtures.find(x=>x.id===fixId),pd=state.patchData.find(x=>x.id===fixId);
    if(!f||!pd){logHistory('!',`FIX ${fixId} not found in patch`,'err');return;}
    const prop=parts[3]?.toUpperCase(),val=parts.slice(4).join(' ');
    if(prop==='ADDR'||prop==='ADDRESS'){
      const a=parseInt(val); if(isNaN(a)||a<1||a>512*32){logHistory('!','Invalid address','err');return;}
      // Enforce channel limit
      if(!licCheckChannelCount(a+(f.channels||1)-1)){
        logHistory('!',`Channel limit: your ${licenseState.label} plan allows ${licenseState.channels} channels. Address ${a} exceeds this.`,'err');
        return;
      }
      f.address=a;pd.addr=a;renderPatch();renderFixtures();
      logHistory('>',raw,'ok');logHistory('·',`FIX ${fixId} address → ${a}`,'ok');
    } else if(prop==='NAME'){
      if(!val){logHistory('!','PATCH FIX <id> NAME <name>','err');return;}
      pd.name=val;renderPatch();renderFixtures();
      logHistory('>',raw,'ok');logHistory('·',`FIX ${fixId} renamed to "${val}"`,'ok');
    } else if(prop==='MODE'){
      f.modeName=val;pd.modeName=val;renderPatch();
      logHistory('>',raw,'ok');logHistory('·',`FIX ${fixId} mode → ${val}`,'ok');
    } else {logHistory('!','PATCH FIX: use ADDR / NAME / MODE','err');}
    return;
  }
  if(sub==='ADD'){
    const name=parts[2]||'New Fix';
    const addrIdx=parts.indexOf('ADDR');
    const addr=addrIdx>=0?parseInt(parts[addrIdx+1]):((state.patchData[state.patchData.length-1]?.addr||0)+(state.patchData[state.patchData.length-1]?.ch||0))||1;
    const profileIdx=parts.indexOf('PROFILE');
    const profId=profileIdx>=0?parts[profileIdx+1]:'generic-par';
    const id=(state.patchData[state.patchData.length-1]?.id||0)+1;
    const ix=(id-1)%8,iz=Math.floor((id-1)/8);
    const profile=window.FixtureDB?window.FixtureDB.getProfileById(profId):null;
    const mode=profile?.modes?.[0];const chCount=mode?.channels?.length||8;
    // Enforce channel limit
    if(!licCheckChannelCount(addr+chCount-1)){
      logHistory('!',`Channel limit: ${licenseState.label} plan allows ${licenseState.channels} ch. Upgrade for more.`,'err');
      openLicenseOverlay();
      return;
    }
    const defaults=window.FixtureDB?window.FixtureDB.getProfileDefaults(profId,mode?.name||''):{dimmer:0,red:255,green:255,blue:255,pan:127,tilt:127,gobo:0,color:0,shutter:255,zoom:127,strobe:0,focus:127};
    state.fixtures.push({id,type:profile?.type||'PAR',profileId:profId,modeName:mode?.name||'default',address:addr,channels:chCount,...defaults,swatch:'#38a8f8',stageX:ix*120-420,stageZ:iz*160-160,stageY:300});
    state.patchData.push({id,name,profileId:profId,profileName:profile?.name||'Generic',modeName:mode?.name||'default',addr,ch:chCount});
    renderAll();logHistory('>',raw,'ok');logHistory('·',`Patched FIX ${id} "${name}" @ addr ${addr}`,'ok');
    return;
  }
  logHistory('!','PATCH: use FIX <id> ADDR/NAME/MODE  or  ADD <name> ADDR <n>','err');
}

// ─── BITMAP ───────────────────────────────────────────────────────────────────
// BITMAP STORE <name>           — store current fixture colors as a bitmap
// BITMAP RECALL <name>          — recall bitmap to selected fixtures
// BITMAP LIST                   — list stored bitmaps
function handleBitmap(parts, raw) {
  const sub=parts[1]?.toUpperCase();
  if(sub==='STORE'){
    const name=parts[2]||('BMP'+(Object.keys(state.bitmaps).length+1));
    const data={};
    state.fixtures.forEach(f=>{data[f.id]={red:f.red??255,green:f.green??255,blue:f.blue??255,dimmer:f.dimmer??0};});
    state.bitmaps[name]={fixtures:data,projector:state.bitmapProjector?{...state.bitmapProjector}:null};
    logHistory('>',raw,'ok');logHistory('·',`BITMAP "${name}" stored (${Object.keys(data).length} fixtures)`,'ok');
    return;
  }
  if(sub==='RECALL'){
    const name=parts[2]; if(!name||!state.bitmaps[name]){logHistory('!',`Bitmap "${name}" not found. Use BITMAP LIST.`,'err');return;}
    const bmp=state.bitmaps[name];
    // If bitmap has a projector + stored image, re-project onto current fixture positions
    if(bmp.projector&&bmp.projector.imageData){
      applyBitmapProjection(bmp.projector,bmp.projector.imageData);
    } else {
      // Fallback: direct fixture data recall
      const data=bmp.fixtures||bmp; // legacy support
      const targets=[...state.selected].length?[...state.selected]:Object.keys(data).map(Number);
      targets.forEach((id,i)=>{
        const f=state.fixtures.find(x=>x.id===id); if(!f) return;
        const src=Object.values(data)[i%Object.values(data).length];
        if(src){f.red=src.red;f.green=src.green;f.blue=src.blue;f.dimmer=src.dimmer;}
      });
    }
    renderFixtures();drawIfVisible();
    logHistory('>',raw,'ok');logHistory('·',`BITMAP "${name}" recalled`,'ok');
    return;
  }
  if(sub==='PROJECTOR'){
    openBitmapProjector();
    logHistory('>',raw,'ok');logHistory('·','Bitmap projector opened — resize/move screen over fixtures','info');
    return;
  }
  if(sub==='LIST'){
    const keys=Object.keys(state.bitmaps);
    if(!keys.length){logHistory('·','No bitmaps stored','info');return;}
    keys.forEach(k=>{const b=state.bitmaps[k];logHistory('·',`BITMAP "${k}" — ${Object.keys(b.fixtures||b).length} fixtures${b.projector?' [projector]':''}`,'info');});
    return;
  }
  if(sub==='DELETE'){
    const name=parts[2];
    if(name&&state.bitmaps[name]){delete state.bitmaps[name];logHistory('>',raw,'ok');logHistory('·',`BITMAP "${name}" deleted`,'ok');}
    else logHistory('!',`Bitmap "${name}" not found`,'err');
    return;
  }
  logHistory('!','BITMAP: STORE <name> | RECALL <name> | PROJECTOR | LIST | DELETE <name>','err');
}

// ─── BITMAP PROJECTOR — 3D screen you resize/drag over fixtures ───────────────
// state.bitmapProjector = {x, z, w, d, rotY, imageData(base64), _img}
function openBitmapProjector(){
  if(!state.bitmapProjector) state.bitmapProjector={x:0,z:0,w:800,d:600,rotY:0,imageData:null};
  const ov=document.getElementById('bitmap-projector-overlay');
  if(ov) ov.style.display='flex';
  bmpProjRender();
}
function closeBitmapProjector(){
  const ov=document.getElementById('bitmap-projector-overlay');
  if(ov) ov.style.display='none';
}
function bmpProjLoadImage(input){
  const file=input.files[0]; if(!file) return;
  const isVideo=file.type.startsWith('video/');
  state.bitmapProjector=state.bitmapProjector||{x:0,z:0,w:800,d:600,rotY:0};

  if(isVideo){
    // Stop any existing video
    if(state.bitmapProjector._video){
      state.bitmapProjector._video.pause();
      URL.revokeObjectURL(state.bitmapProjector._video.src);
    }
    const video=document.createElement('video');
    video.src=URL.createObjectURL(file);
    video.loop=true; video.muted=true; video.playsInline=true;
    video.autoplay=true;
    video.style.display='none';
    document.body.appendChild(video);
    video.play().catch(()=>{});
    state.bitmapProjector._video=video;
    state.bitmapProjector._img=null;
    state.bitmapProjector.imageData=null;
    state.bitmapProjector._isVideo=true;
    logHistory('·',`Bitmap projector: video loaded "${file.name}" — playback live`,'ok');
    // Start live frame loop
    if(state.bitmapProjector._frameLoop) cancelAnimationFrame(state.bitmapProjector._frameLoop);
    const frameLoop=()=>{
      if(!state.bitmapProjector._video) return;
      bmpProjRender();
      state.bitmapProjector._frameLoop=requestAnimationFrame(frameLoop);
    };
    frameLoop();
  } else {
    // Stop video if switching back to image
    if(state.bitmapProjector._video){
      state.bitmapProjector._video.pause();
      URL.revokeObjectURL(state.bitmapProjector._video.src);
      document.body.removeChild(state.bitmapProjector._video);
      state.bitmapProjector._video=null;
    }
    if(state.bitmapProjector._frameLoop){ cancelAnimationFrame(state.bitmapProjector._frameLoop); state.bitmapProjector._frameLoop=null; }
    state.bitmapProjector._isVideo=false;
    const reader=new FileReader();
    reader.onload=e=>{
      state.bitmapProjector.imageData=e.target.result;
      const img=new Image(); img.src=e.target.result;
      img.onload=()=>{state.bitmapProjector._img=img; bmpProjApply(); bmpProjRender();};
    };
    reader.readAsDataURL(file);
  }
}
function bmpProjApply(){
  const proj=state.bitmapProjector;
  if(!proj) return;
  if(proj._isVideo&&proj._video){
    applyBitmapProjection(proj,null);
    renderFixtures();drawIfVisible();
    logHistory('·',`Projector applied from video frame`,'ok');
  } else if(proj.imageData){
    applyBitmapProjection(proj,proj.imageData);
    renderFixtures();drawIfVisible();
    logHistory('·',`Projector applied to ${state.fixtures.length} fixtures`,'ok');
  } else {
    logHistory('!','Load an image or video first','err');
  }
}
function applyBitmapProjection(proj,imgData){
  const canvas=document.createElement('canvas');canvas.width=256;canvas.height=256;
  const ctx=canvas.getContext('2d');
  if(proj._isVideo&&proj._video&&proj._video.readyState>=2){
    ctx.drawImage(proj._video,0,0,256,256);
  } else if(imgData){
    const img=new Image(); img.src=imgData;
    ctx.drawImage(img,0,0,256,256);
  } else return;
  const px=proj.x,pz=proj.z,pw=proj.w,pd=proj.d;
  state.fixtures.forEach(f=>{
    const fx=f.stageX??0,fz=f.stageZ??0;
    const u=(fx-px+pw/2)/pw;
    const v=(fz-pz+pd/2)/pd;
    if(u<0||u>1||v<0||v>1) return;
    const sx=Math.floor(u*255),sy=Math.floor(v*255);
    const d=ctx.getImageData(sx,sy,1,1).data;
    f.red=d[0];f.green=d[1];f.blue=d[2];
    if(d[3]>0) f.dimmer=Math.min(255,Math.round((d[0]*0.299+d[1]*0.587+d[2]*0.114)));
  });
}
function bmpToggleLive(btn){
  if(!state.bitmapProjector) return;
  state.bitmapProjector._liveApply=!state.bitmapProjector._liveApply;
  const on=state.bitmapProjector._liveApply;
  if(btn){btn.textContent=on?'Live ON':'Live OFF';btn.style.background=on?'var(--accent3)':'var(--bg3)';btn.style.color=on?'#000':'var(--text2)';btn.style.borderColor=on?'var(--accent3)':'var(--border2)';}
  logHistory('·',`Bitmap projector live mode: ${on?'ON':'OFF'}`,'info');
}
function bmpProjUpdate(){
  if(!state.bitmapProjector) return;
  state.bitmapProjector.x=parseFloat(document.getElementById('bmp-x')?.value||0);
  state.bitmapProjector.z=parseFloat(document.getElementById('bmp-z')?.value||0);
  state.bitmapProjector.w=parseFloat(document.getElementById('bmp-w')?.value||800);
  state.bitmapProjector.d=parseFloat(document.getElementById('bmp-d')?.value||600);
  bmpProjRender();
}
function bmpProjRender(){
  // Show a top-down preview of the projector screen over the stage floor
  const canvas=document.getElementById('bmp-preview-canvas'); if(!canvas) return;
  const ctx=canvas.getContext('2d');
  const W=canvas.width=canvas.offsetWidth||400,H=canvas.height=canvas.offsetHeight||260;
  ctx.fillStyle='#0c0e12'; ctx.fillRect(0,0,W,H);
  // Stage floor grid
  ctx.strokeStyle='#1e2535'; ctx.lineWidth=1;
  const scale=Math.min(W,H)/1800;
  const ox=W/2,oy=H/2;
  for(let i=-5;i<=5;i++){ctx.beginPath();ctx.moveTo(ox+i*200*scale,0);ctx.lineTo(ox+i*200*scale,H);ctx.stroke();ctx.beginPath();ctx.moveTo(0,oy+i*200*scale);ctx.lineTo(W,oy+i*200*scale);ctx.stroke();}
  // Draw fixtures as dots
  state.fixtures.forEach(f=>{
    const fx=(f.stageX??0)*scale+ox,fz=(f.stageZ??0)*scale+oy;
    const r=f.red??255,g=f.green??255,b=f.blue??255,d=(f.dimmer??0)/255;
    ctx.beginPath();ctx.arc(fx,fz,5,0,Math.PI*2);
    ctx.fillStyle=`rgb(${Math.round(r*d)},${Math.round(g*d)},${Math.round(b*d)})`;ctx.fill();
    ctx.strokeStyle='#283040';ctx.lineWidth=1;ctx.stroke();
  });
  // Draw projector image/video
  const proj=state.bitmapProjector||{x:0,z:0,w:800,d:600};
  const px=proj.x*scale+ox,pz=proj.z*scale+oy,pw=proj.w*scale,pd=proj.d*scale;
  if(proj._isVideo&&proj._video&&proj._video.readyState>=2){
    ctx.save();ctx.globalAlpha=0.65;
    ctx.drawImage(proj._video,px-pw/2,pz-pd/2,pw,pd);
    ctx.restore();
    // Live mode: continuously apply video frames to fixtures
    if(proj._liveApply) applyBitmapProjection(proj,null);
  } else if(proj.imageData&&proj._img){
    ctx.save();ctx.globalAlpha=0.55;
    ctx.drawImage(proj._img,px-pw/2,pz-pd/2,pw,pd);
    ctx.restore();
  }
  ctx.strokeStyle='#4a9eff';ctx.lineWidth=2;ctx.setLineDash([5,3]);
  ctx.strokeRect(px-pw/2,pz-pd/2,pw,pd);
  ctx.setLineDash([]);
  ctx.fillStyle='rgba(74,158,255,0.08)';ctx.fillRect(px-pw/2,pz-pd/2,pw,pd);
  ctx.fillStyle='#4a9eff';ctx.font='bold 10px monospace';ctx.textAlign='center';
  ctx.fillText('PROJECTOR SCREEN',px,pz);
  // Make canvas draggable to move projector
  canvas._dragSetup=canvas._dragSetup||setupBmpCanvasDrag(canvas,scale,ox,oy);
}
function setupBmpCanvasDrag(canvas,scale,ox,oy){
  let drag=false,edge=null,sx=0,sz=0,startProj=null;
  const getPos=e=>{const r=canvas.getBoundingClientRect();return {mx:e.clientX-r.left,mz:e.clientY-r.top};};
  const getEdge=(mx,mz)=>{
    const proj=state.bitmapProjector||{x:0,z:0,w:800,d:600};
    const px=proj.x*scale+ox,pz=proj.z*scale+oy,pw=proj.w*scale/2,pd=proj.d*scale/2;
    const nearR=Math.abs(mx-(px+pw))<10,nearL=Math.abs(mx-(px-pw))<10;
    const nearB=Math.abs(mz-(pz+pd))<10,nearT=Math.abs(mz-(pz-pd))<10;
    if(nearR&&nearB)return'SE';if(nearL&&nearT)return'NW';if(nearR)return'E';if(nearL)return'W';if(nearB)return'S';if(nearT)return'N';
    if(mx>px-pw&&mx<px+pw&&mz>pz-pd&&mz<pz+pd)return'move';
    return null;
  };
  canvas.addEventListener('mousedown',e=>{
    const {mx,mz}=getPos(e);edge=getEdge(mx,mz);
    if(!edge)return;drag=true;sx=mx;sz=mz;
    startProj={...state.bitmapProjector};e.preventDefault();
  });
  canvas.addEventListener('mousemove',e=>{
    const {mx,mz}=getPos(e);
    if(!drag){const ed=getEdge(mx,mz);canvas.style.cursor=ed?({move:'grab',E:'ew-resize',W:'ew-resize',N:'ns-resize',S:'ns-resize',SE:'nwse-resize',NW:'nwse-resize'}[ed]||'crosshair'):'default';}
    else{
      const dx=(mx-sx)/scale,dz=(mz-sz)/scale;
      const p=state.bitmapProjector;
      if(edge==='move'){p.x=startProj.x+dx;p.z=startProj.z+dz;}
      else if(edge==='E'){p.w=Math.max(50,startProj.w+dx*2);}
      else if(edge==='W'){p.w=Math.max(50,startProj.w-dx*2);}
      else if(edge==='S'){p.d=Math.max(50,startProj.d+dz*2);}
      else if(edge==='N'){p.d=Math.max(50,startProj.d-dz*2);}
      else if(edge==='SE'){p.w=Math.max(50,startProj.w+dx*2);p.d=Math.max(50,startProj.d+dz*2);}
      else if(edge==='NW'){p.w=Math.max(50,startProj.w-dx*2);p.d=Math.max(50,startProj.d-dz*2);}
      // Sync input fields
      const bx=document.getElementById('bmp-x'),bz=document.getElementById('bmp-z');
      const bw=document.getElementById('bmp-w'),bd=document.getElementById('bmp-d');
      if(bx)bx.value=Math.round(p.x);if(bz)bz.value=Math.round(p.z);
      if(bw)bw.value=Math.round(p.w);if(bd)bd.value=Math.round(p.d);
      bmpProjRender();
    }
  });
  canvas.addEventListener('mouseup',()=>{drag=false;});
  canvas.addEventListener('mouseleave',()=>{drag=false;});
  return true;
}

// ─── DELETE ───────────────────────────────────────────────────────────────────
function handleDelete(parts, raw) {
  if(parts.length<2){logHistory('!','DELETE: missing target','err');return;}
  const target=parts[1].toUpperCase();
  if(target.startsWith('CUE')){
    const num=target.split('.')[1]; if(!num){logHistory('!','DELETE CUE.<n>','err');return;}
    const before=state.cues.length;state.cues=state.cues.filter(c=>c.num!==num);
    if(state.cues.length<before){if(state.currentCue>=state.cues.length)state.currentCue=state.cues.length-1;renderCues();logHistory('>',raw,'ok');}
    else logHistory('!',`CUE ${num} not found`,'err');return;
  }
  if(target.startsWith('PRESET')){
    const sub=target.split('.'),ptype=sub[1],pnum=sub[2]; if(!ptype||!pnum){logHistory('!','DELETE PRESET.TYPE.N','err');return;}
    state.presets=state.presets.filter(p=>!(p.type===ptype&&p.num===pnum));renderPresets();logHistory('>',raw,'ok');return;
  }
  if(target.startsWith('FIX')){
    const num=target.split('.')[1]||parts[2]; if(!num){logHistory('!','DELETE FIX.<n>','err');return;}
    expandFixSpec(num).forEach(id=>{state.fixtures=state.fixtures.filter(f=>f.id!==id);state.patchData=state.patchData.filter(p=>p.id!==id);state.selected.delete(id);});
    renderAll();logHistory('>',raw,'ok');return;
  }
  if(target.startsWith('FADER')){
    const idx=parseInt(target.split('.')[1]||parts[2])-1;
    if(idx>=0&&idx<state.faders.length){state.faders.splice(idx,1);renderFaders();logHistory('>',raw,'ok');}
    else logHistory('!','Fader not found','err');return;
  }
  if(target.startsWith('LINK')){const num=parseInt(target.split('.')[1]);if(!isNaN(num)&&num>=1&&num<=state.links.length){state.links.splice(num-1,1);renderLinks();logHistory('>',raw,'ok');}else logHistory('!','Link not found','err');return;}
  if(target.startsWith('TIMELINE')){const name=target.split('.')[1]||parts[2];if(name&&state.timelines[name]){delete state.timelines[name];logHistory('>',raw,'ok');}else logHistory('!',`Timeline "${name}" not found`,'err');return;}
  if(target.startsWith('GROUP')){const name=parts.slice(2).join(' ');if(name&&state.groups[name]){delete state.groups[name];logHistory('>',raw,'ok');}else logHistory('!',`Group "${name}" not found`,'err');return;}
  logHistory('!',`DELETE: unknown target "${target}"  use CUE/PRESET/FIX/FADER/LINK/TIMELINE/GROUP`,'err');
}

// ─── SET / FADE ───────────────────────────────────────────────────────────────
function handleSetFade(parts, action, raw) {
  if(parts.length<3){logHistory('!',`Usage: ${action} FIX <id> [param] <value>`,'err');return;}
  const target=parts[1].toUpperCase();

  // Support: SET SEL <param> <val>  or  SET ALL <param> <val>
  if(target==='SEL'||target==='ALL'){
    const paramStr=parts[2].toLowerCase(),valStr=parts[3];
    const val=parseInt(valStr);if(isNaN(val)){logHistory('!',`Bad value: "${valStr}"`,'err');return;}
    const ids=target==='ALL'?state.fixtures.map(f=>f.id):[...state.selected];
    if(!ids.length){logHistory('!','No fixtures selected','err');return;}
    const param=paramStr;
    if(!PARAMS.includes(param)){logHistory('!',`Unknown param "${param}"  valid: ${PARAMS.slice(0,8).join(', ')}…`,'err');return;}
    ids.forEach(id=>{programmer[id]=programmer[id]||{};programmer[id][param]=val;});
    if(action==='FADE'){
      const fadeMs=parseInt(parts[4])||2000;
      fadeFixtureParam(ids,param,val,fadeMs);
    } else {
      ids.forEach(id=>{const f=state.fixtures.find(x=>x.id===id);if(f&&param in f)f[param]=val;});
      renderFixtures();drawIfVisible();
    }
    logHistory('>',raw,'ok');logHistory('·',`${action} [${target}:${ids.length}f] .${param} → ${val}`,'ok');
    const pp=document.getElementById('prog-param'),pv=document.getElementById('prog-val');
    if(pp){pp.textContent=`${param}(${Object.keys(programmer).length})`;pp.style.color='var(--accent)';}
    if(pv)pv.textContent=String(val);
    return;
  }

  if(target==='FIX'){
    let fixSpec=parts[2],paramPart=null,valStr;
    if(fixSpec.includes('.')){const sp=fixSpec.split('.');fixSpec=sp[0];paramPart=sp.slice(1).join('.').toLowerCase();valStr=parts[3];}
    else if(parts.length>=5&&PARAMS.includes(parts[3].toLowerCase())){paramPart=parts[3].toLowerCase();valStr=parts[4];}
    else valStr=parts[3];
    const val=parseInt(valStr); if(isNaN(val)){logHistory('!',`Bad value: "${valStr}"`,'err');return;}
    const ids=expandFixSpec(fixSpec,state.selected),param=paramPart||'dimmer';
    if(!PARAMS.includes(param)){logHistory('!',`Unknown param "${param}"  valid: ${PARAMS.slice(0,8).join(', ')}…`,'err');return;}
    if(!ids.length){logHistory('!','No fixtures matched — select fixtures or specify IDs','err');return;}
    ids.forEach(id=>{programmer[id]=programmer[id]||{};programmer[id][param]=val;});
    if(action==='FADE'){
      const hasTime=paramPart?parts.length>=6:parts.length>=5,timeArg=hasTime?parseInt(parts[parts.length-1]):2000;
      fadeFixtureParam(ids,param,val,isNaN(timeArg)?2000:timeArg);
    } else {
      ids.forEach(id=>{const f=state.fixtures.find(x=>x.id===id);if(f&&param in f)f[param]=val;});
      renderFixtures();drawIfVisible();
    }
    logHistory('>',raw,'ok');logHistory('·',`${action} [${ids.join(',')}] .${param} → ${val}${action==='FADE'?' (fading)':''}`,'ok');
    const pp=document.getElementById('prog-param'),pv=document.getElementById('prog-val');
    if(pp){pp.textContent=`${param}(${Object.keys(programmer).length})`;pp.style.color='var(--accent)';}
    if(pv)pv.textContent=String(val);
    return;
  }
  logHistory('!',`Expected FIX, SEL, or ALL after ${action}`,'err');
}

// ─── STORE ────────────────────────────────────────────────────────────────────
function handleStore(parts, raw) {
  if(parts.length<2){logHistory('!','STORE: missing target','err');return;}
  const fullTarget=parts[1].toUpperCase(),name=parts.slice(2).join(' ');
  if(fullTarget.startsWith('CUE')){
    const num=fullTarget.split('.')[1]||String(state.cues.length+1);
    const fade=parseInt(document.getElementById('s-fadetime')?.value||'2000')||2000;
    const snapshot={};Object.entries(programmer).forEach(([id,params])=>{snapshot[parseInt(id)]={...params};});
    const cueName=name||`Cue ${num}`,existing=state.cues.findIndex(c=>c.num===String(num));
    const cue={num:String(num),name:cueName,fade,delay:0,mib:false,snapshot};
    if(existing>=0)state.cues[existing]=cue;else state.cues.push(cue);
    renderCues();logHistory('>',raw,'ok');logHistory('·',`CUE ${num} "${cueName}" stored — ${Object.keys(snapshot).length}f  (double-click to edit code)`,'ok');
    // Open code editor so user can review/tweak
    const idx=state.cues.findIndex(c=>c.num===String(num));
    if(idx>=0) setTimeout(()=>openCueCodeEditor(idx),80);
  } else if(fullTarget.startsWith('PRESET')){
    const sub=fullTarget.split('.'),ptype=sub[1]||'INT',pnum=sub[2]||String(state.presets.length+1);
    const snapshot={};Object.entries(programmer).forEach(([id,params])=>{snapshot[parseInt(id)]={...params};});
    state.presets.push({type:ptype,num:pnum,name:name||ptype+'.'+pnum,snapshot});
    renderPresets();logHistory('>',raw,'ok');logHistory('·',`PRESET ${ptype}.${pnum} stored  (double-click to edit code)`,'ok');
    // Open code editor so user can review/tweak
    const pidx=state.presets.length-1;
    setTimeout(()=>openPresetCodeEditor(pidx),80);
  } else if(fullTarget.startsWith('FADER')){
    const idx=parseInt(fullTarget.split('.')[1]||'1')-1;
    if(idx>=0&&idx<state.faders.length){
      if(name)state.faders[idx].name=name;
      // Assign selected fixtures to this fader
      if(state.selected.size>0){
        state.faders[idx].fixtures=[...state.selected];
        state.faders[idx].param=parts[2]?.toLowerCase()||'dimmer';
        logHistory('·',`FADER ${idx+1} assigned to ${state.faders[idx].fixtures.length} fixtures (.${state.faders[idx].param})`,'ok');
      }
      renderFaders();logHistory('>',raw,'ok');
    } else logHistory('!',`Fader out of range`,'err');
  } else if(fullTarget.startsWith('GROUP')){
    const gname=name||('Group '+(Object.keys(state.groups).length+1));
    state.groups[gname]=[...state.selected];
    logHistory('>',raw,'ok');logHistory('·',`GROUP "${gname}" stored (${state.groups[gname].length} fixtures)`,'ok');
  } else logHistory('!','STORE: use CUE / PRESET / FADER / GROUP','err');
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function expandFixSpec(spec, selSet) {
  if(!spec||spec.toLowerCase()==='sel') return selSet?[...selSet]:[];
  const ids=[];
  spec.split(',').forEach(part=>{if(part.includes('-')){const[a,b]=part.split('-').map(Number);for(let i=a;i<=b;i++)ids.push(i);}else{const n=parseInt(part);if(!isNaN(n))ids.push(n);}});
  return ids;
}

// ─── INPUT ────────────────────────────────────────────────────────────────────
function setupInput() {
  const INPUT=document.getElementById('cmd-input');
  INPUT.addEventListener('keydown',e=>{
    if(e.key==='Enter'){
      if(e.shiftKey){mlOpen('EFFECT',INPUT.value.trim());INPUT.value='';hideAC();e.preventDefault();return;}
      const val=INPUT.value.trim();
      if(val){state.cmdHistory.unshift(val);state.histIdx=-1;parseCommand(val);}
      INPUT.value='';hideAC();e.preventDefault();
    } else if(e.key==='ArrowUp'){state.histIdx=Math.min(state.histIdx+1,state.cmdHistory.length-1);INPUT.value=state.cmdHistory[state.histIdx]||'';e.preventDefault();}
    else if(e.key==='ArrowDown'){state.histIdx=Math.max(state.histIdx-1,-1);INPUT.value=state.histIdx>=0?state.cmdHistory[state.histIdx]:'';e.preventDefault();}
    else if(e.key==='Tab'){e.preventDefault();const sel=document.querySelector('.ac-item.selected');if(sel){INPUT.value=sel.dataset.val+' ';INPUT.focus();hideAC();}}
    else if(e.key==='Escape'){INPUT.value='';hideAC();}
  });
  INPUT.addEventListener('input',()=>updateAC(INPUT.value.trim().toUpperCase()));

  // Global hotkeys when command line is NOT focused
  document.addEventListener('keydown',e=>{
    if(document.activeElement===INPUT) return; // let input handle its own keys
    if(document.activeElement?.tagName==='INPUT'||document.activeElement?.tagName==='TEXTAREA'||document.activeElement?.tagName==='SELECT') return;
    // E = Sneak (fade programmer values to output)
    if(e.key==='e'||e.key==='E'){
      if(!e.ctrlKey&&!e.metaKey&&!e.altKey){
        e.preventDefault();
        parseCommand('SNEAK 2000');
      }
    }
    // Space = GO
    if(e.key===' '&&!e.ctrlKey&&!e.metaKey){
      e.preventDefault();
      goCue();
    }
  });
}

// ─── AUTOCOMPLETE ──────────────────────────────────────────────────────────────
const KEYWORDS=['SET','FADE','SNEAK','EFFECT','RECALL','STORE','DELETE','TIMELINE','HELP','PATCH','BITMAP','CLEAR','SELECT'];
function updateAC(v) {
  const el=document.getElementById('autocomplete'); if(!v){hideAC();return;}
  const words=v.split(/\s+/),first=words[0];
  const suggestions=[];
  if(words.length===1){
    const descs={SET:'snap param',FADE:'fade over ms',SNEAK:'fade programmer to output',EFFECT:'waveform effect',RECALL:'recall preset/cue/timeline',STORE:'record cue/preset/fader/group',DELETE:'delete object',TIMELINE:'timeline editor',HELP:'reference',PATCH:'patch from command line',BITMAP:'store/recall colour snapshots',CLEAR:'clear programmer',SELECT:'select group'};
    KEYWORDS.filter(k=>k.startsWith(first)).forEach(k=>suggestions.push({val:k,kw:k,desc:descs[k]||''}));
  } else if(['SET','FADE'].includes(first)&&words.length===2){
    ['FIX'].filter(k=>k.startsWith(words[1])).forEach(k=>suggestions.push({val:first+' '+k,kw:k,desc:'by fixture id'}));
  } else if(['SET','FADE'].includes(first)&&words[1]==='FIX'&&words.length>=4){
    const last=words[words.length-1];PARAMS.filter(p=>p.toUpperCase().startsWith(last)).forEach(p=>suggestions.push({val:words.slice(0,-1).join(' ')+' '+p.toUpperCase(),kw:p,desc:'param'}));
  } else if(first==='RECALL'&&words.length===2){
    ['PRESET','CUE','TIMELINE'].filter(k=>k.startsWith(words[1])).forEach(k=>suggestions.push({val:'RECALL '+k+' ',kw:k,desc:'recall '+k.toLowerCase()}));
  } else if(first==='SNEAK'&&words.length===2){
    ['500','1000','2000','3000'].filter(k=>k.startsWith(words[1])).forEach(k=>suggestions.push({val:'SNEAK '+k,kw:k+'ms',desc:'fade time'}));
  } else if(first==='STORE'&&words.length===2){
    ['CUE','PRESET','FADER','GROUP'].filter(k=>k.startsWith(words[1])).forEach(k=>suggestions.push({val:'STORE '+k+'.',kw:k,desc:'record to '+k.toLowerCase()}));
  } else if((first==='DELETE'||first==='DEL')&&words.length===2){
    ['CUE','PRESET','FIX','FADER','LINK','TIMELINE','GROUP'].filter(k=>k.startsWith(words[1])).forEach(k=>suggestions.push({val:first+' '+k+'.',kw:k,desc:'delete'}));
  } else if(first==='PATCH'&&words.length===2){
    ['FIX','ADD'].filter(k=>k.startsWith(words[1])).forEach(k=>suggestions.push({val:'PATCH '+k,kw:k,desc:k==='FIX'?'edit existing':'add new'}));
  } else if(first==='BITMAP'&&words.length===2){
    ['STORE','RECALL','LIST','DELETE'].filter(k=>k.startsWith(words[1])).forEach(k=>suggestions.push({val:'BITMAP '+k,kw:k,desc:''}));
  } else if(first==='SELECT'&&words.length===2){
    suggestions.push({val:'SELECT GROUP ',kw:'GROUP',desc:'select named group'});
  }
  if(!suggestions.length){hideAC();return;}
  el.style.display='block';el.innerHTML='';
  suggestions.forEach((s,i)=>{const item=document.createElement('div');item.className='ac-item'+(i===0?' selected':'');item.dataset.val=s.val;item.innerHTML=`<span class="ac-keyword">${s.kw}</span><span class="ac-desc">${s.desc}</span>`;item.onclick=()=>{document.getElementById('cmd-input').value=s.val+' ';document.getElementById('cmd-input').focus();hideAC();};el.appendChild(item);});
  const rect=document.getElementById('cmd-line').getBoundingClientRect();el.style.left=(rect.left+40)+'px';el.style.bottom=(window.innerHeight-rect.top)+'px';
}
function hideAC() { document.getElementById('autocomplete').style.display='none'; }

// ─── TABS ─────────────────────────────────────────────────────────────────────
function switchTab(tab) {
  const tabNames=['live','patching','links','timelines','viz3d','settings','ai'];
  const panels={live:'live-panel',patching:'patch-panel',links:'links-panel',timelines:'timelines-panel',viz3d:'viz3d-panel',settings:'settings-panel',ai:'ai-panel'};
  document.querySelectorAll('.tab').forEach((t,i)=>t.classList.toggle('active',tabNames[i]===tab));
  Object.entries(panels).forEach(([name,id])=>{const el=document.getElementById(id);if(el)el.style.display=name===tab?'flex':'none';});

  if(tab==='live'){
    // Refresh panel content after becoming visible (canvas needs dimensions, grids need re-fill)
    requestAnimationFrame(()=>{
      // Re-fill all data-bound panels without full rebuild
      document.querySelectorAll('[data-panel-type="fixture-grid"]').forEach(el=>fillFixtureGrid(el));
      document.querySelectorAll('[data-panel-type="cuelist-content"]').forEach(el=>fillCuelist(el));
      document.querySelectorAll('[data-panel-type="presets-content"]').forEach(el=>fillPresets(el));
      document.querySelectorAll('[data-panel-type="groups-content"]').forEach(el=>fillGroupsPanel(el));
      // 3D canvas: re-attach and resize (was 0×0 while hidden)
      const c3d=document.querySelector('.panel-canvas3d');
      if(c3d){state.viz3d.canvas=c3d;state.viz3d.ctx=c3d.getContext('2d');setTimeout(()=>{resizeCanvas();draw3D();},16);}
      // Faders: rebuild drag handlers (they reference DOM nodes that may have been cloned)
      cleanupFaderDrag(); attachFaderDrag();
      // Timeline embed
      _tlEmbedRefresh();
    });
  }
  if(tab==='links')renderLinks();
  if(tab==='patching')renderPatch();
  if(tab==='timelines'){tcRenderList();setTimeout(tcRenderRuler,50);}
  if(tab==='viz3d'){const c=document.getElementById('canvas3d');if(c){state.viz3d.canvas=c;state.viz3d.ctx=c.getContext('2d');setTimeout(()=>{resizeCanvas();draw3D();},10);}}
  if(tab==='ai'){
    const urlInput=document.getElementById('ai-ollama-url-input');
    const modelInput=document.getElementById('ai-ollama-model-input');
    if(urlInput&&!urlInput.value) urlInput.value=aiGetOllamaUrl();
    if(modelInput&&!modelInput.value) modelInput.value=aiGetOllamaModel();
    aiCheckOllama(true);
    setTimeout(()=>document.getElementById('ai-input-full')?.focus(),100);
  }
  if(tab==='settings'){
    const urlInput=document.getElementById('ai-ollama-url-input');
    const modelInput=document.getElementById('ai-ollama-model-input');
    if(urlInput&&!urlInput.value) urlInput.value=aiGetOllamaUrl();
    if(modelInput&&!modelInput.value) modelInput.value=aiGetOllamaModel();
    updateRemoteUI();
  }
}

// AI full-panel send — mirrors aiSend but uses the full-panel elements
// ── Shared Ollama fetch ──────────────────────────────────────────────────────
// ── Unified AI call — routes to Anthropic (via secure IPC) or Ollama ─────────
async function aiCall(text, onChunk) {
  // Always check for a saved key - fixes race condition where backend state may not be set yet
  if (window.electronAPI?.aiChat) {
    // Refresh key status if we don't think we have one
    if (!aiState.hasKey && window.electronAPI.aiHasKey) {
      try {
        const r = await window.electronAPI.aiHasKey();
        if (r.hasKey) { aiState.hasKey=true; aiState.backend='cloud'; aiState.provider=r.provider||'gemini'; aiUpdateBackendUI(); }
      } catch(_) {}
    }
    if (aiState.hasKey) {
      const result = await window.electronAPI.aiChat({
        systemPrompt: aiGetSystemPrompt(),
        messages: [...aiState.history, {role:'user', content:text}],
      });
      if (!result.ok) {
        if (result.error==='no_key') { aiState.hasKey=false; aiState.backend='ollama'; aiUpdateBackendUI(); throw new Error('No API key saved. Add your key in Settings → AI Agent.'); }
        throw new Error(result.error);
      }
      onChunk(result.text);
      return result.text;
    }
  }
  return aiCallOllama(text, onChunk);
}

async function aiCallOllama(text, onChunk) {
  const url=aiGetOllamaUrl(), model=aiGetOllamaModel();
  const messages=[{role:'system',content:aiGetSystemPrompt()},...aiState.history,{role:'user',content:text}];
  const resp=await fetch(`${url}/api/chat`,{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({model,messages,stream:true}),
  });
  if(!resp.ok) throw new Error(`Ollama ${resp.status}: ${resp.statusText}. Is Ollama running at ${url}?`);
  const reader=resp.body.getReader(),dec=new TextDecoder();
  let buf='',fullText='';
  while(true){
    const{done,value}=await reader.read(); if(done) break;
    buf+=dec.decode(value,{stream:true});
    const lines=buf.split('\n'); buf=lines.pop();
    for(const line of lines){
      if(!line.trim()) continue;
      try{const ev=JSON.parse(line);const chunk=ev.message?.content||'';if(chunk){fullText+=chunk;onChunk(fullText);}}catch(_){}
    }
  }
  return fullText;
}

async function aiSendFull(){
  const ta=document.getElementById('ai-input-full'); if(!ta) return;
  const text=ta.value.trim(); if(!text||aiState.streaming) return;
  ta.value='';
  _aiAppendToFullLog('user', text);
  const sendBtn=document.getElementById('ai-send-full-btn');
  if(sendBtn){sendBtn.disabled=true;sendBtn.style.opacity='0.4';}
  aiState.streaming=true;
  const typingDiv=document.createElement('div');
  typingDiv.style.cssText='display:flex;gap:6px;padding:4px 0;align-items:center';
  typingDiv.innerHTML='<div style="width:28px;height:28px;background:linear-gradient(135deg,#6030c0,#3010a0);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;flex-shrink:0">✦</div><span style="font-family:var(--ui);font-size:10px;color:var(--text2)">Thinking via '+(aiState.backend==='cloud'&&aiState.hasKey?(AI_PROVIDERS[aiState.provider]?.label||aiState.provider):'Ollama ('+aiGetOllamaModel()+')')+'…</span>';
  const fullLog=document.getElementById('ai-log-full');
  if(fullLog){fullLog.appendChild(typingDiv);fullLog.scrollTop=fullLog.scrollHeight;}
  try{
    aiState.history.push({role:'user',content:text});
    const bubble=_aiAppendToFullLog('assistant','',true);
    typingDiv.remove();
    const fullText=await aiCall(text,(txt)=>{
      if(bubble)bubble.innerHTML=aiRenderContent(txt);
      if(fullLog)fullLog.scrollTop=fullLog.scrollHeight;
    });
    if(bubble)bubble.id='';
    aiState.history.push({role:'assistant',content:fullText});
    if(aiState.autoExecute){
      const codeBlocks=[...fullText.matchAll(/```lightscript\n?([\s\S]*?)```/g)];
      if(codeBlocks.length){let total=0;codeBlocks.forEach(m=>{const lines=m[1].trim().split('\n').filter(l=>l.trim()&&!l.trim().startsWith('//'));lines.forEach(cmd=>{try{parseCommand(cmd.trim());}catch(e){}total++;});});if(total)logHistory('·',`AI ran ${total} command${total>1?'s':''}`, 'ok');}
    }
  }catch(err){
    try{typingDiv.remove();}catch(_){}
    const isCloud=aiState.backend==='cloud'&&aiState.hasKey;
    const prov=isCloud?(AI_PROVIDERS[aiState.provider]?.label||aiState.provider):'Ollama';
    const hint=isCloud
      ? `Check your ${prov} API key in Settings → AI Agent.\n\nError: ${err.message}`
      : `Make sure Ollama is running:\n  ollama serve\nAnd pull a model:\n  ollama pull llama3\n\nError: ${err.message}`;
    _aiAppendToFullLog('assistant',`⚠ ${prov} error\n\n${hint}`);
  }finally{
    aiState.streaming=false;
    if(sendBtn){sendBtn.disabled=false;sendBtn.style.opacity='1';}
    document.getElementById('ai-input-full')?.focus();
  }
}

function _aiAppendToFullLog(role,content,streaming=false){
  const log=document.getElementById('ai-log-full'); if(!log) return null;
  const isUser=role==='user';
  const div=document.createElement('div');
  div.style.cssText=`display:flex;gap:8px;align-items:flex-start;${isUser?'flex-direction:row-reverse':''}`;
  const avatar=document.createElement('div');
  avatar.style.cssText=`width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:${isUser?'11px':'12px'};flex-shrink:0;background:${isUser?'var(--accent)':'linear-gradient(135deg,#6030c0,#3010a0)'};color:${isUser?'#000':'#fff'}`;
  avatar.textContent=isUser?'U':'✦';
  const bubble=document.createElement('div');
  bubble.style.cssText=`max-width:75%;padding:9px 12px;border-radius:${isUser?'12px 12px 2px 12px':'12px 12px 12px 2px'};font-family:var(--mono);font-size:10px;line-height:1.6;word-break:break-word;background:${isUser?'rgba(74,158,255,0.15)':'rgba(96,48,192,0.15)'};color:var(--text0);border:1px solid ${isUser?'rgba(74,158,255,0.3)':'rgba(144,96,224,0.3)'}`;
  if(streaming) bubble.id='ai-streaming-bubble-full';
  bubble.innerHTML=aiRenderContent(content);
  div.appendChild(avatar); div.appendChild(bubble);
  // Remove welcome message if present
  const welcome=log.querySelector('[data-ai-welcome]');
  if(welcome) welcome.remove();
  log.appendChild(div); log.scrollTop=log.scrollHeight;
  return bubble;
}

function aiQuick(text){
  const ta=document.getElementById('ai-input-full');
  if(ta){ta.value=text;aiSendFull();}
}

// ─── CODE EDITOR (CUE / PRESET) ───────────────────────────────────────────────
// Converts a snapshot {fixtureId:{param:val,...},...} to/from LightScript commands
function snapshotToCode(snapshot,fade){
  if(!snapshot||!Object.keys(snapshot).length) return '// Empty — add SET or FADE commands here\n// Example: SET FIX 1.dimmer 255\n';
  const action=fade>0?`FADE ${fade}`:'SET';
  // Group by identical param sets for compact output
  const groups={};
  Object.entries(snapshot).forEach(([id,params])=>{
    const key=JSON.stringify(Object.entries(params).sort((a,b)=>a[0].localeCompare(b[0])));
    if(!groups[key])groups[key]={ids:[],params};
    groups[key].ids.push(Number(id));
  });
  const lines=['// '+action+' snapshot — '+Object.keys(snapshot).length+' fixtures',''];
  Object.values(groups).forEach(({ids,params})=>{
    // Compress sequential IDs into ranges
    const sorted=ids.sort((a,b)=>a-b);
    const ranges=[];let start=sorted[0],end=sorted[0];
    for(let i=1;i<sorted.length;i++){
      if(sorted[i]===end+1){end=sorted[i];}
      else{ranges.push(start===end?String(start):`${start}-${end}`);start=end=sorted[i];}
    }
    ranges.push(start===end?String(start):`${start}-${end}`);
    const idStr=ranges.join(',');
    Object.entries(params).sort((a,b)=>a[0].localeCompare(b[0])).forEach(([param,val])=>{
      lines.push(`${action} FIX ${idStr}.${param} ${Math.round(val)}`);
    });
  });
  return lines.join('\n');
}

function codeToSnapshot(code){
  const snapshot={};
  code.split('\n').forEach(line=>{
    line=line.trim(); if(!line||line.startsWith('//')) return;
    // Parse: SET FIX <ids>.<param> <val>  or  FADE <ms> FIX <ids>.<param> <val>
    const m=line.match(/^(?:SET|FADE\s+\d+)\s+FIX\s+([^.\s]+)\.([a-zA-Z]+)\s+([\d.]+)/i);
    if(!m) return;
    const ids=expandFixSpec(m[1], state.selected);
    const param=m[2].toLowerCase(), val=parseFloat(m[3]);
    ids.forEach(id=>{ if(!snapshot[id])snapshot[id]={}; snapshot[id][param]=val; });
  });
  return snapshot;
}

// ── Cue Code Editor ──
let _cceIdx=null;
function openCueCodeEditor(i){
  _cceIdx=i; const c=state.cues[i];
  const ta=document.getElementById('cce-code');
  if(!ta) return;
  document.getElementById('cce-name').value=c.name||'';
  document.getElementById('cce-num').value=c.num||'';
  document.getElementById('cce-fade').value=c.fade||0;
  document.getElementById('cce-delay').value=c.delay||0;
  ta.value=snapshotToCode(c.snapshot||{}, c.fade||0);
  document.getElementById('cce-overlay').style.display='flex';
  setTimeout(()=>ta.focus(),50);
  cceUpdateGutter();
}
function closeCueCodeEditor(){document.getElementById('cce-overlay').style.display='none';_cceIdx=null;}
function saveCueCodeEditor(){
  if(_cceIdx===null) return;
  const c=state.cues[_cceIdx];
  c.name=document.getElementById('cce-name').value||c.name;
  c.num=document.getElementById('cce-num').value||c.num;
  c.fade=Math.max(0,parseInt(document.getElementById('cce-fade').value)||0);
  c.delay=Math.max(0,parseInt(document.getElementById('cce-delay').value)||0);
  c.snapshot=codeToSnapshot(document.getElementById('cce-code').value);
  logHistory('·',`CUE ${c.num} "${c.name}" updated via editor`,'ok');
  renderCues(); closeCueCodeEditor();
}
function cceUpdateGutter(){
  const ta=document.getElementById('cce-code'),g=document.getElementById('cce-gutter');
  if(!ta||!g) return;
  g.innerHTML=ta.value.split('\n').map((_,i)=>`<div>${i+1}</div>`).join('');
}
function cceSetupTA(){
  const ta=document.getElementById('cce-code'); if(!ta) return;
  ta.addEventListener('keydown',e=>{
    if(e.key==='s'&&(e.ctrlKey||e.metaKey)){e.preventDefault();saveCueCodeEditor();}
    if(e.key==='Escape'){e.preventDefault();closeCueCodeEditor();}
    if(e.key==='Tab'){e.preventDefault();const s=ta.selectionStart;ta.value=ta.value.slice(0,s)+'  '+ta.value.slice(ta.selectionEnd);ta.selectionStart=ta.selectionEnd=s+2;}
  });
  ta.addEventListener('input',cceUpdateGutter);
  ta.addEventListener('scroll',()=>{const g=document.getElementById('cce-gutter');if(g)g.scrollTop=ta.scrollTop;});
}

// ── Preset Code Editor ──
let _pceIdx=null;
function openPresetCodeEditor(i){
  _pceIdx=i; const p=state.presets[i];
  if(!p) return;
  const ta=document.getElementById('pce-code');
  if(!ta) return;
  document.getElementById('pce-name').value=p.name||'';
  document.getElementById('pce-type').value=p.type||'INT';
  document.getElementById('pce-num').value=p.num||'';
  ta.value=snapshotToCode(p.snapshot||{},0);
  document.getElementById('pce-overlay').style.display='flex';
  setTimeout(()=>ta.focus(),50);
  pceUpdateGutter();
}
function closePresetCodeEditor(){document.getElementById('pce-overlay').style.display='none';_pceIdx=null;}
function savePresetCodeEditor(){
  if(_pceIdx===null) return;
  const p=state.presets[_pceIdx];
  p.name=document.getElementById('pce-name').value||p.name;
  p.type=document.getElementById('pce-type').value||p.type;
  p.num=document.getElementById('pce-num').value||p.num;
  p.snapshot=codeToSnapshot(document.getElementById('pce-code').value);
  logHistory('·',`PRESET ${p.type}.${p.num} "${p.name}" updated`,'ok');
  renderPresets(); closePresetCodeEditor();
}
function pceUpdateGutter(){
  const ta=document.getElementById('pce-code'),g=document.getElementById('pce-gutter');
  if(!ta||!g) return;
  g.innerHTML=ta.value.split('\n').map((_,i)=>`<div>${i+1}</div>`).join('');
}
function pceSetupTA(){
  const ta=document.getElementById('pce-code'); if(!ta) return;
  ta.addEventListener('keydown',e=>{
    if(e.key==='s'&&(e.ctrlKey||e.metaKey)){e.preventDefault();savePresetCodeEditor();}
    if(e.key==='Escape'){e.preventDefault();closePresetCodeEditor();}
    if(e.key==='Tab'){e.preventDefault();const s=ta.selectionStart;ta.value=ta.value.slice(0,s)+'  '+ta.value.slice(ta.selectionEnd);ta.selectionStart=ta.selectionEnd=s+2;}
  });
  ta.addEventListener('input',pceUpdateGutter);
  ta.addEventListener('scroll',()=>{const g=document.getElementById('pce-gutter');if(g)g.scrollTop=ta.scrollTop;});
}

// ─── TIMELINE RULER ────────────────────────────────────────────────────────────
function tcRenderRuler() {
  if (!_tcSelectedName) return;
  const tl = state.timelines[_tcSelectedName]; if (!tl) return;
  const rulerCanvas = document.getElementById('tc-ruler-canvas');
  const tracksCanvas = document.getElementById('tc-tracks-canvas');
  const zoomEl = document.getElementById('tc-zoom');
  const zoomLabel = document.getElementById('tc-zoom-label');
  if (!rulerCanvas || !tracksCanvas) return;

  const zoom = parseInt(zoomEl?.value || 100); // px per second
  const pxPerMs = zoom / 1000;
  if (zoomLabel) zoomLabel.textContent = (zoom / 100).toFixed(1) + '×';

  const dur = tl.steps?.length ? Math.max(...tl.steps.map(s => s.timeMs || 0)) + 2000 : 10000;
  const totalW = Math.max(dur * pxPerMs, rulerCanvas.parentElement?.offsetWidth || 800);

  // Set canvas sizes
  rulerCanvas.width = totalW;
  rulerCanvas.height = 28;
  tracksCanvas.width = totalW;
  tracksCanvas.height = tracksCanvas.parentElement?.offsetHeight || 120;
  tracksCanvas.style.width = totalW + 'px';

  const rCtx = rulerCanvas.getContext('2d');
  const tCtx = tracksCanvas.getContext('2d');

  // ── Ruler background ──
  rCtx.fillStyle = '#161b24';
  rCtx.fillRect(0, 0, totalW, 28);

  // ── Tick marks ──
  const secW = zoom; // px per second
  const tickInterval = secW < 20 ? 10000 : secW < 60 ? 5000 : secW < 120 ? 2000 : secW < 300 ? 1000 : 500; // ms
  rCtx.font = '9px "JetBrains Mono", monospace';
  rCtx.fillStyle = '#606880';
  rCtx.strokeStyle = '#283040';
  rCtx.lineWidth = 1;
  for (let ms = 0; ms <= dur + tickInterval; ms += tickInterval) {
    const x = ms * pxPerMs;
    const isMajor = ms % (tickInterval * 5) === 0 || tickInterval >= 1000;
    rCtx.beginPath();
    rCtx.moveTo(x, isMajor ? 10 : 18);
    rCtx.lineTo(x, 28);
    rCtx.strokeStyle = isMajor ? '#405060' : '#283040';
    rCtx.stroke();
    if (isMajor) {
      rCtx.fillStyle = '#8090a0';
      rCtx.fillText(formatTC(ms), x + 3, 10);
    }
  }

  // ── Track background ──
  tCtx.fillStyle = '#0a0c10';
  tCtx.fillRect(0, 0, totalW, tracksCanvas.height);
  // Subtle grid lines
  tCtx.strokeStyle = '#1a2030';
  tCtx.lineWidth = 1;
  for (let ms = 0; ms <= dur + tickInterval; ms += tickInterval) {
    const x = ms * pxPerMs;
    tCtx.beginPath(); tCtx.moveTo(x, 0); tCtx.lineTo(x, tracksCanvas.height); tCtx.stroke();
  }

  // ── Event blocks ──
  const p = tlGetPlayer(_tcSelectedName);
  const elapsed = tlElapsed(_tcSelectedName);
  (tl.steps || []).forEach((s, i) => {
    const x = (s.timeMs || 0) * pxPerMs;
    const fired = p.running && s.timeMs <= elapsed;
    const isPlaceholder = s.cmd?.startsWith('//');
    const w = Math.max(4, Math.min(120, 80));
    const h = 28;
    const y = 10;
    // Block
    tCtx.fillStyle = isPlaceholder ? 'rgba(224,160,48,0.3)' : fired ? 'rgba(80,200,120,0.5)' : 'rgba(74,158,255,0.35)';
    tCtx.strokeStyle = isPlaceholder ? 'rgba(224,160,48,0.8)' : fired ? '#50c878' : '#4a9eff';
    tCtx.lineWidth = 1.5;
    tCtx.beginPath();
    tCtx.roundRect(x, y, w, h, 3);
    tCtx.fill(); tCtx.stroke();
    // Label
    tCtx.fillStyle = fired ? '#50c878' : '#e8eaf0';
    tCtx.font = '9px "JetBrains Mono", monospace';
    tCtx.fillText((s.cmd || '').slice(0, 14), x + 4, y + 12);
    tCtx.fillStyle = '#606880';
    tCtx.font = '8px "JetBrains Mono", monospace';
    tCtx.fillText(formatTC(s.timeMs), x + 4, y + 24);
  });

  // Update playhead
  tcUpdatePlayhead(pxPerMs, elapsed);
}

function tcUpdatePlayhead(pxPerMs, elapsed) {
  const ph = document.getElementById('tc-playhead'); if (!ph) return;
  const p = tlGetPlayer(_tcSelectedName || '');
  if (!p.running && !p.offsetMs) { ph.style.display = 'none'; return; }
  ph.style.display = 'block';
  ph.style.left = (elapsed * pxPerMs) + 'px';
}

function tcRulerClick(e) {
  if (!_tcSelectedName) return;
  const canvas = document.getElementById('tc-tracks-canvas'); if (!canvas) return;
  const zoom = parseInt(document.getElementById('tc-zoom')?.value || 100);
  const pxPerMs = zoom / 1000;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const ms = Math.round(x / pxPerMs);
  // Populate the time input with clicked position
  const timeInput = document.getElementById('tc-new-time');
  if (timeInput) timeInput.value = formatTC(ms);
}

// Hook ruler render into tcRenderCueRows and tcSelectTimeline
const _origTcRenderCueRows = tcRenderCueRows;
function tcRenderCueRows() {
  _origTcRenderCueRows();
  // Also update ruler
  setTimeout(tcRenderRuler, 0);
  // Update running clock display
  if (_tcSelectedName) {
    const clock = document.getElementById('tc-running-clock');
    if (clock) clock.textContent = formatTC(tlElapsed(_tcSelectedName));
  }
}

// Hook into tlPlay/tlStop to animate playhead
const _origTlPlay = tlPlay;
function tlPlay(name) {
  _origTlPlay(name);
  _tcRulerAnimLoop();
}

let _tcRulerAnimId = null;
function _tcRulerAnimLoop() {
  if (_tcRulerAnimId) cancelAnimationFrame(_tcRulerAnimId);
  const loop = () => {
    if (!_tcSelectedName) return;
    const p = tlGetPlayer(_tcSelectedName);
    if (p.running) {
      const zoom = parseInt(document.getElementById('tc-zoom')?.value || 100);
      tcUpdatePlayhead(zoom / 1000, tlElapsed(_tcSelectedName));
      const clock = document.getElementById('tc-running-clock');
      if (clock) clock.textContent = formatTC(tlElapsed(_tcSelectedName));
      _tcRulerAnimId = requestAnimationFrame(loop);
    }
  };
  _tcRulerAnimId = requestAnimationFrame(loop);
}
// Each timeline has its own clock. tlPlayers holds runtime state keyed by name.

function tlGetPlayer(name){
  if(!tlPlayers[name]) tlPlayers[name]={running:false,startWall:null,offsetMs:0,_raf:null,_fired:new Set()};
  return tlPlayers[name];
}
function tlElapsed(name){
  const p=tlGetPlayer(name);
  return p.running?(performance.now()-p.startWall+p.offsetMs):p.offsetMs;
}
function tlDuration(name){
  const tl=state.timelines[name]; if(!tl?.steps?.length) return 0;
  return Math.max(...tl.steps.map(s=>s.timeMs||0))+200;
}
function tlPlay(name){
  const tl=state.timelines[name]; if(!tl) return;
  const p=tlGetPlayer(name);
  if(p.running) return;
  p.startWall=performance.now()-p.offsetMs;
  p.running=true;
  _tlTick(name);
  logHistory('·',`TIMELINE "${name}" ▶`,'ok');
  tcRenderList(); _tlEmbedRefresh(); remoteBroadcast();
}
function tlPause(name){
  const p=tlGetPlayer(name); if(!p.running) return;
  p.offsetMs=tlElapsed(name);
  if(p._raf){cancelAnimationFrame(p._raf);p._raf=null;}
  p.running=false;
  logHistory('·',`TIMELINE "${name}" ⏸ ${formatTC(p.offsetMs)}`,'info');
  tcRenderList(); _tlEmbedRefresh(); remoteBroadcast();
}
function tlStop(name){
  const p=tlGetPlayer(name);
  if(p._raf){cancelAnimationFrame(p._raf);p._raf=null;}
  p.running=false; p.offsetMs=0; p._fired=new Set();
  logHistory('·',`TIMELINE "${name}" ■`,'info');
  tcRenderList(); _tlEmbedRefresh(); remoteBroadcast();
}
function tlReset(name){
  const p=tlGetPlayer(name);
  const wasRunning=p.running;
  if(p._raf){cancelAnimationFrame(p._raf);p._raf=null;}
  p.running=false; p.offsetMs=0; p._fired=new Set();
  if(wasRunning){p.startWall=performance.now();p.running=true;_tlTick(name);}
  tcRenderList(); if(_tcSelectedName===name) tcRenderCueRows();
}
function _tlTick(name){
  const p=tlGetPlayer(name); if(!p.running) return;
  const tl=state.timelines[name]; if(!tl){tlStop(name);return;}
  const elapsed=tlElapsed(name);
  const dur=tlDuration(name);
  (tl.steps||[]).forEach((s,i)=>{
    if(!p._fired.has(i)&&(s.timeMs||0)<=elapsed){
      p._fired.add(i);
      try{parseCommand(s.cmd);}catch(e){}
    }
  });
  // Loop
  if(tl.looping&&dur>0&&elapsed>=dur){
    p.startWall=performance.now(); p._fired=new Set();
  } else if(!tl.looping&&dur>0&&elapsed>=dur){
    tlStop(name); return;
  }
  if(_tcSelectedName===name) tcRenderCueRows();
  p._raf=requestAnimationFrame(()=>_tlTick(name));
}

function formatTC(ms){
  ms=Math.max(0,ms||0);
  const h=Math.floor(ms/3600000),m=Math.floor((ms%3600000)/60000),s=Math.floor((ms%60000)/1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`;
}

// ── Timelines Tab UI ──
let _tcSelectedName=null;

function tcPlay(){
  if(!_tcSelectedName) return;
  const p=tlGetPlayer(_tcSelectedName);
  if(p.running) tlPause(_tcSelectedName); else tlPlay(_tcSelectedName);
  tcRenderList(); tcRenderCueRows();
}
function tcStop(){ if(_tcSelectedName) tlStop(_tcSelectedName); }
function tcReset(){ if(_tcSelectedName) tlReset(_tcSelectedName); }
function tcNewTimeline(){
  const name='TL'+(Object.keys(state.timelines).length+1);
  state.timelines[name]={looping:false,steps:[]};
  tcRenderList();
  tcSelectTimeline(name);
}

function tcRenderList(){
  const list=document.getElementById('tc-timeline-list'); if(!list) return;
  list.innerHTML='';
  Object.entries(state.timelines).forEach(([name,tl])=>{
    const isSelected=_tcSelectedName===name;
    const p=tlGetPlayer(name);
    const dur=tl.steps?.length?Math.max(...tl.steps.map(s=>s.timeMs||0)):0;
    const elapsed=tlElapsed(name);
    const pct=dur>0?Math.min(elapsed/dur*100,100):0;
    const row=document.createElement('div');
    row.style.cssText=`padding:8px 10px;border-radius:3px;cursor:pointer;margin-bottom:4px;background:${isSelected?'var(--bg3)':'var(--bg2)'};border:1px solid ${isSelected?'var(--accent3)':'var(--border)'}`;
    row.innerHTML=`
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:5px">
        <span style="font-family:var(--ui);font-weight:700;font-size:11px;color:${p.running?'var(--accent3)':isSelected?'var(--text0)':'var(--text1)'};flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${name}</span>
        <span style="font-family:var(--mono);font-size:9px;color:var(--text2)">${formatTC(elapsed)} / ${formatTC(dur)}</span>
        ${tl.looping?'<span style="font-family:var(--ui);font-size:8px;color:var(--accent2);letter-spacing:1px;border:1px solid var(--accent2);padding:0 3px;border-radius:2px">LOOP</span>':''}
        <button onclick="tcDeleteTimeline('${name}',event)" style="background:none;border:none;color:var(--danger);font-size:10px;cursor:pointer;padding:0 2px">✕</button>
      </div>
      <div style="height:3px;background:var(--bg4);border-radius:2px;margin-bottom:6px;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:${p.running?'var(--accent3)':'var(--text2)'};transition:none"></div>
      </div>
      <div style="display:flex;gap:4px">
        <button onclick="tlPlay('${name}');tcRenderList();if(_tcSelectedName==='${name}')tcRenderCueRows();" style="background:${p.running?'var(--bg4)':'var(--accent3)'};border:1px solid ${p.running?'var(--border2)':'var(--accent3)'};color:${p.running?'var(--text2)':'#000'};font-family:var(--ui);font-weight:700;font-size:9px;padding:3px 10px;cursor:pointer;border-radius:2px;letter-spacing:1px">▶</button>
        <button onclick="tlPause('${name}');tcRenderList();if(_tcSelectedName==='${name}')tcRenderCueRows();" style="background:var(--bg4);border:1px solid var(--border2);color:${p.running?'var(--accent2)':'var(--text2)'};font-family:var(--ui);font-weight:700;font-size:9px;padding:3px 10px;cursor:pointer;border-radius:2px">⏸</button>
        <button onclick="tlStop('${name}');" style="background:var(--bg4);border:1px solid var(--border2);color:var(--text2);font-family:var(--ui);font-weight:700;font-size:9px;padding:3px 10px;cursor:pointer;border-radius:2px">■</button>
        <button onclick="tlReset('${name}');" style="background:var(--bg4);border:1px solid var(--border2);color:var(--text2);font-family:var(--ui);font-weight:700;font-size:9px;padding:3px 8px;cursor:pointer;border-radius:2px">⏮</button>
      </div>`;
    row.onclick=(e)=>{ if(e.target.tagName==='BUTTON') return; tcSelectTimeline(name); };
    list.appendChild(row);
  });
}

function tcSelectTimeline(name){
  _tcSelectedName=name;
  tcRenderList();
  const tl=state.timelines[name];
  const empty=document.getElementById('tc-editor-empty'),area=document.getElementById('tc-editor-area');
  if(empty) empty.style.display='none';
  if(area) area.style.display='flex';
  const nameInput=document.getElementById('tc-tl-name'); if(nameInput) nameInput.value=name;
  const loopCb=document.getElementById('tc-tl-loop'); if(loopCb) loopCb.checked=tl?.looping||false;
  tcRenderCueRows();
  setTimeout(tcRenderRuler, 50);
}

function tcDeleteTimeline(name,e){
  e&&e.stopPropagation();
  tlStop(name); delete tlPlayers[name]; delete state.timelines[name];
  if(_tcSelectedName===name){
    _tcSelectedName=null;
    const empty=document.getElementById('tc-editor-empty'),area=document.getElementById('tc-editor-area');
    if(empty) empty.style.display='flex'; if(area) area.style.display='none';
  }
  tcRenderList();
}

function tcSaveTimeline(){
  const nameInput=document.getElementById('tc-tl-name'); if(!nameInput) return;
  const newName=nameInput.value.trim(); if(!newName) return;
  const looping=document.getElementById('tc-tl-loop')?.checked||false;
  const tl=state.timelines[_tcSelectedName]||{steps:[]};
  if(_tcSelectedName&&_tcSelectedName!==newName){
    // Migrate player state to new name
    tlPlayers[newName]=tlPlayers[_tcSelectedName]||tlGetPlayer(_tcSelectedName);
    delete tlPlayers[_tcSelectedName];
    delete state.timelines[_tcSelectedName];
  }
  state.timelines[newName]={...tl,looping};
  _tcSelectedName=newName;
  logHistory('·',`TIMELINE "${newName}" saved — ${tl.steps?.length||0} cues`,'ok');
  tcRenderList();
}

function tcFireTimeline(){
  if(!_tcSelectedName) return;
  tlPlay(_tcSelectedName);
  tcRenderList(); tcRenderCueRows();
}

function tcAddCueRow(){
  if(!_tcSelectedName) return;
  const timeStr=document.getElementById('tc-new-time')?.value?.trim()||'00:00:00.000';
  const cmd=document.getElementById('tc-new-cmd')?.value?.trim(); if(!cmd) return;
  const timeMs=tcParseTime(timeStr);
  const tl=state.timelines[_tcSelectedName]; if(!tl) return;
  tl.steps=tl.steps||[];
  tl.steps.push({timeMs,cmd});
  tl.steps.sort((a,b)=>a.timeMs-b.timeMs);
  document.getElementById('tc-new-time').value='';
  document.getElementById('tc-new-cmd').value='';
  tcRenderCueRows();
}

function tcDeleteCueRow(idx){
  if(!_tcSelectedName) return;
  const tl=state.timelines[_tcSelectedName]; if(!tl) return;
  tl.steps.splice(idx,1);
  tcRenderCueRows();
}

function tcEditCueRow(idx){
  if(!_tcSelectedName) return;
  const tl=state.timelines[_tcSelectedName]; if(!tl?.steps[idx]) return;
  const s=tl.steps[idx];
  const timeInput=document.getElementById('tc-new-time');
  const cmdInput=document.getElementById('tc-new-cmd');
  if(timeInput) timeInput.value=formatTC(s.timeMs);
  if(cmdInput){ cmdInput.value=s.cmd; cmdInput.focus(); }
  tl.steps.splice(idx,1);
  tcRenderCueRows();
}

function tcRenderCueRows(){
  const cont=document.getElementById('tc-cue-rows'); if(!cont) return;
  if(!_tcSelectedName||!state.timelines[_tcSelectedName]){ cont.innerHTML=''; return; }
  const tl=state.timelines[_tcSelectedName];
  const p=tlGetPlayer(_tcSelectedName);
  const elapsed=tlElapsed(_tcSelectedName);
  const dur=tlDuration(_tcSelectedName);

  // Progress bar at top of cue list
  let progressBar=document.getElementById('tc-progress-bar-wrap');
  if(!progressBar){
    progressBar=document.createElement('div');
    progressBar.id='tc-progress-bar-wrap';
    progressBar.style.cssText='height:4px;background:var(--bg4);flex-shrink:0;position:relative;cursor:pointer';
    progressBar.title='Click to seek';
    progressBar.onclick=(e)=>{
      if(!_tcSelectedName||!dur) return;
      const rect=progressBar.getBoundingClientRect();
      const pct=(e.clientX-rect.left)/rect.width;
      const seekMs=Math.round(pct*dur);
      const tp=tlGetPlayer(_tcSelectedName);
      tp.offsetMs=Math.max(0,seekMs);
      if(tp.running) tp.startWall=performance.now()-tp.offsetMs;
      tcRenderCueRows();
    };
    progressBar.innerHTML='<div id="tc-progress-fill" style="height:100%;background:var(--accent3);width:0%;transition:width .1s"></div>';
    cont.parentElement?.insertBefore(progressBar, cont);
  }
  const fill=document.getElementById('tc-progress-fill');
  if(fill) fill.style.width=(dur>0?Math.min(100,elapsed/dur*100):0)+'%';

  cont.innerHTML='';
  (tl.steps||[]).forEach((s,i)=>{
    const fired=p._fired.has(i);
    const isPlaceholder=s.cmd==='PLACEHOLDER'||s.isPlaceholder;
    const isCurrent=p.running&&s.timeMs<=elapsed&&(i===tl.steps.length-1||tl.steps[i+1].timeMs>elapsed);
    const bgColor=isCurrent?'rgba(80,200,120,0.07)':isPlaceholder?'rgba(224,160,48,0.05)':'transparent';
    const cmdColor=isPlaceholder?'var(--accent2)':fired?'var(--text2)':'var(--text0)';
    const cmdDisplay=isPlaceholder?'⬦ PLACEHOLDER — double-click to edit':escHTML(s.cmd);
    const row=document.createElement('div');
    row.style.cssText=`display:grid;grid-template-columns:86px 1fr 60px;align-items:center;padding:4px 8px;border-bottom:1px solid var(--border);background:${bgColor}`;
    row.innerHTML=`
      <span style="font-family:var(--mono);font-size:10px;color:${fired?'var(--accent3)':'var(--text2)'}">${formatTC(s.timeMs)}</span>
      <span style="font-family:var(--mono);font-size:10px;color:${cmdColor};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${isPlaceholder?'font-style:italic':''}" title="${escHTML(s.cmd)}">${cmdDisplay}</span>
      <span style="display:flex;gap:2px;justify-content:flex-end;align-items:center">
        ${fired?'<span style="font-family:var(--ui);font-size:8px;color:var(--accent3)">✓</span>':''}
        ${isPlaceholder?'<span style="font-family:var(--ui);font-size:8px;color:var(--accent2);letter-spacing:1px">P</span>':''}
        <button onclick="tcEditCueRow(${i})" style="background:none;border:none;color:var(--text2);font-size:9px;cursor:pointer;padding:0 3px">✎</button>
        <button onclick="tcDeleteCueRow(${i})" style="background:none;border:none;color:var(--danger);font-size:9px;cursor:pointer;padding:0 3px">✕</button>
      </span>`;
    row.ondblclick=()=>tcEditCueRow(i);
    cont.appendChild(row);
  });
  // Update transport play button label
  const playBtn=document.getElementById('tc-play-btn');
  if(playBtn) playBtn.textContent=p.running?'⏸ Pause':'▶ Play';
}

function tcParseTime(str){
  if(/^\d+$/.test(str)) return parseInt(str);
  const parts=str.split(':');
  if(parts.length===3){
    const[h,m,sf]=parts;const[s,ms]=(sf||'0').split('.');
    return(parseInt(h||0)*3600+parseInt(m||0)*60+parseInt(s||0))*1000+parseInt((ms||'0').padEnd(3,'0').slice(0,3));
  } else if(parts.length===2){
    const[m,sf]=parts;const[s,ms]=(sf||'0').split('.');
    return(parseInt(m||0)*60+parseInt(s||0))*1000+parseInt((ms||'0').padEnd(3,'0').slice(0,3));
  }
  return 0;
}

// ─── SHOW FILE ────────────────────────────────────────────────────────────────
function getShowData() {
  return JSON.stringify({
    version:4, showName:state.showName,
    cues:state.cues, presets:state.presets, links:state.links, faders:state.faders,
    patchData:state.patchData, fixtures:state.fixtures.map(f=>({...f})),
    vars:state.vars, timelines:state.timelines, effects:state.effects,
    groups:state.groups, bitmaps:state.bitmaps,
    gridCols:state.gridCols, panelLayout:state.panelLayout,
    stageObjects:state.stageObjects||[],
    customProfiles:state.customProfiles||[],
  },null,2);
}

function loadShowData(raw) {
  try{
    const d=JSON.parse(raw);
    Object.keys(state.fadeTimers).forEach(k=>{clearInterval(state.fadeTimers[k]);delete state.fadeTimers[k];});
    Object.keys(programmer).forEach(k=>delete programmer[k]);
    state._editingCue=null;
    if(d.cues)      state.cues      =d.cues.map(c=>({mib:false,snapshot:{},...c}));
    if(d.presets)   state.presets   =d.presets;
    if(d.links)     state.links     =d.links;
    if(d.faders)    state.faders    =d.faders.map(f=>({fixtures:[],param:'dimmer',...f}));
    if(d.patchData) state.patchData =d.patchData;
    if(d.fixtures)  state.fixtures  =d.fixtures;
    if(d.vars)      state.vars      =d.vars;
    if(d.timelines) state.timelines =d.timelines;
    if(d.effects)   state.effects   =d.effects;
    if(d.groups)    state.groups    =d.groups;
    if(d.bitmaps)   state.bitmaps   =d.bitmaps;
    if(d.gridCols)  state.gridCols  =d.gridCols;
    if(Array.isArray(d.panelLayout)&&d.panelLayout.length===4)
      state.panelLayout=d.panelLayout.map(p=>PANEL_TYPES[p]?p:'fixtures');
    if(Array.isArray(d.stageObjects)) state.stageObjects=d.stageObjects;
    else state.stageObjects=[];
    if(Array.isArray(d.customProfiles)) state.customProfiles=d.customProfiles;
    else state.customProfiles=[];
    if(d.showName)  updateShowName(d.showName);
    state.selected.clear(); state.currentCue=-1;
    renderAll(); drawIfVisible();
    logHistory('·','Show loaded: '+state.showName,'ok');
    logHistory('·',`${state.cues.length} cues  ${state.presets.length} presets  ${state.fixtures.length} fixtures  ${state.faders.length} faders`,'info');
  }catch(e){logHistory('!','Failed to load show: '+e.message,'err');}
}

// ─── 3D ───────────────────────────────────────────────────────────────────────
function setup3D() {
  const canvas=document.getElementById('canvas3d'); if(!canvas) return;
  let drag=false,lastX=0,lastY=0;
  canvas.addEventListener('mousedown',e=>{drag=true;lastX=e.clientX;lastY=e.clientY;canvas.style.cursor='grabbing';});
  canvas.addEventListener('mousemove',e=>{if(!drag)return;state.viz3d.camAngle+=(e.clientX-lastX)*0.008;state.viz3d.camElev+=(e.clientY-lastY)*0.008;state.viz3d.camElev=state.viz3d.camElev%(Math.PI*2);lastX=e.clientX;lastY=e.clientY;draw3D();});
  canvas.addEventListener('mouseup',()=>{drag=false;canvas.style.cursor='grab';});
  canvas.addEventListener('mouseleave',()=>{drag=false;canvas.style.cursor='grab';});
  canvas.addEventListener('wheel',e=>{state.viz3d.camDist=Math.max(200,Math.min(1400,state.viz3d.camDist+e.deltaY*0.6));draw3D();e.preventDefault();},{passive:false});
  canvas.addEventListener('dblclick',e=>{const id=pick3DFixture(e);if(id!==null)openFix3DEdit(id);});
}
function resizeCanvas(){const c=state.viz3d.canvas;if(!c)return;const w=c.offsetWidth,h=c.offsetHeight;if(w>0&&h>0){c.width=w;c.height=h;}}
function project3D(x,y,z){
  const{camAngle,camElev,camDist,canvas}=state.viz3d; if(!canvas||!canvas.width) return null;
  const W=canvas.width,H=canvas.height,tx=x,ty=y-120,tz=z;
  const cosY=Math.cos(camAngle),sinY=Math.sin(camAngle),rx1=tx*cosY+tz*sinY,ry1=ty,rz1=-tx*sinY+tz*cosY;
  const cosP=Math.cos(camElev),sinP=Math.sin(camElev),rx2=rx1,ry2=ry1*cosP-rz1*sinP,rz2=ry1*sinP+rz1*cosP;
  const fov=580,pz=rz2+camDist; if(pz<=10) return null;
  return{x:(rx2/pz)*fov+W/2,y:(-ry2/pz)*fov+H/2,scale:fov/pz};
}
function draw3D(){
  const{canvas,ctx}=state.viz3d; if(!canvas||!ctx||!canvas.width||!canvas.height) return;
  const W=canvas.width,H=canvas.height;

  // roundRect polyfill for older Chromium versions
  if(!ctx.roundRect) ctx.roundRect=function(x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.lineTo(x+w-r,y);ctx.quadraticCurveTo(x+w,y,x+w,y+r);ctx.lineTo(x+w,y+h-r);ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h);ctx.lineTo(x+r,y+h);ctx.quadraticCurveTo(x,y+h,x,y+h-r);ctx.lineTo(x,y+r);ctx.quadraticCurveTo(x,y,x+r,y);ctx.closePath();};

  ctx.clearRect(0,0,W,H);

  // ── Background gradient ──────────────────────────────────────────────────
  const bg=ctx.createLinearGradient(0,0,0,H);
  bg.addColorStop(0,'#04060c'); bg.addColorStop(1,'#080d18');
  ctx.fillStyle=bg; ctx.fillRect(0,0,W,H);

  // ── Grid floor ────────────────────────────────────────────────────────────
  ctx.lineWidth=0.5;
  for(let g=-20;g<=20;g++){
    const fade=1-Math.abs(g)/22;
    ctx.strokeStyle=`rgba(40,60,100,${fade*0.4})`;
    const a=project3D(g*80,0,-20*80),b=project3D(g*80,0,20*80);
    if(a&&b){ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke();}
    const c2=project3D(-20*80,0,g*80),d2=project3D(20*80,0,g*80);
    if(c2&&d2){ctx.beginPath();ctx.moveTo(c2.x,c2.y);ctx.lineTo(d2.x,d2.y);ctx.stroke();}
  }

  // ── Stage outline ─────────────────────────────────────────────────────────
  const stageCorners=[[-600,0,-280],[600,0,-280],[600,0,220],[-600,0,220]];
  const sc=stageCorners.map(([x,y,z])=>project3D(x,y,z)).filter(Boolean);
  if(sc.length===4){
    // Stage fill
    ctx.beginPath();ctx.moveTo(sc[0].x,sc[0].y);sc.forEach(p=>ctx.lineTo(p.x,p.y));ctx.closePath();
    ctx.fillStyle='rgba(15,25,45,0.6)';ctx.fill();
    ctx.strokeStyle='rgba(80,110,180,0.5)';ctx.lineWidth=1.5;ctx.stroke();
  }

  // ── Truss bars ────────────────────────────────────────────────────────────
  [[-220,0],[0,0],[180,0]].forEach(([tz])=>{
    const ta=project3D(-560,320,tz),tb=project3D(560,320,tz);
    if(!ta||!tb) return;
    // Truss tube
    ctx.strokeStyle='rgba(150,130,80,0.6)';ctx.lineWidth=4;
    ctx.beginPath();ctx.moveTo(ta.x,ta.y);ctx.lineTo(tb.x,tb.y);ctx.stroke();
    // Truss detail lines
    ctx.strokeStyle='rgba(100,90,55,0.35)';ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(ta.x,ta.y+2);ctx.lineTo(tb.x,tb.y+2);ctx.stroke();
    // Support pipes
    for(let tx=-480;tx<=480;tx+=240){
      const top=project3D(tx,320,tz),bot=project3D(tx,0,tz);
      if(top&&bot){ctx.strokeStyle='rgba(100,90,55,0.3)';ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(top.x,top.y);ctx.lineTo(bot.x,bot.y);ctx.stroke();}
    }
  });

  // ── Custom stage objects (boxes & trusses) ────────────────────────────────
  (state.stageObjects||[]).forEach(obj=>{
    const cx=obj.x||0,cy=obj.y||0,cz=obj.z||0;
    const hw=(obj.w||200)/2,hh=(obj.h||100)/2,hd=(obj.d||200)/2;
    const col=obj.color||'rgba(100,140,200,0.7)';
    if(obj.type==='truss'){
      // Truss: horizontal bar at top of object
      const ta=project3D(cx-hw,cy+hh,cz),tb=project3D(cx+hw,cy+hh,cz);
      if(ta&&tb){
        ctx.strokeStyle=col;ctx.lineWidth=5;
        ctx.beginPath();ctx.moveTo(ta.x,ta.y);ctx.lineTo(tb.x,tb.y);ctx.stroke();
        ctx.strokeStyle=col.replace(/[\d.]+\)$/,'0.35)');ctx.lineWidth=1.5;
        ctx.beginPath();ctx.moveTo(ta.x,ta.y+2);ctx.lineTo(tb.x,tb.y+2);ctx.stroke();
        // Support legs
        const step=Math.max(hw/2,80);
        for(let tx=cx-hw;tx<=cx+hw+1;tx+=step){
          const top=project3D(tx,cy+hh,cz),bot=project3D(tx,cy,cz);
          if(top&&bot){ctx.strokeStyle=col.replace(/[\d.]+\)$/,'0.3)');ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(top.x,top.y);ctx.lineTo(bot.x,bot.y);ctx.stroke();}
        }
        if(obj.label){const mid=project3D(cx,cy+hh+20,cz);if(mid){ctx.fillStyle='rgba(200,200,255,0.7)';ctx.font='bold 9px monospace';ctx.textAlign='center';ctx.fillText(obj.label,mid.x,mid.y-4);}}
      }
    } else {
      // Box: draw 3D box using 8 corners
      const corners=[
        [cx-hw,cy-hh,cz-hd],[cx+hw,cy-hh,cz-hd],[cx+hw,cy+hh,cz-hd],[cx-hw,cy+hh,cz-hd],
        [cx-hw,cy-hh,cz+hd],[cx+hw,cy-hh,cz+hd],[cx+hw,cy+hh,cz+hd],[cx-hw,cy+hh,cz+hd],
      ].map(([x,y,z])=>project3D(x,y,z));
      if(corners.every(Boolean)){
        const faces=[[0,1,2,3],[4,5,6,7],[0,4,7,3],[1,5,6,2],[3,2,6,7],[0,1,5,4]];
        // Draw back faces first then front
        const baseAlpha=parseFloat((col.match(/[\d.]+(?=\))/)||['0.5'])[0]);
        faces.forEach((f,fi)=>{
          ctx.beginPath();ctx.moveTo(corners[f[0]].x,corners[f[0]].y);
          f.slice(1).forEach(i=>ctx.lineTo(corners[i].x,corners[i].y));ctx.closePath();
          const shade=[0.3,0.3,0.5,0.5,0.6,0.15][fi];
          ctx.fillStyle=col.replace(/[\d.]+\)$/,`${baseAlpha*shade})`);ctx.fill();
          ctx.strokeStyle=col;ctx.lineWidth=0.8;ctx.stroke();
        });
        if(obj.label){const top=project3D(cx,cy+hh+14,cz);if(top){ctx.fillStyle='rgba(200,200,255,0.7)';ctx.font='bold 9px monospace';ctx.textAlign='center';ctx.fillText(obj.label,top.x,top.y);}}
      }
    }
  });

  // ── Sort fixtures back-to-front ───────────────────────────────────────────
  const sorted=[...state.fixtures].sort((a,b)=>{
    const pa=project3D(a.stageX,a.stageY,a.stageZ),pb=project3D(b.stageX,b.stageY,b.stageZ);
    return(pa?pa.y:0)-(pb?pb.y:0);
  });

  // ── Draw beams first (behind fixtures) ───────────────────────────────────
  sorted.forEach(f=>{
    const pos=project3D(f.stageX,f.stageY,f.stageZ); if(!pos) return;
    const br=f.dimmer/255; if(br<0.01) return;
    const r=f.red??255,g2=f.green??255,b2=f.blue??255;

    // Pan/tilt aim point on floor
    const panRad=((f.pan??127)-127)/127*Math.PI*0.8;
    const tiltRad=((f.tilt??127)-127)/127*Math.PI*0.5;
    const beamLen=f.stageY||300;
    const aimX=f.stageX+Math.sin(panRad)*beamLen;
    const aimZ=f.stageZ+Math.sin(tiltRad)*beamLen;
    const fp=project3D(aimX,0,aimZ); if(!fp) return;

    const bw=pos.scale*12*br;
    const dx=fp.x-pos.x,dy=fp.y-pos.y,len=Math.sqrt(dx*dx+dy*dy)||1;
    const nx=-dy/len*bw,ny=dx/len*bw;

    // Beam cone with soft edges
    const grad=ctx.createLinearGradient(pos.x,pos.y,fp.x,fp.y);
    grad.addColorStop(0,`rgba(${r},${g2},${b2},${br*0.85})`);
    grad.addColorStop(0.3,`rgba(${r},${g2},${b2},${br*0.25})`);
    grad.addColorStop(0.7,`rgba(${r},${g2},${b2},${br*0.08})`);
    grad.addColorStop(1,`rgba(${r},${g2},${b2},0)`);
    const fw=bw*4; // beam widens toward floor
    const fnx=-dy/len*fw,fny=dx/len*fw;
    ctx.beginPath();ctx.moveTo(pos.x+nx,pos.y+ny);ctx.lineTo(fp.x+fnx,fp.y+fny);ctx.lineTo(fp.x-fnx,fp.y-fny);ctx.lineTo(pos.x-nx,pos.y-ny);ctx.closePath();
    ctx.fillStyle=grad;ctx.fill();

    // Floor pool — elliptical, perspective-corrected
    const poolR=Math.max(20,80*pos.scale*br);
    const pg=ctx.createRadialGradient(fp.x,fp.y,0,fp.x,fp.y,poolR);
    pg.addColorStop(0,`rgba(${r},${g2},${b2},${br*0.65})`);
    pg.addColorStop(0.4,`rgba(${r},${g2},${b2},${br*0.2})`);
    pg.addColorStop(1,`rgba(${r},${g2},${b2},0)`);
    ctx.save();ctx.translate(fp.x,fp.y);ctx.scale(1,0.35);
    ctx.beginPath();ctx.arc(0,0,poolR,0,Math.PI*2);ctx.fillStyle=pg;ctx.fill();ctx.restore();
  });

  // ── Draw fixture bodies (type-specific 3D models) ─────────────────────────
  sorted.forEach(f=>{
    const pos=project3D(f.stageX??0,f.stageY??300,f.stageZ??0); if(!pos) return;
    drawFixtureInScene(ctx, f, pos, 1);
  });

  // ── HUD overlay ──────────────────────────────────────────────────────────
  ctx.fillStyle='rgba(140,160,200,0.45)';ctx.font='10px "JetBrains Mono",monospace';ctx.textAlign='left';ctx.textBaseline='top';
  const az=Math.round(((state.viz3d.camAngle*180/Math.PI)%360+360)%360);
  const el2=Math.round(state.viz3d.camElev*180/Math.PI);
  ctx.fillText(`az ${az}°  el ${el2}°  d ${Math.round(state.viz3d.camDist)}`,10,10);
  const on=state.fixtures.filter(f=>f.dimmer>0).length;
  ctx.fillText(`${on}/${state.fixtures.length} active  ${state.fixtures.length?'dbl-click=edit':'patch fixtures to begin'}`,10,24);
}
function reset3DCamera(){state.viz3d.camAngle=0.3;state.viz3d.camElev=-0.5;state.viz3d.camDist=700;draw3D();}
function top3DCamera(){state.viz3d.camAngle=0;state.viz3d.camElev=-(Math.PI/2-0.05);state.viz3d.camDist=800;draw3D();}
function front3DCamera(){state.viz3d.camAngle=0;state.viz3d.camElev=0.1;state.viz3d.camDist=700;draw3D();}

// ─── 3D POSITION EDITOR ───────────────────────────────────────────────────────
const fix3DEdit={fixId:null};let _fix3DPickHandler=null;
function open3DEditSelected(){const id=[...state.selected][0]??state.fixtures[0]?.id;if(id!=null)openFix3DEdit(id);}
function openFix3DEdit(id){
  const f=state.fixtures.find(x=>x.id===id);if(!f)return;
  fix3DEdit.fixId=id;
  document.getElementById('fpe-fix-label').textContent=`FIX ${f.id} — ${f.type}`;
  document.getElementById('fpe-x').value=Math.round(f.stageX??0);document.getElementById('fpe-y').value=Math.round(f.stageY??300);document.getElementById('fpe-z').value=Math.round(f.stageZ??0);document.getElementById('fpe-pan').value=f.pan??127;document.getElementById('fpe-tilt').value=f.tilt??127;
  document.getElementById('fix-pos-overlay').style.display='flex';
  const canvas=state.viz3d.canvas;if(_fix3DPickHandler&&canvas)canvas.removeEventListener('click',_fix3DPickHandler);
  _fix3DPickHandler=e=>{const id2=pick3DFixture(e);if(id2!==null)openFix3DEdit(id2);};
  if(canvas)canvas.addEventListener('click',_fix3DPickHandler);
}
function closeFix3DEdit(){document.getElementById('fix-pos-overlay').style.display='none';const c=state.viz3d.canvas;if(_fix3DPickHandler&&c)c.removeEventListener('click',_fix3DPickHandler);_fix3DPickHandler=null;fix3DEdit.fixId=null;draw3D();}
function applyFix3DEdit(){
  const f=state.fixtures.find(x=>x.id===fix3DEdit.fixId);if(!f)return;
  const x=parseFloat(document.getElementById('fpe-x').value),y=parseFloat(document.getElementById('fpe-y').value),z=parseFloat(document.getElementById('fpe-z').value),pan=parseInt(document.getElementById('fpe-pan').value),tilt=parseInt(document.getElementById('fpe-tilt').value);
  if(!isNaN(x))f.stageX=x;if(!isNaN(y))f.stageY=y;if(!isNaN(z))f.stageZ=z;if(!isNaN(pan))f.pan=Math.max(0,Math.min(255,pan));if(!isNaN(tilt))f.tilt=Math.max(0,Math.min(255,tilt));draw3D();
}
function fix3DSelectPrev(){const idx=state.fixtures.findIndex(f=>f.id===fix3DEdit.fixId);const p=state.fixtures[Math.max(0,idx-1)];if(p)openFix3DEdit(p.id);}
function fix3DSelectNext(){const idx=state.fixtures.findIndex(f=>f.id===fix3DEdit.fixId);const n=state.fixtures[Math.min(state.fixtures.length-1,idx+1)];if(n)openFix3DEdit(n.id);}
function pick3DFixture(ev){
  const canvas=state.viz3d.canvas;if(!canvas)return null;const rect=canvas.getBoundingClientRect();const mx=ev.clientX-rect.left,my=ev.clientY-rect.top;let best=null,bestDist=24;
  state.fixtures.forEach(f=>{const pos=project3D(f.stageX,f.stageY,f.stageZ);if(!pos)return;const size=Math.max(6,pos.scale*18)*0.5,dx=pos.x-mx,dy=pos.y-my,dist=Math.sqrt(dx*dx+dy*dy);if(dist<size&&dist<bestDist){best=f.id;bestDist=dist;}});return best;
}

// ─── AI AGENT ─────────────────────────────────────────────────────────────────
// Embedded Claude-powered lighting assistant.
// Knows your full show state, generates LightScript commands, executes them live.

const aiState = {
  history: [],
  autoExecute: true,
  streaming: false,
  backend: 'cloud',   // 'cloud' | 'ollama'
  provider: 'gemini', // 'gemini' | 'groq' | 'openrouter' | 'anthropic'
  hasKey: false,
  ollamaUrl: '',
  ollamaModel: '',
};

const AI_PROVIDERS = {
  gemini:      { label:'Gemini 1.5 Flash', free:true,  placeholder:'AIza…',      hint:'Free — aistudio.google.com → Get API Key' },
  groq:        { label:'Groq (Llama 3)',   free:true,  placeholder:'gsk_…',       hint:'Free — console.groq.com → API Keys' },
  openrouter:  { label:'OpenRouter',       free:true,  placeholder:'sk-or-…',     hint:'Free models — openrouter.ai → Keys' },
  anthropic:   { label:'Claude Haiku',     free:false, placeholder:'sk-ant-…',    hint:'Paid — console.anthropic.com' },
};

// Called once on init
async function aiInit() {
  if (!window.electronAPI?.aiHasKey) { aiState.backend='ollama'; aiUpdateBackendUI(); return; }
  const r = await window.electronAPI.aiHasKey();
  if (r.hasKey) { aiState.hasKey=true; aiState.backend='cloud'; aiState.provider=r.provider||'gemini'; }
  else { aiState.backend='ollama'; }
  aiUpdateBackendUI();
  const sel=document.getElementById('ai-provider-select'); if(sel) sel.value=aiState.provider;
}

function aiUpdateBackendUI() {
  const dot=document.getElementById('ai-panel-dot');
  const warn=document.getElementById('ai-tab-key-warn');
  const statusLabel=document.getElementById('ai-key-status-label');
  const prov=AI_PROVIDERS[aiState.provider]||AI_PROVIDERS.gemini;
  if(aiState.backend==='cloud'&&aiState.hasKey){
    if(dot){dot.style.background='var(--accent3)';dot.style.boxShadow='0 0 6px var(--accent3)';}
    if(warn) warn.style.display='none';
    if(statusLabel) statusLabel.innerHTML=`<span style="color:var(--accent3)">✓ ${prov.label} — AI ready</span>`;
  } else {
    if(warn) warn.style.display='flex';
    if(dot){dot.style.background='var(--accent2)';dot.style.boxShadow='none';}
    if(statusLabel) statusLabel.innerHTML='<span style="color:var(--text2)">No key — using Ollama fallback</span>';
    aiCheckOllama(true);
  }
  const inp1=document.getElementById('ai-key-inline-input');
  const inp2=document.getElementById('ai-key-paste-input');
  const hint=document.getElementById('ai-key-hint');
  if(inp1) inp1.placeholder=prov.placeholder;
  if(inp2) inp2.placeholder=prov.placeholder;
  if(hint) hint.textContent=prov.hint;
}

function aiGetOllamaUrl() {
  if(aiState.ollamaUrl) return aiState.ollamaUrl;
  try{ aiState.ollamaUrl=localStorage.getItem('ls_ollama_url')||'http://localhost:11434'; }catch(_){}
  return aiState.ollamaUrl||'http://localhost:11434';
}
function aiGetOllamaModel() {
  if(aiState.ollamaModel) return aiState.ollamaModel;
  try{ aiState.ollamaModel=localStorage.getItem('ls_ollama_model')||'llama3'; }catch(_){}
  return aiState.ollamaModel||'llama3';
}
function aiSetOllamaUrl(v){ aiState.ollamaUrl=v.trim(); try{localStorage.setItem('ls_ollama_url',aiState.ollamaUrl);}catch(_){} }
function aiSetOllamaModel(v){ aiState.ollamaModel=v.trim(); try{localStorage.setItem('ls_ollama_model',aiState.ollamaModel);}catch(_){} }
function aiGetKey(){ return aiState.hasKey?'set':''; }
function aiSetKey(k){}  // legacy stub

async function aiSaveKey(key) {
  if(!window.electronAPI?.aiSetKey) return;
  key=key.trim(); if(!key){logHistory('!','AI: paste your API key first','err');return;}
  const provider=document.getElementById('ai-provider-select')?.value||aiState.provider||'gemini';
  await window.electronAPI.aiSetKey(key,provider);
  aiState.hasKey=true; aiState.backend='cloud'; aiState.provider=provider;
  aiUpdateBackendUI();
  const prov=AI_PROVIDERS[provider]||AI_PROVIDERS.gemini;
  logHistory('·',`AI: ${prov.label} key saved — AI ready`,'ok');
  const inp1=document.getElementById('ai-key-inline-input'); if(inp1) inp1.value='';
  const inp2=document.getElementById('ai-key-paste-input'); if(inp2) inp2.value='';
}

async function aiClearKey() {
  if(!window.electronAPI?.aiClearKey) return;
  await window.electronAPI.aiClearKey();
  aiState.hasKey=false; aiState.backend='ollama';
  aiUpdateBackendUI();
  logHistory('·','AI: key removed','info');
}

async function aiCheckOllama(silent=false){
  const url=aiGetOllamaUrl();
  const statusEl=document.getElementById('ai-ollama-status');
  const warnEl=document.getElementById('ai-tab-key-warn');
  const dotEl=document.getElementById('ai-panel-dot');
  try{
    const resp=await fetch(`${url}/api/tags`,{signal:AbortSignal.timeout(3000)});
    if(!resp.ok) throw new Error('HTTP '+resp.status);
    const data=await resp.json();
    const models=(data.models||[]).map(m=>m.name);
    const currentModel=aiGetOllamaModel();
    const hasModel=models.some(m=>m.startsWith(currentModel.split(':')[0]));
    if(statusEl) statusEl.innerHTML=`<span style="color:var(--accent3)">✓ Ollama connected</span> — ${models.length} model${models.length!==1?'s':''}: ${models.slice(0,4).join(', ')}${models.length>4?'…':''}`;
    if(warnEl) warnEl.style.display='none';
    if(dotEl){dotEl.style.background='var(--accent3)';dotEl.style.boxShadow='0 0 6px var(--accent3)';}
    if(!hasModel&&models.length){
      const warn=document.getElementById('ai-ollama-warn-text');
      if(warn) warn.textContent=`⚠ Model "${currentModel}" not found. Available: ${models.slice(0,3).join(', ')}. Run: ollama pull ${currentModel}`;
      if(warnEl) warnEl.style.display='flex';
    }
  }catch(e){
    const msg=`⚠ Ollama not reachable at ${url} — run: ollama serve`;
    if(statusEl) statusEl.innerHTML=`<span style="color:var(--danger)">✕ ${e.message}</span> — run: <b>ollama serve</b>`;
    const warnText=document.getElementById('ai-ollama-warn-text');
    if(warnText) warnText.textContent=msg;
    if(warnEl) warnEl.style.display='flex';
    if(dotEl){dotEl.style.background='var(--danger)';dotEl.style.boxShadow='none';}
    if(!silent) logHistory('!',`AI: ${msg}`,'err');
  }
}
// Keep legacy stubs so nothing breaks
function aiGetKey(){ return 'ollama'; }
function aiSetKey(k){}

function aiGetSystemPrompt() {
  const fixList = state.fixtures.map(f=>
    `  FIX ${f.id} "${f.name}" addr=${f.address} ch=${f.channels} | dimmer=${f.dimmer??0} R=${f.red??255} G=${f.green??255} B=${f.blue??255} pan=${f.pan??127} tilt=${f.tilt??127}`
  ).join('\n');
  const cueList = state.cues.map(c=>`  CUE ${c.num} "${c.name}" fade=${c.fade}ms`).join('\n');
  const presetList = state.presets.map(p=>`  PRESET ${p.type}.${p.num} "${p.name}"`).join('\n');
  const faderList = state.faders.map((f,i)=>`  FADER ${i+1} "${f.name}" val=${f.val??0}`).join('\n');
  const tlList = Object.keys(state.timelines).map(n=>`  TIMELINE "${n}" steps=${state.timelines[n].steps?.length??0}`).join('\n');
  const selList = [...state.selected].join(', ') || 'none';

  return `You are an AI lighting operator assistant built into LightScript, a professional DMX lighting console.
You help the operator program and run lighting for live shows. You have full knowledge of the LightScript command language.

## CURRENT SHOW STATE
Show: "${state.showName}"
Selected fixtures: ${selList}
Current cue: ${state.currentCue >= 0 ? `CUE ${state.cues[state.currentCue]?.num} "${state.cues[state.currentCue]?.name}"` : 'none'}

## PATCHED FIXTURES (${state.fixtures.length} total)
${fixList || '  (none patched)'}

## CUES (${state.cues.length} total)
${cueList || '  (none)'}

## PRESETS
${presetList || '  (none)'}

## FADERS
${faderList || '  (none)'}

## TIMELINES
${tlList || '  (none)'}

## LIGHTSCRIPT COMMAND REFERENCE
- SET FIX <ids>.<param> <val>          snap a parameter (0-255)
- SET SEL <param> <val>               snap selected fixtures
- SET ALL <param> <val>               snap all fixtures
- FADE FIX <ids>.<param> <val> [<ms>] fade over time (default 2000ms)
- FADE SEL <param> <val> [<ms>]       fade selected fixtures
- FADE ALL <param> <val> [<ms>]       fade all fixtures
- SET FIX 1-8.dimmer 255               range syntax
- SET FIX 1,3,5.red 255                comma list
- STORE CUE.<n> <name>                 store current programmer as cue
- STORE PRESET.<TYPE>.<n> <name>       store preset
- RECALL PRESET <TYPE>.<n>             recall preset
- GO / BACK / STOP                     cue transport
- JUMP CUE <n>                         jump to cue index
- SELECT ALL / SELECT FIX <ids>        selection
- CLEAR                                clear programmer
- FADER <n> <val>                      set fader 1-8 to 0-255
- TIMELINE PLAY/PAUSE/STOP/RESET <name>
- BITMAP PROJECTOR                     open image projector
- Parameters: dimmer, red, green, blue, white, amber, uv, pan, tilt, zoom, gobo, shutter, speed

## YOUR ROLE
- Understand natural language requests and translate them to LightScript commands
- You can output multiple commands, one per line
- Wrap commands you want executed in a \`\`\`lightscript code block
- Explain what you're doing in plain English before the code block
- If asked about the show state, describe it from the data above
- Be concise — this is a live show environment
- You can chain complex sequences: e.g. "sunset look" could fade everything warm over 5 seconds
- When storing cues/presets, generate the SET/FADE commands first, then the STORE command`;
}

// ─── ML CONTROLS PANEL ────────────────────────────────────────────────────────
function buildMLPanel(body, ctrl) {
  body.style.overflow='hidden auto';
  body.innerHTML='';

  // Header: show which fixtures are selected
  const hdr=document.createElement('div');
  hdr.style.cssText='display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg2);border-bottom:1px solid var(--border);flex-shrink:0';
  hdr.innerHTML=`<span id="ml-sel-label" style="font-family:var(--mono);font-size:10px;color:var(--accent2)">No selection</span>
    <span style="flex:1"></span>
    <button onclick="mlSetParam('dimmer',255)" style="background:var(--bg3);border:1px solid var(--border2);color:var(--text1);font-family:var(--ui);font-size:9px;padding:2px 8px;cursor:pointer;border-radius:2px">FULL</button>
    <button onclick="mlSetParam('dimmer',0)" style="background:var(--bg3);border:1px solid var(--border2);color:var(--text1);font-family:var(--ui);font-size:9px;padding:2px 8px;cursor:pointer;border-radius:2px">OUT</button>`;
  body.appendChild(hdr);

  const wrap=document.createElement('div');
  wrap.id='ml-panel-wrap';
  wrap.style.cssText='flex:1;overflow:auto;padding:10px;display:flex;flex-direction:column;gap:12px';
  body.appendChild(wrap);
  mlRefreshPanel();
}

function mlSetParam(param, val, fade=0){
  const ids=[...state.selected]; if(!ids.length) return;
  if(fade>0) ids.forEach(id=>fadeFixtureParam([id],param,val,fade));
  else { ids.forEach(id=>{const f=state.fixtures.find(x=>x.id===id);if(f&&param in f)f[param]=val;}); renderFixtures(); drawIfVisible(); }
  remoteBroadcast();
}

function mlRefreshPanel(){
  const wrap=document.getElementById('ml-panel-wrap'); if(!wrap) return;
  const selLabel=document.getElementById('ml-sel-label');
  const ids=[...state.selected];
  if(selLabel) selLabel.textContent=ids.length?`${ids.length} fixture${ids.length>1?'s':''} selected (${ids.join(', ')})`: 'No selection — click a fixture';
  wrap.innerHTML='';
  if(!ids.length){ wrap.innerHTML='<div style="color:var(--text2);font-family:var(--ui);font-size:11px;padding:20px;text-align:center">Select fixtures to see ML controls</div>'; return; }

  const f=state.fixtures.find(x=>ids.includes(x.id))||state.fixtures[0];

  // ── Intensity ──
  wrap.appendChild(mlSliderSection('Intensity','dimmer',f?.dimmer??0,0,255));

  // ── Color — color picker + RGB sliders ──
  const colSec=document.createElement('div');
  const curR=f?.red??255,curG=f?.green??255,curB=f?.blue??255;
  const hex=`#${[curR,curG,curB].map(v=>v.toString(16).padStart(2,'0')).join('')}`;
  colSec.innerHTML=`<div style="font-family:var(--ui);font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--text2);margin-bottom:6px">Color</div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
      <input type="color" value="${hex}" style="width:48px;height:48px;border:none;background:none;cursor:pointer;padding:0;border-radius:4px"
        oninput="const c=this.value;mlSetParam('red',parseInt(c.slice(1,3),16));mlSetParam('green',parseInt(c.slice(3,5),16));mlSetParam('blue',parseInt(c.slice(5,7),16))">
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${['#ff0000','#ff8000','#ffff00','#00ff00','#0080ff','#8000ff','#ff00ff','#ffffff','#ff6666','#ffcc88'].map(c=>`<div onclick="mlSetParam('red',parseInt('${c.slice(1,3)}',16));mlSetParam('green',parseInt('${c.slice(3,5)}',16));mlSetParam('blue',parseInt('${c.slice(5,7)}',16))" style="width:24px;height:24px;border-radius:3px;background:${c};cursor:pointer;border:1px solid rgba(255,255,255,0.1)"></div>`).join('')}
      </div>
    </div>`;
  colSec.appendChild(mlSlider('R','red',curR,0,255,'#e05050'));
  colSec.appendChild(mlSlider('G','green',curG,0,255,'#50c878'));
  colSec.appendChild(mlSlider('B','blue',curB,0,255,'#4a9eff'));
  if(f?.white!=null) colSec.appendChild(mlSlider('W','white',f.white,0,255,'#c8c8c8'));
  if(f?.amber!=null) colSec.appendChild(mlSlider('A','amber',f.amber,0,255,'#e0a030'));
  if(f?.uv!=null) colSec.appendChild(mlSlider('UV','uv',f.uv,0,255,'#8040ff'));
  wrap.appendChild(colSec);

  // ── Pan/Tilt XY pad ──
  if(f?.pan!=null&&f?.tilt!=null){
    const ptSec=document.createElement('div');
    const panV=f.pan??127,tiltV=f.tilt??127;
    const pPct=panV/255*100,tPct=tiltV/255*100;
    ptSec.innerHTML=`<div style="font-family:var(--ui);font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--text2);margin-bottom:6px">Pan / Tilt</div>
      <div style="display:flex;gap:10px;align-items:flex-start">
        <div id="ml-xy-pad" style="width:120px;height:120px;background:var(--bg3);border:1px solid var(--border2);border-radius:4px;position:relative;cursor:crosshair;flex-shrink:0;touch-action:none"
          onpointerdown="mlXYPointerDown(event)" onpointermove="mlXYPointerMove(event)" onpointerup="mlXYPointerUp(event)">
          <div style="position:absolute;top:50%;left:50%;width:1px;height:100%;background:rgba(255,255,255,0.08);transform:translateX(-50%)"></div>
          <div style="position:absolute;top:50%;left:0;width:100%;height:1px;background:rgba(255,255,255,0.08);transform:translateY(-50%)"></div>
          <div id="ml-xy-dot" style="position:absolute;left:${pPct}%;top:${tPct}%;width:12px;height:12px;border-radius:50%;background:var(--accent2);border:2px solid #fff;transform:translate(-50%,-50%);pointer-events:none"></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;flex:1">
          ${mlSliderHTML('Pan','pan',panV,0,255,'var(--accent)')}
          ${mlSliderHTML('Tilt','tilt',tiltV,0,255,'var(--accent)')}
        </div>
      </div>`;
    wrap.appendChild(ptSec);
  }

  // ── Gobo ──
  if(f?.gobo!=null){
    // Get gobo names from GDTF profile if available
    const gobos=mlGetGobos(f);
    const goboSec=document.createElement('div');
    goboSec.innerHTML=`<div style="font-family:var(--ui);font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--text2);margin-bottom:6px">Gobo</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px">
        ${gobos.map((g,i)=>`<button onclick="mlSetParam('gobo',${g.val})" style="background:${f.gobo===g.val?'var(--accent2)':'var(--bg3)'};border:1px solid ${f.gobo===g.val?'var(--accent2)':'var(--border2)'};color:${f.gobo===g.val?'#000':'var(--text1)'};font-family:var(--mono);font-size:9px;padding:3px 8px;cursor:pointer;border-radius:2px;min-width:36px">${g.name}</button>`).join('')}
      </div>`;
    goboSec.appendChild(mlSlider('Gobo','gobo',f.gobo,0,255,'var(--accent2)'));
    wrap.appendChild(goboSec);
  }

  // ── Other params ──
  const others=[['Zoom','zoom'],['Focus','focus'],['Shutter','shutter'],['Strobe','strobe'],['Speed','speed'],['Iris','iris']];
  others.forEach(([label,param])=>{
    if(f?.[param]!=null) wrap.appendChild(mlSliderSection(label,param,f[param],0,255));
  });
}

function mlSliderSection(label, param, val, min, max){
  const d=document.createElement('div');
  d.appendChild(mlSlider(label,param,val,min,max,'var(--accent)'));
  return d;
}
function mlSlider(label, param, val, min, max, color){
  const d=document.createElement('div');
  d.style.cssText='display:flex;align-items:center;gap:8px;margin-bottom:4px';
  d.innerHTML=`<span style="font-family:var(--mono);font-size:9px;color:var(--text2);min-width:38px">${label}</span>
    <input type="range" min="${min}" max="${max}" value="${val}" style="flex:1;accent-color:${color};height:4px;cursor:pointer"
      oninput="mlSetParam('${param}',parseInt(this.value));this.nextElementSibling.textContent=this.value">
    <span style="font-family:var(--mono);font-size:9px;color:var(--text1);min-width:24px;text-align:right">${val}</span>`;
  return d;
}
function mlSliderHTML(label, param, val, min, max, color){
  return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
    <span style="font-family:var(--mono);font-size:9px;color:var(--text2);min-width:28px">${label}</span>
    <input type="range" min="${min}" max="${max}" value="${val}" style="flex:1;accent-color:${color};height:4px;cursor:pointer"
      oninput="mlSetParam('${param}',parseInt(this.value));this.nextElementSibling.textContent=this.value">
    <span style="font-family:var(--mono);font-size:9px;color:var(--text1);min-width:24px;text-align:right">${val}</span>
  </div>`;
}
function mlGetGobos(fixture){
  // Try GDTF profile first
  if(fixture.profileId&&gdtfState?.profiles){
    const profile=gdtfState.profiles.find(p=>p.id===fixture.profileId);
    if(profile?.gobos?.length) return profile.gobos;
  }
  // Default gobo list
  return [{name:'Open',val:0},{name:'1',val:30},{name:'2',val:60},{name:'3',val:90},{name:'4',val:120},{name:'5',val:150},{name:'6',val:180},{name:'7',val:210},{name:'Spin',val:240}];
}

// XY pad pointer handling
let _mlXYDragging=false;
function mlXYPointerDown(e){
  _mlXYDragging=true; e.target.setPointerCapture(e.pointerId);
  mlXYApply(e);
}
function mlXYPointerMove(e){ if(!_mlXYDragging) return; mlXYApply(e); }
function mlXYPointerUp(e){ _mlXYDragging=false; }
function mlXYApply(e){
  const pad=document.getElementById('ml-xy-pad'); if(!pad) return;
  const rect=pad.getBoundingClientRect();
  const panV=Math.max(0,Math.min(255,Math.round((e.clientX-rect.left)/rect.width*255)));
  const tiltV=Math.max(0,Math.min(255,Math.round((e.clientY-rect.top)/rect.height*255)));
  mlSetParam('pan',panV); mlSetParam('tilt',tiltV);
  const dot=document.getElementById('ml-xy-dot');
  if(dot){dot.style.left=(panV/255*100)+'%';dot.style.top=(tiltV/255*100)+'%';}
}

function buildAIPanel(body, ctrl) {
  // Toolbar buttons
  const autoBtn = document.createElement('button');
  autoBtn.id='ai-auto-btn';
  autoBtn.title='Auto-execute generated commands';
  autoBtn.style.cssText='background:var(--accent3);border:1px solid var(--accent3);color:#000;font-family:var(--ui);font-weight:700;font-size:9px;letter-spacing:1px;padding:2px 8px;cursor:pointer;border-radius:2px;text-transform:uppercase';
  autoBtn.textContent='AUTO ON';
  autoBtn.onclick=()=>{
    aiState.autoExecute=!aiState.autoExecute;
    autoBtn.textContent=aiState.autoExecute?'AUTO ON':'AUTO OFF';
    autoBtn.style.background=aiState.autoExecute?'var(--accent3)':'var(--bg3)';
    autoBtn.style.color=aiState.autoExecute?'#000':'var(--text2)';
    autoBtn.style.borderColor=aiState.autoExecute?'var(--accent3)':'var(--border2)';
  };
  ctrl.appendChild(autoBtn);

  const clearBtn = document.createElement('button');
  clearBtn.textContent='Clear';
  clearBtn.style.cssText='background:var(--bg3);border:1px solid var(--border2);color:var(--text2);font-family:var(--ui);font-weight:700;font-size:9px;padding:2px 8px;cursor:pointer;border-radius:2px;text-transform:uppercase;margin-left:4px';
  clearBtn.onclick=()=>{ aiState.history=[]; const log=document.getElementById('ai-log'); if(log) log.innerHTML=''; };
  ctrl.appendChild(clearBtn);

  // Main layout
  const wrap = document.createElement('div');
  wrap.style.cssText='flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden';

  // API key warning if not set
  const keyWarn = document.createElement('div');
  keyWarn.id='ai-key-warn';
  keyWarn.style.cssText=`display:${aiGetKey()?'none':'flex'};align-items:center;gap:8px;padding:6px 10px;background:rgba(224,160,48,0.1);border-bottom:1px solid var(--accent2);flex-shrink:0`;
  keyWarn.innerHTML=`<span style="font-family:var(--ui);font-size:9px;color:var(--accent2)">⚠ No API key set.</span>
    <button onclick="switchTab('settings');setTimeout(()=>document.getElementById('ai-key-input')?.focus(),200)" style="background:none;border:1px solid var(--accent2);color:var(--accent2);font-family:var(--ui);font-size:9px;padding:1px 8px;cursor:pointer;border-radius:2px">Set in Settings →</button>`;
  wrap.appendChild(keyWarn);

  // Chat log
  const log = document.createElement('div');
  log.id='ai-log';
  log.style.cssText='flex:1;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:8px;min-height:0';
  // Welcome message
  const welcome = document.createElement('div');
  welcome.style.cssText='color:var(--text2);font-family:var(--ui);font-size:10px;text-align:center;padding:16px 8px;line-height:1.6';
  welcome.innerHTML=`<div style="font-size:20px;margin-bottom:8px">✦</div>
    <div style="font-weight:700;color:var(--text1);margin-bottom:4px">LightScript AI Agent</div>
    <div>Ask me anything about your show.<br>I can program cues, adjust fixtures,<br>build timelines, and run commands live.</div>`;
  log.appendChild(welcome);
  wrap.appendChild(log);

  // Input row
  const inputRow = document.createElement('div');
  inputRow.style.cssText='display:flex;gap:4px;padding:6px 8px;background:var(--bg2);border-top:1px solid var(--border);flex-shrink:0';
  const ta = document.createElement('textarea');
  ta.id='ai-input';
  ta.placeholder='Ask me to control your lights…';
  ta.rows=2;
  ta.style.cssText='flex:1;background:var(--bg3);border:1px solid var(--border2);color:var(--text0);font-family:var(--mono);font-size:11px;padding:6px 8px;border-radius:3px;resize:none;outline:none;line-height:1.4';
  ta.addEventListener('keydown', e=>{
    if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();aiSend();}
  });
  ta.addEventListener('focus',()=>ta.style.borderColor='var(--accent)');
  ta.addEventListener('blur', ()=>ta.style.borderColor='var(--border2)');
  const sendBtn = document.createElement('button');
  sendBtn.id='ai-send-btn';
  sendBtn.textContent='▶';
  sendBtn.title='Send (Enter)';
  sendBtn.style.cssText='background:var(--accent);border:none;color:#000;font-weight:700;font-size:13px;width:32px;cursor:pointer;border-radius:3px;flex-shrink:0;align-self:stretch';
  sendBtn.onclick=aiSend;
  inputRow.appendChild(ta);
  inputRow.appendChild(sendBtn);
  wrap.appendChild(inputRow);
  body.appendChild(wrap);
}

function aiAppendMessage(role, content, isStreaming=false) {
  const log=document.getElementById('ai-log'); if(!log) return null;
  const isUser = role==='user';
  const div=document.createElement('div');
  div.style.cssText=`display:flex;flex-direction:column;gap:3px;align-items:${isUser?'flex-end':'flex-start'}`;
  const bubble=document.createElement('div');
  bubble.style.cssText=`max-width:90%;padding:7px 10px;border-radius:${isUser?'10px 10px 2px 10px':'10px 10px 10px 2px'};font-family:${isUser?'var(--ui)':'var(--mono)'};font-size:10px;line-height:1.5;word-break:break-word;background:${isUser?'var(--accent)':'var(--bg3)'};color:${isUser?'#000':'var(--text0)'};border:1px solid ${isUser?'var(--accent)':'var(--border2)'}`;
  if(isStreaming) bubble.id='ai-streaming-bubble';
  bubble.innerHTML=aiRenderContent(content);
  div.appendChild(bubble);
  log.appendChild(div);
  log.scrollTop=log.scrollHeight;
  return bubble;
}

function aiRenderContent(text) {
  // Render markdown-lite: code blocks, bold, newlines
  return text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/```lightscript\n?([\s\S]*?)```/g, (_,code)=>{
      const cmds=code.trim().split('\n').filter(l=>l.trim()&&!l.trim().startsWith('//'));
      const escaped=code.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
      return `<div style="background:var(--bg1);border:1px solid var(--accent3);border-radius:3px;padding:6px 8px;margin:4px 0;font-family:var(--mono);font-size:9px;color:var(--accent3);white-space:pre-wrap">${code.trim()}</div>`+
        (cmds.length?`<button onclick="aiExecuteBlock(${JSON.stringify(escaped)})" style="background:var(--accent3);border:none;color:#000;font-family:var(--ui);font-weight:700;font-size:9px;padding:3px 10px;cursor:pointer;border-radius:2px;margin-top:2px">▶ Run ${cmds.length} command${cmds.length>1?'s':''}</button>`:'');
    })
    .replace(/```\n?([\s\S]*?)```/g,'<div style="background:var(--bg1);border:1px solid var(--border);border-radius:3px;padding:5px 8px;margin:3px 0;font-size:9px;white-space:pre-wrap">$1</div>')
    .replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')
    .replace(/\n/g,'<br>');
}

function aiExecuteBlock(code) {
  const lines=code.split('\n').filter(l=>l.trim()&&!l.trim().startsWith('//'));
  lines.forEach(cmd=>{ try{parseCommand(cmd.trim());}catch(e){} });
  logHistory('·',`AI executed ${lines.length} command${lines.length>1?'s':''}`, 'ok');
}

async function aiSend() {
  if(aiState.streaming) return;
  const ta=document.getElementById('ai-input'); if(!ta) return;
  const text=ta.value.trim(); if(!text) return;
  ta.value='';
  aiAppendMessage('user', text);
  aiState.history.push({role:'user', content:text});
  const typingDiv=document.createElement('div');
  typingDiv.id='ai-typing';
  typingDiv.style.cssText='display:flex;gap:3px;padding:8px 10px;align-items:center';
  typingDiv.innerHTML='<span style="font-family:var(--ui);font-size:9px;color:var(--text2)">Ollama thinking…</span>';
  const log=document.getElementById('ai-log'); if(log){log.appendChild(typingDiv);log.scrollTop=log.scrollHeight;}
  const btn=document.getElementById('ai-send-btn'); if(btn){btn.disabled=true;btn.style.opacity='0.4';}
  aiState.streaming=true;
  try{
    const bubble=aiAppendMessage('assistant','',true);
    typingDiv.remove();
    const fullText=await aiCall(text,(txt)=>{
      if(bubble)bubble.innerHTML=aiRenderContent(txt);
      if(log)log.scrollTop=log.scrollHeight;
    });
    if(bubble)bubble.id='';
    aiState.history.push({role:'assistant',content:fullText});
    if(aiState.autoExecute){
      const codeBlocks=[...fullText.matchAll(/```lightscript\n?([\s\S]*?)```/g)];
      if(codeBlocks.length){let total=0;codeBlocks.forEach(m=>{const lines=m[1].trim().split('\n').filter(l=>l.trim()&&!l.trim().startsWith('//'));lines.forEach(cmd=>{try{parseCommand(cmd.trim());}catch(e){}total++;});});if(total)logHistory('·',`AI ran ${total} command${total>1?'s':''}`, 'ok');}
    }
  }catch(err){
    try{typingDiv.remove();}catch(_){}
    aiAppendMessage('assistant',`⚠ Ollama error: ${err.message}\n\nMake sure Ollama is running:\n  ollama serve\nAnd pull a model:\n  ollama pull llama3`);
  }finally{
    aiState.streaming=false;
    if(btn){btn.disabled=false;btn.style.opacity='1';}
    const ta2=document.getElementById('ai-input'); if(ta2) ta2.focus();
  }
}

// Open AI panel as floating overlay if not in a quadrant
function openAIOverlay() {
  const ov=document.getElementById('ai-overlay');
  if(ov) { ov.style.display=ov.style.display==='flex'?'none':'flex'; return; }
}

// ─── STAGE OBJECTS ────────────────────────────────────────────────────────────
let _editingStageObjId=null;
function openStageObjectModal(id){
  _editingStageObjId=id??null;
  const obj=id!=null?(state.stageObjects||[]).find(o=>o.id===id):null;
  document.getElementById('so-label').value=obj?.label||'';
  document.getElementById('so-type').value=obj?.type||'box';
  document.getElementById('so-x').value=obj?.x??0;
  document.getElementById('so-y').value=obj?.y??0;
  document.getElementById('so-z').value=obj?.z??0;
  document.getElementById('so-w').value=obj?.w??200;
  document.getElementById('so-h').value=obj?.h??100;
  document.getElementById('so-d').value=obj?.d??200;
  document.getElementById('so-color').value=obj?.color||'rgba(100,140,220,0.7)';
  rebuildStageObjectList();
  document.getElementById('stage-obj-overlay').style.display='flex';
}
function closeStageObjectModal(){document.getElementById('stage-obj-overlay').style.display='none';_editingStageObjId=null;}
function applyStageObject(){
  if(!state.stageObjects) state.stageObjects=[];
  const obj={
    id:_editingStageObjId??('so_'+Date.now()),
    label:document.getElementById('so-label').value||'',
    type:document.getElementById('so-type').value||'box',
    x:parseFloat(document.getElementById('so-x').value)||0,
    y:parseFloat(document.getElementById('so-y').value)||0,
    z:parseFloat(document.getElementById('so-z').value)||0,
    w:parseFloat(document.getElementById('so-w').value)||200,
    h:parseFloat(document.getElementById('so-h').value)||100,
    d:parseFloat(document.getElementById('so-d').value)||200,
    color:document.getElementById('so-color').value||'rgba(100,140,220,0.7)',
  };
  if(_editingStageObjId){const i=state.stageObjects.findIndex(o=>o.id===_editingStageObjId);if(i>=0)state.stageObjects[i]=obj;else state.stageObjects.push(obj);}
  else{state.stageObjects.push(obj);}
  _editingStageObjId=obj.id;
  rebuildStageObjectList(); draw3D();
}
function deleteStageObject(id){
  state.stageObjects=(state.stageObjects||[]).filter(o=>o.id!==id);
  if(_editingStageObjId===id){_editingStageObjId=null;document.getElementById('so-label').value='';document.getElementById('so-type').value='box';}
  rebuildStageObjectList(); draw3D();
}
function rebuildStageObjectList(){
  const list=document.getElementById('so-list'); if(!list) return;
  list.innerHTML='';
  (state.stageObjects||[]).forEach(obj=>{
    const row=document.createElement('div');
    row.style.cssText='display:flex;align-items:center;gap:6px;margin-bottom:4px';
    row.innerHTML=`<span style="font-family:var(--mono);font-size:10px;color:var(--text1);flex:1;cursor:pointer">${obj.label||obj.id} <span style="color:var(--text2)">[${obj.type}]</span></span>
      <button onclick="openStageObjectModal('${obj.id}')" style="background:var(--bg3);border:1px solid var(--border2);color:var(--text2);font-family:var(--ui);font-size:9px;padding:1px 6px;cursor:pointer;border-radius:2px">Edit</button>
      <button onclick="deleteStageObject('${obj.id}')" style="background:var(--bg3);border:1px solid var(--border2);color:var(--danger);font-family:var(--ui);font-size:9px;padding:1px 6px;cursor:pointer;border-radius:2px">✕</button>`;
    list.appendChild(row);
  });
}

// ─── LINK EDITOR ──────────────────────────────────────────────────────────────
let _editingLinkIdx=null;
function openLinkEditor(editIdx){
  _editingLinkIdx=editIdx??null;const l=editIdx!=null?state.links[editIdx]:null;
  document.getElementById('le-source').value=l?.source||'';document.getElementById('le-target').value=l?.target||'';
  document.getElementById('le-source').style.borderColor='';document.getElementById('le-target').style.borderColor='';
  document.getElementById('link-editor-overlay').style.display='flex';
  setTimeout(()=>document.getElementById('le-source').focus(),50);
}
function closeLinkEditor(){document.getElementById('link-editor-overlay').style.display='none';_editingLinkIdx=null;}
function confirmAddLink(){
  const src=document.getElementById('le-source').value.trim(),tgt=document.getElementById('le-target').value.trim();
  if(!src){document.getElementById('le-source').style.borderColor='var(--danger)';return;}
  if(!tgt){document.getElementById('le-target').style.borderColor='var(--danger)';return;}
  const m=src.match(/\$([^$]+)\$/g),varName=m?m.map(v=>v.slice(1,-1)).join(','):'';
  const link={source:src,varName,target:tgt};
  if(_editingLinkIdx!=null){state.links[_editingLinkIdx]=link;logHistory('·','Link updated','ok');}
  else{state.links.push(link);logHistory('·',`Link: ${src} → ${tgt}`,'ok');}
  renderLinks();closeLinkEditor();
}
function editLink(i){openLinkEditor(i);}

// ─── EFFECTS ENGINE (GrandMA3-style) ─────────────────────────────────────────
// Each effect runs a continuous waveform on a parameter across a set of fixtures
// with per-fixture phase offset, speed, size, and base value.
// effect = { name, param, waveform, speed, size, offset, base, fixtures:[] }
// waveforms: sine, saw, rampup, rampdown, square, random, pulse, swing

const effectRuntime = {}; // key -> { raf, startMs, lastRandom:{} }

const WAVEFORMS = {
  sine:    (ph) => Math.sin(ph * Math.PI * 2),
  saw:     (ph) => (ph % 1) * 2 - 1,
  rampup:  (ph) => (ph % 1) * 2 - 1,
  rampdown:(ph) => 1 - (ph % 1) * 2,
  square:  (ph) => (ph % 1) < 0.5 ? 1 : -1,
  pulse:   (ph) => (ph % 1) < 0.2 ? 1 : -1,
  swing:   (ph) => Math.sin(ph * Math.PI),
  random:  ()   => Math.random() * 2 - 1,
};

function efxStart(key) {
  const efx = state.effects[key]; if (!efx) return;
  efxStop(key);
  effectRuntime[key] = { startMs: performance.now(), lastRandom: {}, lastRandomTime: {}, stepIdx: {}, stepTime: {} };
  const rt = effectRuntime[key];

  if ((efx.type || 'waveform') === 'step') {
    // ── Step mode: cycle through steps per fixture with hold times ──────────
    const steps = efx.steps || [];
    if (!steps.length) { logHistory('!', `Effect "${key}" has no steps`, 'err'); return; }
    const fixtures = efx.fixtures || [];
    const totalCycleDur = steps.reduce((s, st) => s + (st.holdMs || 500), 0);
    const offsetMs = efx.offsetStep > 0 ? totalCycleDur * efx.offsetStep : 0;

    // Fire step 0 for all fixtures immediately (staggered)
    fixtures.forEach((fid, fi) => {
      rt.stepIdx[fid] = 0;
      rt.stepTime[fid] = performance.now() - fi * offsetMs;
      const step = steps[0]; if (!step?.cmd) return;
      const prevSel = new Set(state.selected);
      state.selected = new Set([fid]);
      try { parseCommand(step.cmd); } catch(e) {}
      state.selected = prevSel;
    });

    const tick = () => {
      const rt2 = effectRuntime[key]; if (!rt2) return;
      const now = performance.now();
      fixtures.forEach(fid => {
        let si = rt2.stepIdx[fid] || 0;
        const step = steps[si];
        if (!step) return;
        const elapsed = now - (rt2.stepTime[fid] || now);
        if (elapsed >= (step.holdMs || 500)) {
          si = (si + 1) % steps.length;
          rt2.stepIdx[fid] = si;
          rt2.stepTime[fid] = now;
          const nextStep = steps[si];
          if (nextStep?.cmd) {
            const prevSel = new Set(state.selected);
            state.selected = new Set([fid]);
            try { parseCommand(nextStep.cmd); } catch(e) {}
            state.selected = prevSel;
          }
        }
      });
      renderFixtures(); drawIfVisible();
      rt2.raf = requestAnimationFrame(tick);
    };
    rt.raf = requestAnimationFrame(tick);
    logHistory('·', `Effect "${key}" ▶ step mode — ${steps.length} steps, ${fixtures.length} fixtures`, 'ok');
    return;
  }

  // ── Waveform mode ──────────────────────────────────────────────────────────
  const tick = () => {
    const rt2 = effectRuntime[key]; if (!rt2) return;
    const elapsed = (performance.now() - rt2.startMs) / 1000;
    const speed = efx.speed ?? 1, size = efx.size ?? 127, base = efx.base ?? 127;
    const nFix = (efx.fixtures || []).length || 1;
    let offsetStep;
    if (efx.offsetStep == null || efx.offsetStep === '') offsetStep = 1 / nFix;
    else if (efx.offsetStep === 0) offsetStep = 0;
    else if (efx.offsetStep > 1)  offsetStep = 1 / efx.offsetStep;
    else offsetStep = efx.offsetStep;
    const phaseOffset = efx.phaseOffset ?? 0;
    const wfn = WAVEFORMS[efx.waveform || 'sine'] || WAVEFORMS.sine;
    (efx.fixtures || []).forEach((fid, i) => {
      const f = state.fixtures.find(x => x.id === fid); if (!f) return;
      const phase = (elapsed * speed + i * offsetStep + phaseOffset) % 1;
      let raw;
      if (efx.waveform === 'random') {
        const cycle = Math.floor(elapsed * speed + i * offsetStep);
        if (rt2.lastRandomTime[fid] !== cycle) { rt2.lastRandom[fid] = Math.random() * 2 - 1; rt2.lastRandomTime[fid] = cycle; }
        raw = rt2.lastRandom[fid];
      } else { raw = wfn(phase); }
      const val = Math.max(0, Math.min(255, Math.round(base + raw * size)));
      if (f[efx.param] !== undefined) f[efx.param] = val;
    });
    renderFixtures(); drawIfVisible();
    rt2.raf = requestAnimationFrame(tick);
  };
  rt.raf = requestAnimationFrame(tick);
  logHistory('·', `Effect "${key}" ▶ ${efx.waveform||'sine'} on ${efx.param} — ${(efx.fixtures||[]).length} fixtures`, 'ok');
}

function efxStop(key) {
  const rt = effectRuntime[key];
  if (rt?.raf) cancelAnimationFrame(rt.raf);
  delete effectRuntime[key];
}

function efxStopAll() {
  Object.keys(effectRuntime).forEach(efxStop);
  logHistory('·', 'All effects stopped', 'info');
}

function efxIsRunning(key) { return !!effectRuntime[key]; }

// ── Effect Editor Panel ───────────────────────────────────────────────────────
let _efxEditKey = null;

function openEffectEditor(key) {
  _efxEditKey = key || null;
  const efx = key ? state.effects[key] : null;
  const overlay = document.getElementById('effect-editor-overlay'); if (!overlay) return;

  const mode = efx?.type || 'waveform';
  // Set mode tabs
  document.getElementById('ee-tab-waveform')?.classList.toggle('ee-tab-active', mode === 'waveform');
  document.getElementById('ee-tab-step')?.classList.toggle('ee-tab-active', mode === 'step');
  document.getElementById('ee-waveform-panel').style.display = mode === 'waveform' ? '' : 'none';
  document.getElementById('ee-step-panel').style.display = mode === 'step' ? '' : 'none';

  document.getElementById('ee-name').value = key || ('EFX_' + (Object.keys(state.effects).length + 1));
  document.getElementById('ee-param').value = efx?.param || 'dimmer';
  document.getElementById('ee-waveform').value = efx?.waveform || 'sine';
  document.getElementById('ee-speed').value = efx?.speed || 1;
  document.getElementById('ee-size').value = efx?.size ?? 127;
  document.getElementById('ee-base').value = efx?.base ?? 127;
  document.getElementById('ee-offset').value = efx?.offsetStep ?? '';
  document.getElementById('ee-step-offset').value = efx?.offsetStep ?? '';
  document.getElementById('ee-phase').value = efx?.phaseOffset || 0;

  // Step list
  _efxSteps = (efx?.steps || []).map(s => ({ ...s }));
  efxRenderSteps();

  // Fixture list
  const selIds = new Set(efx?.fixtures || [...state.selected]);
  const fixList = document.getElementById('ee-fix-list');
  if (fixList) {
    fixList.innerHTML = '';
    state.fixtures.forEach(f => {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;font-family:var(--mono);font-size:10px;color:var(--text1);cursor:pointer;padding:2px 0';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = f.id; cb.checked = selIds.has(f.id);
      row.appendChild(cb); row.appendChild(document.createTextNode(`FIX ${f.id} — ${f.name || f.type || ''}`));
      fixList.appendChild(row);
    });
  }

  overlay.style.display = 'flex';
  renderEffectsList();
  document.getElementById('ee-name')?.focus();
}

function efxSwitchTab(mode) {
  document.getElementById('ee-tab-waveform')?.classList.toggle('ee-tab-active', mode === 'waveform');
  document.getElementById('ee-tab-step')?.classList.toggle('ee-tab-active', mode === 'step');
  document.getElementById('ee-waveform-panel').style.display = mode === 'waveform' ? '' : 'none';
  document.getElementById('ee-step-panel').style.display = mode === 'step' ? '' : 'none';
}

// Step editor state
let _efxSteps = [];

function efxRenderSteps() {
  const list = document.getElementById('ee-step-list'); if (!list) return;
  list.innerHTML = '';
  _efxSteps.forEach((s, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:1fr 80px 24px;gap:5px;align-items:center;margin-bottom:4px';
    row.innerHTML = `
      <input value="${escHTML(s.cmd||'')}" oninput="_efxSteps[${i}].cmd=this.value" placeholder="SET SEL dimmer 255" class="modal-input" style="font-family:var(--mono);font-size:10px;padding:3px 6px">
      <input type="number" value="${s.holdMs||500}" oninput="_efxSteps[${i}].holdMs=parseInt(this.value)||500" placeholder="500ms" class="modal-input" style="font-family:var(--mono);font-size:10px;padding:3px 6px">
      <button onclick="_efxSteps.splice(${i},1);efxRenderSteps()" style="background:none;border:none;color:var(--danger);font-size:11px;cursor:pointer">✕</button>`;
    list.appendChild(row);
  });
  if (!_efxSteps.length) list.innerHTML = '<div style="color:var(--text2);font-family:var(--mono);font-size:10px;padding:8px 0">No steps yet — click Add Step</div>';
}

function efxAddStep() {
  _efxSteps.push({ cmd: 'SET SEL dimmer 255', holdMs: 500 });
  efxRenderSteps();
}

function closeEffectEditor() { document.getElementById('effect-editor-overlay').style.display = 'none'; _efxEditKey = null; }

function saveEffectEdit() {
  const name = document.getElementById('ee-name').value.trim(); if (!name) return;
  const mode = document.getElementById('ee-step-panel').style.display === 'none' ? 'waveform' : 'step';
  const selBoxes = document.querySelectorAll('#ee-fix-list input[type=checkbox]:checked');
  const fixtures = [...selBoxes].map(cb => parseInt(cb.value));
  const efx = {
    type:        mode,
    param:       document.getElementById('ee-param').value,
    waveform:    document.getElementById('ee-waveform').value,
    speed:       parseFloat(document.getElementById('ee-speed').value) || 1,
    size:        parseInt(document.getElementById('ee-size').value)   ?? 127,
    base:        parseInt(document.getElementById('ee-base').value)   ?? 127,
    offsetStep:  mode === 'step'
      ? (document.getElementById('ee-step-offset').value === '' ? null : parseFloat(document.getElementById('ee-step-offset').value))
      : (document.getElementById('ee-offset').value === '' ? null : parseFloat(document.getElementById('ee-offset').value)),
    phaseOffset: parseFloat(document.getElementById('ee-phase').value) ?? 0,
    steps:       mode === 'step' ? _efxSteps.filter(s => s.cmd?.trim()) : [],
    fixtures,
  };
  if (_efxEditKey && _efxEditKey !== name) { efxStop(_efxEditKey); delete state.effects[_efxEditKey]; }
  state.effects[name] = efx;
  closeEffectEditor();
  const detail = mode === 'step' ? `${efx.steps.length} steps` : `${efx.waveform} on ${efx.param}`;
  logHistory('·', `Effect "${name}" saved [${mode}] — ${detail}, ${fixtures.length} fixtures`, 'ok');
  renderEffectsList();
}

function renderEffectsList() {
  const list = document.getElementById('effects-list'); if (!list) return;
  list.innerHTML = '';
  Object.entries(state.effects).forEach(([key, efx]) => {
    const running = efxIsRunning(key);
    const row = document.createElement('div');
    row.style.cssText = `display:flex;align-items:center;gap:6px;padding:5px 8px;border-bottom:1px solid var(--border);background:${running ? 'rgba(80,200,120,0.05)' : 'transparent'}`;
    row.innerHTML = `
      <div style="width:8px;height:8px;border-radius:50%;background:${running ? 'var(--accent3)' : 'var(--border2)'}"></div>
      <span style="font-family:var(--mono);font-size:10px;color:${running ? 'var(--accent3)' : 'var(--text0)'};flex:1">${key}</span>
      <span style="font-family:var(--mono);font-size:9px;color:var(--text2)">${efx.waveform||'sine'} · ${efx.param} · ${efx.speed||1}Hz · ${efx.fixtures?.length||0}f</span>
      <button onclick="efxStart('${key}')" style="background:${running ? 'var(--bg3)' : 'var(--accent3)'};border:none;color:${running ? 'var(--text2)' : '#000'};font-family:var(--ui);font-size:9px;padding:2px 8px;cursor:pointer;border-radius:2px">${running ? '▶' : '▶'}</button>
      <button onclick="efxStop('${key}');renderEffectsList()" style="background:var(--bg3);border:1px solid var(--border2);color:var(--text2);font-family:var(--ui);font-size:9px;padding:2px 8px;cursor:pointer;border-radius:2px">■</button>
      <button onclick="openEffectEditor('${key}')" style="background:var(--bg3);border:1px solid var(--border2);color:var(--text2);font-family:var(--ui);font-size:9px;padding:2px 6px;cursor:pointer;border-radius:2px">✎</button>
      <button onclick="deleteEffect('${key}')" style="background:none;border:none;color:var(--danger);font-size:10px;cursor:pointer;padding:0 2px">✕</button>`;
    list.appendChild(row);
  });
  if (!Object.keys(state.effects).length) list.innerHTML = '<div style="color:var(--text2);font-size:11px;padding:12px 8px">No effects stored — click + New or type EFFECT in the command line</div>';
}

function deleteEffect(key) { efxStop(key); delete state.effects[key]; renderEffectsList(); }

// Handle EFFECT command from command line: EFFECT <name> — fire a stored effect
function handleEffectCommand(parts, raw) {
  const sub = parts[1]?.toUpperCase();
  const name = parts.slice(2).join(' ');
  if (sub === 'START' || sub === 'RUN' || sub === 'PLAY') { efxStart(name); return; }
  if (sub === 'STOP') { if (name) efxStop(name); else efxStopAll(); return; }
  if (sub === 'STOPALL') { efxStopAll(); return; }
  if (sub === 'LIST') { logHistory('·', 'Effects: ' + Object.keys(state.effects).join(', '), 'info'); return; }
  if (sub === 'DELETE' || sub === 'DEL') { deleteEffect(name); return; }
  if (sub === 'NEW' || !sub) { openEffectEditor(null); return; }
  // EFFECT <name> — start it if it exists, otherwise open editor
  const fullName = parts.slice(1).join(' ');
  if (state.effects[fullName]) { efxStart(fullName); logHistory('>', raw, 'ok'); }
  else { openEffectEditor(null); }
}
// ─── ELECTRON BRIDGE ──────────────────────────────────────────────────────────
// ─── LICENSE SYSTEM ───────────────────────────────────────────────────────────
async function licenseInit() {
  if (!window.electronAPI?.licenseLoad) { updateLicenseBadge(); return; }
  const lic = await window.electronAPI.licenseLoad();
  Object.assign(licenseState, lic);
  updateLicenseBadge();
  const ov = document.getElementById('license-overlay');
  if (ov) { licUpdateOverlay(); ov.style.display = 'flex'; }
}

function licUpdateOverlay() {
  const planName     = document.getElementById('lic-plan-name');
  const planChannels = document.getElementById('lic-plan-channels');
  const planBadge    = document.getElementById('lic-plan-badge');
  const deactRow     = document.getElementById('lic-deactivate-row');
  const continueBtn  = document.getElementById('lic-continue-btn');
  if (planName)     planName.textContent     = licenseState.label || 'Free';
  if (planChannels) planChannels.textContent = `${licenseState.channels} channels`;
  if (planBadge)    planBadge.textContent    = (licenseState.label||'FREE').toUpperCase();
  if (deactRow)     deactRow.style.display   = licenseState.activated ? 'block' : 'none';
  if (continueBtn)  continueBtn.textContent  = licenseState.activated
    ? `Launch LightScript (${licenseState.label})`
    : 'Continue with Free Plan';
}

async function licActivate() {
  const input=document.getElementById('lic-key-input');
  const errEl=document.getElementById('lic-error');
  const sucEl=document.getElementById('lic-success');
  const btn=document.getElementById('lic-activate-btn');
  if (!input||!input.value.trim()) return;
  if (errEl) errEl.style.display='none';
  if (sucEl) sucEl.style.display='none';
  if (btn) {btn.textContent='…';btn.disabled=true;}
  try {
    const result=window.electronAPI
      ? await window.electronAPI.licenseActivate(input.value.trim())
      : {ok:false,error:'No Electron API'};
    if (result.ok) {
      Object.assign(licenseState, result, {activated:true});
      updateLicenseBadge(); licUpdateOverlay(); input.value='';
      if (sucEl){sucEl.textContent=`✓ ${result.label} license activated — ${result.channels} channels unlocked`;sucEl.style.display='block';}
    } else {
      if (errEl){errEl.textContent='✕ '+result.error;errEl.style.display='block';}
    }
  } finally {
    if (btn){btn.textContent='Activate';btn.disabled=false;}
  }
}

async function licDeactivate() {
  if (!confirm('Remove this license? The app will revert to the Free plan (25 channels).')) return;
  if (window.electronAPI) await window.electronAPI.licenseDeactivate();
  Object.assign(licenseState,{plan:'free',channels:25,label:'Free',activated:false,email:'',id:''});
  updateLicenseBadge(); licUpdateOverlay();
  const sucEl=document.getElementById('lic-success');
  if (sucEl){sucEl.textContent='License removed. Running on Free plan.';sucEl.style.display='block';}
}

function licContinue() {
  const ov=document.getElementById('license-overlay');
  if (ov) ov.style.display='none';
  logHistory('·',`LightScript ${licenseState.label} — ${licenseState.channels} channels`,'ok');
}

function updateLicenseBadge() {
  const badge=document.getElementById('license-plan-badge');
  if (badge){badge.textContent=licenseState.label;badge.style.color=licenseState.plan==='free'?'var(--text2)':'#c090ff';}
  const chBadge=document.getElementById('license-ch-badge');
  if (chBadge) chBadge.textContent=licenseState.channels+' channels';
}

async function licPasteKey() {
  const input = document.getElementById('lic-key-input');
  if (!input) return;
  try {
    // Try Electron clipboard first via IPC
    if (window.electronAPI?.clipboardRead) {
      const text = await window.electronAPI.clipboardRead();
      if (text) { input.value = text.trim(); input.focus(); return; }
    }
    // Fallback to browser clipboard API
    const text = await navigator.clipboard.readText();
    if (text) input.value = text.trim();
    input.focus();
  } catch(e) {
    // Last resort: focus and let user Ctrl+V manually
    input.focus();
    input.select();
    logHistory('·', 'Click the key field and press Ctrl+V (or Cmd+V on Mac)', 'info');
  }
}
function licGetChannelLimit(){return licenseState.channels;}
function licCheckChannelCount(maxCh){ return maxCh <= licenseState.channels; }
function openLicenseOverlay(){ const ov=document.getElementById('license-overlay'); if(ov){licUpdateOverlay();ov.style.display='flex';} }
function openLicenseOverlay(){const ov=document.getElementById('license-overlay');if(ov){licUpdateOverlay();ov.style.display='flex';}}

// ─────────────────────────────────────────────────────────────────────────────
function setupElectronMenuBridge() {
  if(!window.electronAPI) return;
  window.electronAPI.onMenuAction(async(action,data)=>{
    switch(action){
      case 'new-show': if(confirm('New show? Unsaved changes lost.')){newBlankShow();renderAll();drawIfVisible();logHistory('·','New blank show','ok');}break;
      case 'save-show': case 'save-show-as':{const path=await window.electronAPI.saveDialog(state.showName+'.lss');if(path){await window.electronAPI.writeFile(path,getShowData());logHistory('·','Saved: '+path,'ok');}}break;
      case 'load-show': loadShowData(data); break;
      case 'sacn-start': sacnToggle(); break;
      case 'sacn-stop': if(sacnState.running)sacnToggle(); break;
      case 'sacn-blackout': sacnBlackout(); break;
      case 'sacn-settings': openSACNSettings(); break;
      case 'usbdmx-settings': openUSBDMXSettings(); break;
      case 'blackout-all':
        state.fixtures.forEach(f=>f.dimmer=0);renderFixtures();drawIfVisible();
        if(sacnState.running)window.electronAPI.sacnBlackout();
        if(usbDmxState.connected)window.electronAPI.usbdmxBlackout();
        logHistory('·','BLACKOUT — all outputs','ok');break;
      case 'go': goCue(); break;
      case 'back': backCue(); break;
      case 'focus-cmd': document.getElementById('cmd-input').focus(); break;
      case 'select-all': selectAll(); break;
      case 'clear-sel': clearSel(); break;
      case 'help': showHelp(); break;
    }
  });
  // Remote command receiver — all commands now go through parseCommand
  window.electronAPI.onRemoteCommand(cmdStr=>{
    try{ parseCommand(cmdStr); }catch(e){ logHistory('!','Remote cmd error: '+e.message,'err'); }
  });
}

// ─── WEB REMOTE ───────────────────────────────────────────────────────────────
function remoteGetBroadcastState(){
  return{
    showName:state.showName,
    fixtures:state.fixtures.map(f=>({id:f.id,name:f.name,dimmer:f.dimmer??0,red:f.red??255,green:f.green??255,blue:f.blue??255,pan:f.pan??127,tilt:f.tilt??127,zoom:f.zoom??127,gobo:f.gobo??0,channels:f.channels||8})),
    cues:state.cues.map(c=>({num:c.num,name:c.name,fade:c.fade,delay:c.delay})),
    presets:state.presets.map(p=>({type:p.type,num:p.num,name:p.name})),
    faders:state.faders.map(f=>({name:f.name,val:f.val||0,param:f.param||'dimmer'})),
    timelines:Object.fromEntries(Object.entries(state.timelines).map(([k,v])=>([k,{steps:v.steps,looping:v.looping}]))),
    tlPlayers:Object.fromEntries(Object.entries(tlPlayers).map(([k,p])=>([k,{running:p.running,offsetMs:p.running?tlElapsed(k):p.offsetMs}]))),
    currentCue:state.currentCue,
    vars:state.vars,
    gdtfGobos:_buildGdtfGobosMap(),
  };
}

function _buildGdtfGobosMap(){
  const map={};
  (gdtfState?.profiles||[]).forEach(p=>{
    if(p.gobos?.length) map[p.id]=p.gobos;
  });
  return map;
}

// Broadcast state to all connected web remote clients
function remoteBroadcast(){
  if(!remoteState.running||!window.electronAPI) return;
  if(_remoteBroadcastPending) return;
  _remoteBroadcastPending=true;
  requestAnimationFrame(async()=>{
    _remoteBroadcastPending=false;
    if(!remoteState.running) return;
    try{ await window.electronAPI.remoteBroadcast(remoteGetBroadcastState()); }catch(e){}
  });
}

async function remoteToggle(){
  if(!window.electronAPI) return;
  if(remoteState.running){
    await window.electronAPI.remoteStop();
    remoteState.running=false;
    logHistory('·','Web Remote stopped','info');
  } else {
    const port=parseInt(document.getElementById('remote-port')?.value||'8080')||8080;
    const passcode=document.getElementById('remote-passcode')?.value?.trim()||'';
    const result=await window.electronAPI.remoteStart(port, passcode);
    if(result.ok){
      remoteState.running=true; remoteState.port=result.port; remoteState.urls=result.urls||[];
      logHistory('·','Web Remote started — '+remoteState.urls.join('  ')+(passcode?' 🔒':''),'ok');
      remoteBroadcast();
    } else { logHistory('!','Web Remote failed to start','err'); }
  }
  updateRemoteUI();
}
function updateRemoteUI(){
  const btn=document.getElementById('remote-toggle-btn');
  const dot=document.getElementById('remote-dot');
  const urlEl=document.getElementById('remote-urls');
  if(btn){ btn.textContent=remoteState.running?'Stop Remote':'Start Remote'; btn.style.color=remoteState.running?'var(--danger)':'var(--accent3)'; btn.style.borderColor=remoteState.running?'var(--danger)':'var(--accent3)'; }
  if(dot){ dot.style.background=remoteState.running?'var(--accent3)':'var(--text2)'; dot.style.boxShadow=remoteState.running?'0 0 6px var(--accent3)':'none'; }
  if(urlEl){ urlEl.innerHTML=remoteState.running?remoteState.urls.map(u=>`<a href="${u}" target="_blank" style="color:var(--accent);font-family:var(--mono);font-size:10px;text-decoration:none;display:block">${u}</a>`).join(''):'<span style="font-family:var(--mono);font-size:10px;color:var(--text2)">Not running</span>'; }
}

// ─── MISC ─────────────────────────────────────────────────────────────────────
function updateShowName(v){state.showName=v;const el=document.getElementById('show-name-badge');if(el)el.textContent=v;const s=document.getElementById('s-showname');if(s)s.value=v;}
function logHistory(prompt,text,type){
  const el=document.getElementById('cmd-history');if(!el)return;
  const line=document.createElement('div');line.className='history-line';
  const cls={ok:'hl-ok',err:'hl-err',info:'hl-info'}[type]||'hl-cmd';
  line.innerHTML=`<span class="hl-prompt">${prompt}</span><span class="${cls}">${escHTML(text)}</span>`;
  el.appendChild(line);el.scrollTop=el.scrollHeight;while(el.children.length>300)el.removeChild(el.firstChild);
}
function updateClock(){const d=new Date(),el=document.getElementById('clock');if(el)el.textContent=String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')+':'+String(d.getSeconds()).padStart(2,'0');}
function showHelp(){
  document.getElementById('modal-title').textContent='Command Reference';
  document.getElementById('modal-body').textContent=`LIGHTSCRIPT v2.0 — COMMAND REFERENCE
═══════════════════════════════════════════════

BASIC OUTPUT
  SET FIX 1 dimmer 255          snap to full
  SET FIX 1-8 dimmer 128        range at 50%
  SET FIX 1,3,5 red 255         specific ids
  FADE FIX 1 dimmer 0 3000      fade out 3s

PARAMS: dimmer red green blue white amber uv
        pan tilt gobo color shutter strobe
        zoom focus iris prism frost speed

PATCHING (command line)
  PATCH ADD "Name" ADDR 1            add fixture
  PATCH ADD "Name" ADDR 1 PROFILE generic-par
  PATCH FIX 1 ADDR 50               change address
  PATCH FIX 1 NAME "FOH Left"       rename
  PATCH FIX 1 MODE "16ch"           change mode

RECORDING
  STORE CUE.1 Walkin        record programmer → cue
  STORE PRESET.COL.1 Warm   record colour preset
  STORE FADER.1 Dimmer       assign selected to fader 1
  STORE GROUP Front Wash     save selection as group
  CLEAR                      clear programmer

PLAYBACK
  GO / BACK / STOP           cue control
  SELECT GROUP Front Wash    recall group

BITMAPS (colour snapshots)
  BITMAP STORE MyLook        snapshot all RGB values
  BITMAP RECALL MyLook       apply to selection
  BITMAP LIST                list stored bitmaps

OTHER
  EFFECT           open effect editor (Shift+Enter)
  TIMELINE <name>  open timeline editor
  $ var = value    set variable
  DELETE CUE.3 / PRESET.INT.2 / FIX.5 / FADER.1

HOTKEYS
  Space=GO  Left=BACK  Ctrl+B=Blackout
  Ctrl+L=Command line  Ctrl+A=Select all
  ↑↓=History  Tab=Autocomplete`;
  document.getElementById('modal-overlay').classList.add('show');
}
function closeModal(){document.getElementById('modal-overlay').classList.remove('show');}

// ─── sACN ─────────────────────────────────────────────────────────────────────
const sacnState={running:false,statsInterval:null,modalStatsInterval:null};
function sacnStartPushLoop(){
  if(sacnState.statsInterval)clearInterval(sacnState.statsInterval);
  let pushing=false;
  sacnState.statsInterval=setInterval(async()=>{
    if(!sacnState.running||pushing||!window.electronAPI)return;
    pushing=true;
    try{
      const universes=buildDMXOutput();
      // Try multi-universe first, fall back to fixture push
      if(window.electronAPI.sacnSetUniverse){
        await Promise.all(Object.entries(universes).map(([u,buf])=>window.electronAPI.sacnSetUniverse(parseInt(u),Array.from(buf))));
      } else {
        await window.electronAPI.sacnPushFixtures(state.fixtures);
      }
    }finally{pushing=false;}
  },40);
}
async function sacnToggle(){
  if(!window.electronAPI)return;
  if(sacnState.running){clearInterval(sacnState.statsInterval);sacnState.statsInterval=null;await window.electronAPI.sacnStop();sacnState.running=false;setSACNUI(false);logHistory('·','sACN stopped','info');}
  else{const opts=getSACNOptions(),result=await window.electronAPI.sacnStart(opts);if(result.ok){sacnState.running=true;setSACNUI(true);logHistory('·',`sACN started — ${opts.fps}fps`,'ok');sacnStartPushLoop();}else logHistory('!','sACN error: '+(result.error||'unknown'),'err');}
  updateSACNModalToggleBtn();
}
async function sacnBlackout(){if(!window.electronAPI)return;state.fixtures.forEach(f=>f.dimmer=0);renderFixtures();drawIfVisible();await window.electronAPI.sacnBlackout();logHistory('·','BLACKOUT via sACN','ok');}
function getSACNOptions(){return{priority:parseInt(document.getElementById('sacn-priority')?.value||'100'),sourceName:document.getElementById('sacn-source-name')?.value||'LightScript',fps:parseInt(document.getElementById('sacn-fps')?.value||'40'),iface:document.getElementById('sacn-iface')?.value||null};}
function setSACNUI(running){const dot=document.getElementById('sacn-dot'),label=document.getElementById('sacn-label'),btn=document.getElementById('sacn-toggle-btn'),fps=document.getElementById('sacn-fps-badge');if(!dot)return;dot.style.background=running?'var(--accent3)':'var(--text2)';dot.style.boxShadow=running?'0 0 6px var(--accent3)':'none';label.style.color=running?'var(--accent3)':'var(--text2)';label.textContent=running?'sACN ON':'sACN OFF';btn.textContent=running?'STOP':'START';btn.style.color=running?'var(--danger)':'var(--text2)';btn.style.borderColor=running?'var(--danger)':'var(--border2)';if(fps)fps.style.display=running?'inline':'none';}
async function openSACNSettings(){const overlay=document.getElementById('sacn-modal-overlay');overlay.style.display='flex';if(window.electronAPI){const ifaces=await window.electronAPI.sacnInterfaces();const sel=document.getElementById('sacn-iface');sel.innerHTML='<option value="">Auto</option>';ifaces.forEach(iface=>{const o=document.createElement('option');o.value=iface.address;o.textContent=`${iface.name} — ${iface.address}`;sel.appendChild(o);});}updateSACNModalToggleBtn();refreshSACNStats();sacnState.modalStatsInterval=setInterval(refreshSACNStats,1000);}
function closeSACNSettings(){document.getElementById('sacn-modal-overlay').style.display='none';clearInterval(sacnState.modalStatsInterval);sacnState.modalStatsInterval=null;}
async function refreshSACNStats(){if(!window.electronAPI)return;const s=await window.electronAPI.sacnStats();if(!s)return;const get=id=>document.getElementById(id);const ss=get('ss-status');if(ss){ss.textContent=s.running?'● RUNNING':'○ STOPPED';ss.style.color=s.running?'var(--accent3)':'var(--text2)';}const su=get('ss-uptime');if(su)su.textContent=s.uptime||'—';const sp=get('ss-packets');if(sp)sp.textContent=s.packetsSent.toLocaleString();const sv=get('ss-universes');if(sv)sv.textContent=s.universeCount;const se=get('ss-errors');if(se){se.textContent=s.errors;se.style.color=s.errors>0?'var(--danger)':'var(--text1)';}const fb=get('sacn-fps-badge');if(fb)fb.textContent=s.fps+' fps';}
async function sacnApplySettings(){if(!window.electronAPI)return;await window.electronAPI.sacnConfigure(getSACNOptions());logHistory('·','sACN settings applied','ok');}
function updateSACNModalToggleBtn(){const btn=document.getElementById('sacn-modal-toggle-btn');if(!btn)return;btn.textContent=sacnState.running?'Stop Output':'Start Output';btn.style.color=sacnState.running?'var(--danger)':'var(--accent3)';btn.style.borderColor=sacnState.running?'var(--danger)':'var(--accent3)';}

// ─── USB DMX ──────────────────────────────────────────────────────────────────
const usbDmxState={connected:false,selectedIface:'enttec-pro',pushInterval:null,statsInterval:null};
async function openUSBDMXSettings(){const overlay=document.getElementById('usbdmx-modal-overlay');overlay.style.display='flex';if(window.electronAPI){const ifaces=await window.electronAPI.usbdmxGetInterfaces();buildIfaceCards(ifaces);await usbdmxRefreshPorts();}usbdmxUpdateConnectBtn();usbdmxRefreshStatus();usbDmxState.statsInterval=setInterval(usbdmxRefreshStatus,1500);}
function closeUSBDMXSettings(){document.getElementById('usbdmx-modal-overlay').style.display='none';clearInterval(usbDmxState.statsInterval);usbDmxState.statsInterval=null;}
function buildIfaceCards(ifaces){const list=document.getElementById('usbdmx-iface-list');if(!list)return;list.innerHTML='';Object.entries(ifaces).forEach(([id,def])=>{const card=document.createElement('div');const sel=id===usbDmxState.selectedIface;card.style.cssText=`background:var(--bg3);border:1px solid ${sel?'var(--accent)':'var(--border)'};border-radius:3px;padding:8px 10px;cursor:pointer`;card.innerHTML=`<div style="font-family:var(--ui);font-weight:700;font-size:11px;color:${sel?'var(--accent)':'var(--text0)'}">${def.label}</div><div style="font-family:var(--mono);font-size:9px;color:var(--text2);margin-top:2px;line-height:1.5">${def.description}</div>`;card.onclick=()=>{usbDmxState.selectedIface=id;buildIfaceCards(ifaces);usbdmxUpdateVisibility(def);};list.appendChild(card);if(sel)usbdmxUpdateVisibility(def);});}
function usbdmxUpdateVisibility(def){const pr=document.getElementById('usbdmx-port-row'),ir=document.getElementById('usbdmx-ip-row'),dr=document.getElementById('usbdmx-dmxking-port-row');if(pr)pr.style.display=def.needsPort?'grid':'none';if(ir)ir.style.display=def.needsIp?'block':'none';if(dr)dr.style.display=usbDmxState.selectedIface==='dmxking-ultra-dmx-pro'?'block':'none';}
async function usbdmxRefreshPorts(){if(!window.electronAPI)return;const ports=await window.electronAPI.usbdmxListPorts();const sel=document.getElementById('usbdmx-port-sel');if(!sel)return;sel.innerHTML='<option value="">— select port —</option>';if(!ports.length){sel.innerHTML='<option value="">No serial ports detected</option>';return;}ports.forEach(p=>{const o=document.createElement('option');o.value=p.path;o.textContent=p.path+(p.manufacturer?`  (${p.manufacturer})`:'')+(p.isDMX?' ★ DMX':'');sel.appendChild(o);if(p.isDMX&&!sel.value)sel.value=p.path;});}
async function usbdmxToggleConnect(){
  if(!window.electronAPI)return;
  if(usbDmxState.connected){clearInterval(usbDmxState.pushInterval);usbDmxState.pushInterval=null;await window.electronAPI.usbdmxDisconnect();usbDmxState.connected=false;setUSBDMXUI(false);logHistory('·','USB DMX disconnected','info');}
  else{
    const iface=usbDmxState.selectedIface,portSel=document.getElementById('usbdmx-port-sel'),ipInput=document.getElementById('usbdmx-ip');
    const portOrIp=iface==='artnet'?(ipInput?.value||'255.255.255.255'):(portSel?.value||'');
    const universe=parseInt(document.getElementById('usbdmx-universe')?.value||'1'),dkPort=document.getElementById('usbdmx-dmxking-port')?.value||'A';
    if(iface!=='null'&&iface!=='artnet'&&!portOrIp){logHistory('!','Select a serial port first','err');return;}
    const result=await window.electronAPI.usbdmxConnect(iface,portOrIp,{universe,dmxkingPort:dkPort});
    if(result.ok){
      usbDmxState.connected=true;setUSBDMXUI(true);logHistory('·',`USB DMX: ${iface} @ ${portOrIp||'N/A'} (U${universe})`,'ok');
      let pushing=false;
      usbDmxState.pushInterval=setInterval(async()=>{
        if(!usbDmxState.connected||pushing)return;pushing=true;
        try{
          // Build proper channel-mapped DMX output and send raw buffer
          const universes=buildDMXOutput();
          const buf=universes[universe]||new Uint8Array(512);
          await window.electronAPI.usbdmxSetBuffer(Array.from(buf));
        }finally{pushing=false;}
      },40);
    } else logHistory('!','USB DMX failed: '+(result.error||'check interface and port'),'err');
  }
  usbdmxUpdateConnectBtn();
}
function setUSBDMXUI(connected){const dot=document.getElementById('usbdmx-dot'),label=document.getElementById('usbdmx-label');if(dot){dot.style.background=connected?'#e8a020':'var(--text2)';dot.style.boxShadow=connected?'0 0 6px #e8a020':'none';}if(label){label.textContent=connected?'DMX ON':'DMX OFF';label.style.color=connected?'#e8a020':'var(--text2)';}}
function usbdmxUpdateConnectBtn(){const btn=document.getElementById('usbdmx-connect-btn');if(!btn)return;btn.textContent=usbDmxState.connected?'Disconnect':'Connect';btn.style.background=usbDmxState.connected?'var(--danger)':'var(--accent)';btn.style.borderColor=usbDmxState.connected?'var(--danger)':'var(--accent)';btn.style.color=usbDmxState.connected?'#fff':'#000';}
async function usbdmxBlackout(){if(!window.electronAPI)return;if(usbDmxState.connected)await window.electronAPI.usbdmxBlackout();state.fixtures.forEach(f=>f.dimmer=0);renderFixtures();drawIfVisible();logHistory('·','BLACKOUT via USB DMX','ok');}
async function usbdmxRefreshStatus(){if(!window.electronAPI)return;const s=await window.electronAPI.usbdmxStatus();if(!s)return;const get=id=>document.getElementById(id);const st=get('ud-status');if(st){st.textContent=s.connected?'● CONNECTED':'○ IDLE';st.style.color=s.connected?'var(--accent)':'var(--text2)';}const ui=get('ud-iface');if(ui)ui.textContent=s.interfaceLabel||'—';const up=get('ud-port');if(up)up.textContent=s.portOrIp||'—';const uf=get('ud-frames');if(uf)uf.textContent=(s.framesSent||0).toLocaleString();const uu=get('ud-uptime');if(uu)uu.textContent=s.uptime||'—';const ue=get('ud-errors');if(ue){ue.textContent=s.errors;ue.style.color=s.errors>0?'var(--danger)':'var(--text1)';}}

// ─── MULTILINE EDITOR ─────────────────────────────────────────────────────────
const mlState={mode:'EFFECT',name:'',active:false};
function mlOpen(mode,nameOrContent){
  mlState.mode=mode;mlState.active=true;
  const editor=document.getElementById('multiline-editor'),single=document.getElementById('cmd-line'),ta=document.getElementById('ml-textarea'),label=document.getElementById('ml-mode-label');
  if(!editor||!ta)return;single.style.display='none';editor.style.display='flex';
  if(mode==='TIMELINE'){mlState.name=nameOrContent||'TL'+(Object.keys(state.timelines).length+1);label.textContent='TIMELINE: '+mlState.name;ta.placeholder='Commands with time offset (ms) at end:\n\nSET FIX 1-8 dimmer 255   0\nSET FIX 1-4 red 255     2000';ta.value='';}
  else{mlState.name='';label.textContent='EFFECT';ta.placeholder='Commands with hold time (ms) at end:\n\nSET FIX 1-8 dimmer 255   500\nSET FIX 1-8 dimmer 0     500';ta.value=typeof nameOrContent==='string'?nameOrContent:'';}
  mlUpdateGutter();mlSetStatus('Ready — '+mode+' editor');ta.focus();
}
function mlClose(){const editor=document.getElementById('multiline-editor'),single=document.getElementById('cmd-line');if(editor)editor.style.display='none';if(single)single.style.display='flex';mlState.active=false;document.getElementById('cmd-input')?.focus();}
function mlCancel(){mlClose();logHistory('·',mlState.mode+' editor cancelled','info');}
function mlGetLines(){const ta=document.getElementById('ml-textarea');return ta?ta.value.split('\n').filter(l=>l.trim()):[];}
function mlUpdateGutter(){const ta=document.getElementById('ml-textarea'),gutter=document.getElementById('ml-gutter'),countEl=document.getElementById('ml-line-count');if(!ta||!gutter)return;const lines=ta.value.split('\n');gutter.innerHTML=lines.map((_,i)=>`<div>${i+1}</div>`).join('');if(countEl)countEl.textContent=lines.filter(l=>l.trim()).length+' steps';}
function mlSetStatus(msg,isError){const el=document.getElementById('ml-status-text');if(!el)return;el.textContent=msg;el.style.color=isError?'var(--danger)':'var(--accent2)';}
function mlExecute(){const lines=mlGetLines();if(!lines.length){mlSetStatus('No commands',true);return;}let ok=0;lines.forEach((line,i)=>{const cmd=line.trim().replace(/\s+\d+\s*$/,'').trim();try{parseCommand(cmd);ok++;}catch(e){mlSetStatus(`Line ${i+1}: ${e.message}`,true);}});if(ok===lines.length){mlSetStatus(`Executed ${ok} commands`);logHistory('·',`${mlState.mode}: ran ${ok} steps`,'ok');}}
function mlStore(){
  const lines=mlGetLines();if(!lines.length){mlSetStatus('Nothing to store',true);return;}
  if(mlState.mode==='EFFECT'){const key='EFX'+Date.now();state.effects[key]={looping:true,steps:lines.map(line=>{const parts=line.trim().split(/\s+/);const hold=/^\d+$/.test(parts[parts.length-1])?parseInt(parts.pop()):500;return{cmd:parts.join(' '),holdMs:hold};})};logHistory('·',`EFFECT "${key}" stored (${state.effects[key].steps.length} steps)`,'ok');mlSetStatus('Effect stored as '+key);}
  else{const name=mlState.name||('TL'+Date.now());state.timelines[name]={looping:false,steps:lines.map(line=>{const parts=line.trim().split(/\s+/);const t=/^\d+$/.test(parts[parts.length-1])?parseInt(parts.pop()):0;return{cmd:parts.join(' '),timeMs:t};})};logHistory('·',`TIMELINE "${name}" stored`,'ok');mlSetStatus('Timeline stored as '+name);}
  mlClose();
}
function setupMultilineEditor(){
  const ta=document.getElementById('ml-textarea');if(!ta)return;
  ta.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.ctrlKey){e.preventDefault();mlExecute();}else if(e.key==='s'&&e.ctrlKey){e.preventDefault();mlStore();}else if(e.key==='Escape'){e.preventDefault();mlCancel();}else if(e.key==='Tab'){e.preventDefault();const s=ta.selectionStart,en=ta.selectionEnd;ta.value=ta.value.slice(0,s)+'  '+ta.value.slice(en);ta.selectionStart=ta.selectionEnd=s+2;}});
  ta.addEventListener('input',()=>{mlUpdateGutter();mlSetStatus('Editing...');});ta.addEventListener('scroll',()=>{const g=document.getElementById('ml-gutter');if(g)g.scrollTop=ta.scrollTop;});
}

// ─── GDTF ─────────────────────────────────────────────────────────────────────
const gdtfState={folderPath:null,profiles:[],loaded:false};
async function gdtfPickFolder(){if(!window.electronAPI)return;const folder=await window.electronAPI.gdtfPickFolder();if(!folder)return;gdtfState.folderPath=folder;try{localStorage.setItem('gdtfFolder',folder);}catch(_){}const pel=document.getElementById('gdtf-folder-path');if(pel)pel.textContent=folder;await gdtfLoadFolder(folder);}
async function gdtfReload(){if(gdtfState.folderPath)await gdtfLoadFolder(gdtfState.folderPath);else gdtfPickFolder();}
async function gdtfLoadFolder(folderPath){
  if(!window.electronAPI)return;const statusEl=document.getElementById('gdtf-status');if(statusEl){statusEl.textContent='Scanning…';statusEl.style.color='var(--text2)';}
  const result=await window.electronAPI.gdtfLoadFolder(folderPath);
  if(!result.ok){if(statusEl){statusEl.textContent=`Error: ${result.error}`;statusEl.style.color='var(--danger)';}return;}
  gdtfState.profiles=result.profiles;gdtfState.loaded=true;
  const msg=`✓ ${result.loaded.toLocaleString()} fixtures loaded`;if(statusEl){statusEl.textContent=msg;statusEl.style.color='var(--accent3)';}
  const rb=document.getElementById('gdtf-reload-btn');if(rb)rb.style.display='inline';
  logHistory('·',`GDTF library: ${result.loaded} profiles from ${result.total} files`,'ok');
}
async function gdtfInit(){
  try{const saved=localStorage.getItem('gdtfFolder');if(saved&&window.electronAPI){gdtfState.folderPath=saved;const pel=document.getElementById('gdtf-folder-path');if(pel)pel.textContent=saved;await gdtfLoadFolder(saved);}}catch(_){}
}

// ─── SHOW FILE OPEN ASSOCIATION ────────────────────────────────────────────────
// When .lss files are opened directly (double-click), main.js sends load-show

// ─── EXPORTS ──────────────────────────────────────────────────────────────────
// ─── MIDI ENGINE ─────────────────────────────────────────────────────────────
const midiState = { access:null, inputs:[], links:[], listening:false };

async function midiInit() {
  if (!navigator.requestMIDIAccess) { logHistory('!','Web MIDI not supported in this environment','err'); return; }
  try {
    const access = await navigator.requestMIDIAccess({ sysex: false });
    midiState.access = access;
    midiState.inputs = [...access.inputs.values()];
    access.onstatechange = () => { midiState.inputs=[...access.inputs.values()]; midiRefreshPanel(); };
    midiState.inputs.forEach(input => { input.onmidimessage = midiOnMessage; });
    midiState.listening = true;
    logHistory('·', `MIDI: ${midiState.inputs.length} input(s) — ${midiState.inputs.map(i=>i.name).join(', ')||'none'}`, 'ok');
    midiRefreshPanel();
  } catch(e) {
    logHistory('!', 'MIDI init failed: ' + e.message, 'err');
  }
}

function midiOnMessage(e) {
  const [status, data1, data2] = e.data;
  const type = status >> 4;
  const ch   = (status & 0x0f) + 1;
  // Match against MIDI links
  midiState.links.forEach(link => {
    if (!link.enabled) return;
    const typeMatch = link.msgType === 'any' || (link.msgType === 'noteon' && type === 9) || (link.msgType === 'noteoff' && type === 8) || (link.msgType === 'cc' && type === 11) || (link.msgType === 'pc' && type === 12);
    const chMatch   = !link.channel || link.channel === ch;
    const noteMatch = link.note == null || link.note === data1;
    if (!typeMatch || !chMatch || !noteMatch) return;
    // Substitute $VAL$ with scaled value
    let cmd = link.action;
    if (cmd.includes('$VAL$')) {
      const scaled = Math.round(data2 / 127 * 255);
      cmd = cmd.replace(/\$VAL\$/g, String(scaled));
    }
    if (cmd.includes('$NOTE$')) cmd = cmd.replace(/\$NOTE\$/g, String(data1));
    try { parseCommand(cmd); } catch(err) {}
    // GO shortcut: soundboard mute button → GO
    if (link.isGO && data2 > 0) goCue();
  });
  // Log raw MIDI
  const typeName = {8:'NoteOff',9:'NoteOn',10:'PolyAT',11:'CC',12:'PC',13:'ChAT',14:'PitchBend'}[type]||'Msg';
  logHistory('♩', `MIDI ${typeName} ch${ch} d1=${data1} d2=${data2}`, 'info');
}

function midiRefreshPanel() {
  const list = document.getElementById('midi-input-list'); if (!list) return;
  list.innerHTML = midiState.inputs.length
    ? midiState.inputs.map(i => `<div style="font-family:var(--mono);font-size:10px;color:var(--accent3);padding:2px 0">● ${escHTML(i.name)}</div>`).join('')
    : '<div style="font-family:var(--mono);font-size:10px;color:var(--text2)">No MIDI inputs — connect a device and click Init</div>';
  renderMIDILinks();
}

function renderMIDILinks() {
  const list = document.getElementById('midi-links-list'); if (!list) return;
  list.innerHTML = '';
  midiState.links.forEach((link, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:auto 70px 40px 50px 1fr auto auto;gap:6px;align-items:center;padding:5px 0;border-bottom:1px solid var(--border)';
    row.innerHTML = `
      <input type="checkbox" ${link.enabled?'checked':''} onchange="midiState.links[${i}].enabled=this.checked" style="accent-color:var(--accent3)" title="Enable this link">
      <select onchange="midiState.links[${i}].msgType=this.value" class="modal-input" style="font-size:9px;padding:2px">
        <option value="any"${link.msgType==='any'?' selected':''}>Any</option>
        <option value="noteon"${link.msgType==='noteon'?' selected':''}>NoteOn</option>
        <option value="cc"${link.msgType==='cc'?' selected':''}>CC</option>
        <option value="pc"${link.msgType==='pc'?' selected':''}>PC</option>
      </select>
      <input type="number" value="${link.channel||''}" placeholder="Ch" class="modal-input" style="font-size:9px;padding:2px" oninput="midiState.links[${i}].channel=parseInt(this.value)||null">
      <input type="number" value="${link.note??''}" placeholder="Note" class="modal-input" style="font-size:9px;padding:2px" oninput="midiState.links[${i}].note=parseInt(this.value)??null">
      <input value="${escHTML(link.action||'')}" placeholder="LightScript command · $VAL$=velocity · GO=cue go" class="modal-input" style="font-size:9px;padding:2px;width:100%" oninput="midiState.links[${i}].action=this.value">
      <label title="Treat as soundboard GO button" style="display:flex;align-items:center;gap:2px;font-family:var(--ui);font-size:9px;color:var(--accent2);cursor:pointer;white-space:nowrap"><input type="checkbox" ${link.isGO?'checked':''} onchange="midiState.links[${i}].isGO=this.checked" style="accent-color:var(--accent2)">GO</label>
      <button onclick="midiState.links.splice(${i},1);renderMIDILinks()" style="background:none;border:none;color:var(--danger);font-size:11px;cursor:pointer">✕</button>`;
    list.appendChild(row);
  });
}

function midiAddLink() {
  midiState.links.push({ enabled:true, msgType:'noteon', channel:null, note:null, action:'GO' });
  renderMIDILinks();
}

// ─── PROPRESENTER INTEGRATION ─────────────────────────────────────────────────
// ProPresenter OSC API: sends /propresenter/slide/current when slide changes
// We listen on a local UDP socket (via WebSocket proxy in main process for now)
// Links: ProPresenter slide name/index → LightScript cue

const ppState = { connected:false, links:[], lastSlide:'' };

function ppHandleSlide(slideData) {
  // slideData = { name, index, uuid }
  ppState.lastSlide = slideData.name || String(slideData.index);
  logHistory('⬡', `ProPresenter: slide "${ppState.lastSlide}"`, 'info');
  // Find matching link
  ppState.links.forEach(link => {
    if (!link.enabled) return;
    const match = link.slideMatch.toLowerCase();
    const slideLower = ppState.lastSlide.toLowerCase();
    if (match === slideLower || (link.matchType === 'contains' && slideLower.includes(match)) || (link.matchType === 'index' && String(slideData.index) === match)) {
      try { parseCommand(link.action); } catch(e) {}
    }
  });
}

function ppAddLink() {
  ppState.links.push({ enabled:true, slideMatch:'', matchType:'exact', action:'GO' });
  renderPPLinks();
}

function renderPPLinks() {
  const list = document.getElementById('pp-links-list'); if (!list) return;
  list.innerHTML = '';
  ppState.links.forEach((link, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:auto 120px 80px 1fr auto;gap:6px;align-items:center;padding:5px 0;border-bottom:1px solid var(--border)';
    row.innerHTML = `
      <input type="checkbox" ${link.enabled?'checked':''} onchange="ppState.links[${i}].enabled=this.checked" style="accent-color:var(--accent)">
      <input value="${escHTML(link.slideMatch||'')}" placeholder="Slide name/index" class="modal-input" style="font-size:9px;padding:2px" oninput="ppState.links[${i}].slideMatch=this.value">
      <select onchange="ppState.links[${i}].matchType=this.value" class="modal-input" style="font-size:9px;padding:2px">
        <option value="exact"${link.matchType==='exact'?' selected':''}>Exact</option>
        <option value="contains"${link.matchType==='contains'?' selected':''}>Contains</option>
        <option value="index"${link.matchType==='index'?' selected':''}>Index #</option>
      </select>
      <input value="${escHTML(link.action||'')}" placeholder="LightScript command" class="modal-input" style="font-size:9px;padding:2px;width:100%" oninput="ppState.links[${i}].action=this.value">
      <button onclick="ppState.links.splice(${i},1);renderPPLinks()" style="background:none;border:none;color:var(--danger);font-size:11px;cursor:pointer">✕</button>`;
    list.appendChild(row);
  });
}

// ─── TIMELINE RECORD MODE ──────────────────────────────────────────────────────
function tlStartRecord(name) {
  if (tlRecordState.active) tlStopRecord();
  tlRecordState.active   = true;
  tlRecordState.name     = name || 'REC_' + Date.now();
  tlRecordState.startMs  = performance.now();
  tlRecordState.steps    = [];
  logHistory('⏺', `TIMELINE RECORD started — "${tlRecordState.name}" — press P for placeholder, Esc to stop`, 'ok');

  // Show recording indicator in tab header
  const recBadge = document.createElement('div');
  recBadge.id = 'tl-rec-badge';
  recBadge.style.cssText = 'position:fixed;top:8px;right:16px;z-index:9000;background:var(--danger);color:#fff;font-family:var(--ui);font-weight:700;font-size:11px;letter-spacing:2px;padding:4px 14px;border-radius:3px;display:flex;align-items:center;gap:6px;animation:recBlink 1s infinite';
  recBadge.innerHTML = '⏺ REC <span id="tl-rec-time" style="font-family:var(--mono);margin-left:4px">00:00:00.000</span>'
    + '<button onclick="tlRecordPlaceholder()" style="margin-left:10px;background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.3);color:#fff;font-family:var(--ui);font-weight:700;font-size:9px;padding:2px 8px;cursor:pointer;border-radius:2px">P Placeholder</button>'
    + '<button onclick="tlStopRecord()" style="margin-left:4px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.3);color:#fff;font-family:var(--ui);font-weight:700;font-size:9px;padding:2px 8px;cursor:pointer;border-radius:2px">■ Stop</button>';
  document.body.appendChild(recBadge);

  // Add blink animation
  if (!document.getElementById('rec-style')) {
    const s = document.createElement('style');
    s.id = 'rec-style';
    s.textContent = '@keyframes recBlink { 0%,100%{opacity:1} 50%{opacity:0.6} }';
    document.head.appendChild(s);
  }

  // Live clock updater
  tlRecordState._clockInterval = setInterval(() => {
    const el = document.getElementById('tl-rec-time');
    if (el) el.textContent = formatTC(performance.now() - tlRecordState.startMs);
  }, 100);

  // Keyboard listener: P = placeholder (only when NOT in a text input), Escape = stop
  tlRecordState._keyHandler = (e) => {
    if (!tlRecordState.active) return;
    // P works everywhere EXCEPT when typing in a non-command input (like name fields, modals)
    // It intentionally fires even when the command line is focused so you can use it mid-show
    const tag = document.activeElement?.tagName;
    const isModal = document.activeElement?.closest?.('[id$="-overlay"]') || document.activeElement?.closest?.('.modal-input');
    if ((e.key === 'p' || e.key === 'P') && !isModal) {
      // Don't let P type in the command line — handle it here
      if (document.activeElement?.id === 'cmd-input') e.preventDefault();
      tlRecordPlaceholder();
    }
    if (e.key === 'Escape') {
      tlStopRecord();
    }
  };
  document.addEventListener('keydown', tlRecordState._keyHandler);
}

function tlRecordStep(cmd) {
  if (!tlRecordState.active) return;
  const timeMs = Math.round(performance.now() - tlRecordState.startMs);
  tlRecordState.steps.push({ timeMs, cmd });
  logHistory('⏺', `REC [${formatTC(timeMs)}] ${cmd}`, 'info');
}

function tlRecordPlaceholder() {
  if (!tlRecordState.active) return;
  const timeMs = Math.round(performance.now() - tlRecordState.startMs);
  // Store as a special PLACEHOLDER marker — shows amber in list, user edits it later
  // NOT a comment so it actually appears in the cue list and can be double-clicked to edit
  tlRecordState.steps.push({ timeMs, cmd: 'PLACEHOLDER', isPlaceholder: true });
  logHistory('⏺', `REC [${formatTC(timeMs)}] PLACEHOLDER dropped`, 'info');
}

function tlStopRecord() {
  if (!tlRecordState.active) return;
  if (tlRecordState._keyHandler) document.removeEventListener('keydown', tlRecordState._keyHandler);
  if (tlRecordState._clockInterval) clearInterval(tlRecordState._clockInterval);
  // Remove recording badge
  const badge = document.getElementById('tl-rec-badge');
  if (badge) badge.remove();
  tlRecordState.active = false;
  const name = tlRecordState.name;
  const steps = tlRecordState.steps;
  if (steps.length) {
    state.timelines[name] = { looping:false, steps };
    tcRenderList();
    _tlEmbedRefresh();
    logHistory('⏺', `TIMELINE "${name}" recorded — ${steps.length} events`, 'ok');
  } else {
    logHistory('·', 'RECORD stopped — no events captured', 'info');
  }
}

// Hook record into parseCommand — wrap at the bottom of parseCommand
function _tlRecordHook(raw) {
  if (!tlRecordState.active) return;
  // Don't record TIMELINE or SNEAK commands themselves
  const action = raw.trim().split(/\s+/)[0].toUpperCase();
  if (action === 'TIMELINE' || action === 'STOPREC') return;
  tlRecordStep(raw);
}

// ─── 3D MODEL SHAPES (fixture type → canvas 2D path) ─────────────────────────
// Since we're on canvas 2D (not WebGL), we simulate 3D models with detailed icon shapes
// Each fixture type gets a characteristic silhouette when viewed from above/front

const FIX_SHAPES = {
  SPOT:    drawFixtureSpot,
  BEAM:    drawFixtureBeam,
  WASH:    drawFixtureWash,
  LED:     drawFixtureLED,
  PAR:     drawFixturePAR,
  STROB:   drawFixtureStrobe,
  MOVE:    drawFixtureSpot,   // alias
  MOVER:   drawFixtureSpot,
  default: drawFixturePAR,
};

function drawFixtureInScene(ctx, f, p, scale) {
  if (!p) return;
  const x = p.x, y = p.y;
  const r = f.red ?? 255, g = f.green ?? 255, b = f.blue ?? 255;
  const dim = (f.dimmer ?? 0) / 255;
  const lit = dim > 0.02;
  const ri = Math.round(r * dim), gi = Math.round(g * dim), bi = Math.round(b * dim);
  const baseColor = lit ? `rgb(${ri},${gi},${bi})` : '#1a2030';
  const glowColor = lit ? `rgba(${ri},${gi},${bi},${Math.min(0.8, dim * 1.2)})` : null;

  // Glow/beam (drawn first, behind fixture)
  if (lit && dim > 0.05) {
    // Beam cone going "down" to stage floor
    const beamAngle = f.pan != null ? (f.pan / 255 - 0.5) * Math.PI * 0.6 : 0;
    const beamTilt  = f.tilt != null ? (f.tilt / 255) * 0.8 + 0.1 : 0.5;
    const beamLen   = 140 * beamTilt * scale * 1.5;
    const beamW     = Math.max(4, 20 * (f.zoom != null ? f.zoom / 255 : 0.5) * dim);
    const bx = x + Math.sin(beamAngle) * beamLen;
    const by = y + beamLen * 0.7;
    const grad = ctx.createRadialGradient(x, y, 0, bx, by, beamW * 4);
    grad.addColorStop(0, `rgba(${ri},${gi},${bi},${dim * 0.5})`);
    grad.addColorStop(1, `rgba(${ri},${gi},${bi},0)`);
    ctx.beginPath();
    ctx.moveTo(x - Math.cos(beamAngle) * 4, y - 4);
    ctx.lineTo(bx - beamW * 2, by + beamW);
    ctx.lineTo(bx + beamW * 2, by + beamW);
    ctx.lineTo(x + Math.cos(beamAngle) * 4, y - 4);
    ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();
  }

  // Draw fixture body
  const shapeFn = FIX_SHAPES[f.type?.toUpperCase()] || FIX_SHAPES.default;
  shapeFn(ctx, x, y, p.scale, baseColor, glowColor, f, lit);

  // Label
  const isSel = state.selected.has(f.id);
  ctx.font = `bold ${Math.round(8 * Math.max(0.5, p.scale))}px monospace`;
  ctx.fillStyle = isSel ? '#fff' : 'rgba(160,180,200,0.8)';
  ctx.textAlign = 'center';
  ctx.fillText(String(f.id), x, y + 14 * p.scale);

  // Selection ring
  if (isSel) {
    ctx.beginPath();
    ctx.arc(x, y, 14 * p.scale, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

function drawFixtureSpot(ctx, x, y, sc, col, glow, f, lit) {
  const r = 10 * sc;
  // Body
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = '#1e2a3a'; ctx.fill();
  // Lens
  ctx.beginPath(); ctx.arc(x, y, r * 0.55, 0, Math.PI * 2);
  ctx.fillStyle = lit ? col : '#151c28'; ctx.fill();
  if (lit && glow) { ctx.shadowBlur = 14 * sc; ctx.shadowColor = glow; ctx.fill(); ctx.shadowBlur = 0; }
  ctx.beginPath(); ctx.arc(x, y, r * 0.22, 0, Math.PI * 2);
  ctx.fillStyle = lit ? `rgba(255,255,255,${(f.dimmer||0)/510})` : '#0a0f18'; ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.strokeStyle = '#4a6080'; ctx.lineWidth = 1.2; ctx.stroke();
}

function drawFixtureBeam(ctx, x, y, sc, col, glow, f, lit) {
  const r = 9 * sc;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = '#181e2c'; ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, r * 0.4, 0, Math.PI * 2);
  ctx.fillStyle = lit ? col : '#0d1220';
  if (lit && glow) { ctx.shadowBlur = 20 * sc; ctx.shadowColor = glow; }
  ctx.fill(); ctx.shadowBlur = 0;
  // Beam emitter ring
  ctx.beginPath(); ctx.arc(x, y, r * 0.7, 0, Math.PI * 2);
  ctx.strokeStyle = lit ? col : '#2a3550'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.strokeStyle = '#3a5070'; ctx.lineWidth = 1; ctx.stroke();
}

function drawFixtureWash(ctx, x, y, sc, col, glow, f, lit) {
  const r = 11 * sc;
  // Octagonal wash head
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 8;
    i === 0 ? ctx.moveTo(x + r * Math.cos(a), y + r * Math.sin(a)) : ctx.lineTo(x + r * Math.cos(a), y + r * Math.sin(a));
  }
  ctx.closePath(); ctx.fillStyle = '#1c2535'; ctx.fill();
  // LED array (3×3)
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    ctx.beginPath(); ctx.arc(x + dx * 3.5 * sc, y + dy * 3.5 * sc, 1.8 * sc, 0, Math.PI * 2);
    ctx.fillStyle = lit ? col : '#0d1520';
    if (lit && glow) { ctx.shadowBlur = 6 * sc; ctx.shadowColor = glow; }
    ctx.fill(); ctx.shadowBlur = 0;
  }
  ctx.strokeStyle = '#3a4e6a'; ctx.lineWidth = 1; ctx.stroke();
}

function drawFixtureLED(ctx, x, y, sc, col, glow, f, lit) {
  const w = 18 * sc, h = 10 * sc;
  ctx.beginPath(); ctx.roundRect(x - w/2, y - h/2, w, h, 2 * sc);
  ctx.fillStyle = '#171e2a'; ctx.fill();
  // LED bar
  const segs = 5;
  for (let s = 0; s < segs; s++) {
    const sx = x - w/2 + (s + 0.5) * (w / segs);
    ctx.beginPath(); ctx.arc(sx, y, 2.5 * sc, 0, Math.PI * 2);
    ctx.fillStyle = lit ? col : '#0d1218';
    if (lit && glow) { ctx.shadowBlur = 8 * sc; ctx.shadowColor = glow; }
    ctx.fill(); ctx.shadowBlur = 0;
  }
  ctx.strokeStyle = '#2a3848'; ctx.lineWidth = 0.8; ctx.stroke();
}

function drawFixturePAR(ctx, x, y, sc, col, glow, f, lit) {
  const r = 9 * sc;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = '#181f2d'; ctx.fill();
  ctx.beginPath(); ctx.arc(x, y, r * 0.65, 0, Math.PI * 2);
  ctx.fillStyle = lit ? col : '#10161f';
  if (lit && glow) { ctx.shadowBlur = 12 * sc; ctx.shadowColor = glow; }
  ctx.fill(); ctx.shadowBlur = 0;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.strokeStyle = '#2e3e54'; ctx.lineWidth = 1.2; ctx.stroke();
}

function drawFixtureStrobe(ctx, x, y, sc, col, glow, f, lit) {
  const w = 20 * sc, h = 8 * sc;
  ctx.beginPath(); ctx.rect(x - w/2, y - h/2, w, h);
  ctx.fillStyle = '#141a24'; ctx.fill();
  // Flash tubes
  const tubes = 4;
  for (let t = 0; t < tubes; t++) {
    const tx = x - w/2 + (t + 0.5) * (w / tubes);
    ctx.beginPath(); ctx.rect(tx - 1.5 * sc, y - h/2 + 1.5 * sc, 3 * sc, h - 3 * sc);
    ctx.fillStyle = lit ? col : '#0c1018';
    if (lit && glow) { ctx.shadowBlur = 10 * sc; ctx.shadowColor = glow; }
    ctx.fill(); ctx.shadowBlur = 0;
  }
  ctx.strokeStyle = '#283848'; ctx.lineWidth = 0.8; ctx.stroke();
}

Object.assign(window, {
  switchTab, goCue, backCue, stopCue, jumpCue,
  toggleFader, releaseAll, filterPreset, recallPreset,
  selectAll, clearSel, selectGroup, setGridCols, addFader, renameFader,
  addFixture:openAddFixtureModal, removePatch, clearPatch,
  openAddFixtureModal, confirmAddFixture, closeAddFixtureModal,
  updateAddFixtureModes, updateAddFixtureChInfo,
  openCustomFixtureBuilder, closeCustomFixtureBuilder, cfbAddCh, cfbRemoveCh,
  cfbAddMode, cfbRemoveMode, cfbToggleModeChannel, cfbSaveAndPatch,
  addLink, deleteLink, openLinkEditor, closeLinkEditor, confirmAddLink, editLink, linksShowSection, ppOSCInit,
  closeModal, updateShowName,
  startCueEdit, saveCueEdit, cancelCueEdit, toggleMIB,
  openCueCodeEditor, closeCueCodeEditor, saveCueCodeEditor, cceUpdateGutter,
  openPresetCodeEditor, closePresetCodeEditor, savePresetCodeEditor, pceUpdateGutter,
  tcPlay, tcStop, tcReset, tcNewTimeline, tcRenderList, tcSelectTimeline,
  tcDeleteTimeline, tcSaveTimeline, tcFireTimeline, tcAddCueRow, tcDeleteCueRow, tcEditCueRow,
  tcRenderRuler, tcRulerClick,
  tlPlay, tlPause, tlStop, tlReset, _tlEmbedRefresh,
  setupPanelCanvas, open3DEditSelected, openFix3DEdit, closeFix3DEdit,
  applyFix3DEdit, fix3DSelectPrev, fix3DSelectNext,
  gridCopy, gridPaste, gridFlip,
  openEffectEditor, closeEffectEditor, saveEffectEdit, renderEffectsList, deleteEffect, efxStart, efxStop, efxStopAll, efxSwitchTab, efxAddStep, efxRenderSteps,
  midiInit, midiAddLink, renderMIDILinks, midiState,
  ppAddLink, renderPPLinks, ppState, ppHandleSlide,
  tlStartRecord, tlStopRecord, tlRecordPlaceholder, tlRecordState,
  sacnToggle, sacnBlackout, openSACNSettings, closeSACNSettings,
  sacnApplySettings, updateSACNModalToggleBtn,
  reset3DCamera, top3DCamera, front3DCamera,
  mlExecute, mlStore, mlCancel,
  openUSBDMXSettings, closeUSBDMXSettings,
  usbdmxRefreshPorts, usbdmxToggleConnect, usbdmxBlackout,
  gdtfPickFolder, gdtfReload,
  licenseInit, licActivate, licDeactivate, licContinue, licPasteKey, openLicenseOverlay, licCheckChannelCount,
  openBitmapProjector, closeBitmapProjector, bmpProjLoadImage, bmpProjApply, bmpProjUpdate, bmpProjRender, bmpToggleLive,
  openStageObjectModal, closeStageObjectModal, applyStageObject, deleteStageObject,
  buildGroupsPanel, renderGroupsPanels, fillGroupsPanel,
  remoteToggle, updateRemoteUI,
  aiSend, aiSendFull, aiQuick, aiSetKey, aiExecuteBlock, aiCheckOllama, aiSetOllamaUrl, aiSetOllamaModel, aiSaveKey, aiClearKey, aiInit,
});

document.addEventListener('DOMContentLoaded', init);
