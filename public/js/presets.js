import * as core from './core.js';
import * as apply from './apply.js';

/* Named looks: the built-in recipes, the user's saved ones, the two modes
   (per-track memory or manual) and the export/import text. Storage lives here;
   everything it applies goes through apply.js. */

const {
  $,
  DEFAULTS,
  dom,
  toast,
} = core;

const {
  applySettings,
  captureSettings,
  sanitizeSettings,
  settingsEqual,
} = apply;

/* A preset captures the LOOK — everything that decides the picture. The two
   exceptions are rateMode and renderScale: those describe the machine you
   happen to be sitting at, and a preset that silently moved someone else's
   audio engine to 192 kHz would be a bug, not a feature. */
const builtinPreset = (name, over) => ({ name, settings: Object.assign({}, DEFAULTS, over) });
/* The two recipes name all three of their numbers explicitly rather than
   inheriting "whatever the default happens to be" — that inheritance is how
   a preset silently stops matching its own documentation. */
const BUILTIN_PRESETS = [
  builtinPreset('默认', {}),
  builtinPreset('描边', { windowIdx: 1, persistence: 16, lineWidth: 1.15 }),          // 1024, 16 %
  builtinPreset('填充', { windowIdx: 3, persistence: 32, lineWidth: 2.3 }),           // 4096, 32 %
];
const BUILTIN_NAMES = new Set(BUILTIN_PRESETS.map((p) => p.name));
const PRESET_STORE = 'scope.presets.v1';
const EXPORT_KIND = 'oscilloscope-presets';
let customPresets = [];    // [{name, settings}] — the user's, in insertion order
let presetMode = 'auto';   // 'auto' = remember per track | 'manual' = only on click
let trackMemory = {};      // { [trackName]: { preset, settings } }
let activePreset = null;   // preset the current settings came from, or null
let armedDelete = null;    // preset name waiting for a second click
let editingPreset = null;  // preset being renamed in the save row
let recordTimer = 0;
let armTimer = 0;

function storage() {
  try { return window.localStorage; } catch (e) { return null; }   // file://, private mode
}
function cleanName(v) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
}
/** Snap a number onto its control's own grid. Presets arrive from storage and
    from other people's exports, and a value the slider cannot express would
    make the readout disagree with what is actually rendering — the exact bug
    class this file keeps having to fix. */

const allPresets = () => BUILTIN_PRESETS.concat(customPresets);
const findPreset = (name) => allPresets().find((p) => p.name === name) || null;

function applyPreset(name) {
  const p = findPreset(name);
  if (!p) return;
  applySettings(p.settings);
  activePreset = name;
  noteSettingsChanged();
  renderPresetUI();
  toast(`预设：${name}`);
}
/** The playlist owns which track is loaded; the preset layer is told, so it
    needs no reference back into the playlist (which would close a cycle). */
let trackKey = null;
let trackLabel = null;
function setTrackKey(key, label) {
  trackKey = key || null;
  trackLabel = label || null;
  renderPresetStatus();
}
/* Every change is recorded for the track you are looking at, in BOTH modes:
   manual mode only declines to *apply* it automatically, and keeping the
   record means switching modes later does not lose anything. */
/** ui.js and playlist.js set this when they apply a preset. */
function setActivePreset(name) { activePreset = name || null; }

function noteSettingsChanged() {
  renderPresetStatus();
  clearTimeout(recordTimer);
  recordTimer = setTimeout(recordTrackSettings, 400);
}
function recordTrackSettings() {
  if (!trackKey) return;
  trackMemory[trackKey] = { preset: activePreset, settings: captureSettings() };
  const keys = Object.keys(trackMemory);
  if (keys.length > 80) delete trackMemory[keys[0]];   // bound the store
  savePresets();
}
function restoreTrackSettings() {
  if (presetMode === 'manual') { renderPresetStatus(); return; }
  const entry = trackKey ? trackMemory[trackKey] : null;
  if (entry) {
    applySettings(entry.settings);
    activePreset = entry.preset && findPreset(entry.preset) ? entry.preset : null;
  } else {
    activePreset = null;   // never seen this track: keep whatever is on screen
  }
  renderPresetUI();
}
function loadPresets() {
  const ls = storage();
  if (!ls) return;
  let data = null;
  try { data = JSON.parse(ls.getItem(PRESET_STORE) || 'null'); } catch (e) { data = null; }
  if (!data || typeof data !== 'object') return;
  if (data.mode === 'manual' || data.mode === 'auto') presetMode = data.mode;
  if (Array.isArray(data.custom)) {
    for (const p of data.custom) {
      const name = cleanName(p && p.name);
      const settings = sanitizeSettings(p && p.settings);
      if (!name || BUILTIN_NAMES.has(name) || !Object.keys(settings).length) continue;
      if (customPresets.some((c) => c.name === name)) continue;
      customPresets.push({ name, settings });
    }
  }
  if (data.tracks && typeof data.tracks === 'object') {
    for (const [key, v] of Object.entries(data.tracks)) {
      const settings = sanitizeSettings(v && v.settings);
      if (!Object.keys(settings).length) continue;
      trackMemory[key] = { preset: typeof v.preset === 'string' ? v.preset : null, settings };
    }
  }
}
function savePresets() {
  const ls = storage();
  if (!ls) return;
  try {
    ls.setItem(PRESET_STORE, JSON.stringify({ mode: presetMode, custom: customPresets, tracks: trackMemory }));
  } catch (e) { /* quota or blocked — presets stay in memory for this session */ }
}
function uniqueName(base, except) {
  const taken = (n) => BUILTIN_NAMES.has(n) || customPresets.some((p) => p.name === n && p.name !== except);
  if (!taken(base)) return base;
  for (let i = 2; i < 99; i++) if (!taken(`${base} ${i}`)) return `${base} ${i}`;
  return `${base} ${Date.now()}`;
}
function parseImport(text) {
  let data = null;
  try { data = JSON.parse(String(text || '')); } catch (e) { return { error: '不是合法 JSON' }; }
  const list = Array.isArray(data) ? data
    : (data && Array.isArray(data.presets)) ? data.presets
      : (data && data.settings) ? [data] : null;
  if (!list) return { error: '找不到预设数组' };
  const out = [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    const name = cleanName(p.name);
    const settings = sanitizeSettings(p.settings);
    if (!name || !Object.keys(settings).length) continue;
    out.push({ name, settings });
  }
  if (!out.length) return { error: '这里没有可用的预设' };
  return { presets: out };
}

function chipEl(p, custom, current) {
  const b = document.createElement('button');
  b.type = 'button';
  // Highlight only while the settings still ARE that preset: a chip that stays
  // lit after you drag a slider would be claiming something untrue.
  const on = activePreset === p.name && settingsEqual(current, p.settings);
  b.className = 'chip'
    + (on ? ' active' : '')
    + (armedDelete === p.name ? ' armed' : '');
  b.dataset.preset = p.name;
  b.title = custom ? `${p.name} · 双击改名` : `${p.name}（内置）`;
  const label = document.createElement('span');
  label.textContent = armedDelete === p.name ? '删除？' : p.name;
  b.appendChild(label);
  if (custom) {
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '×';
    x.title = '删除（再点一次确认）';
    b.appendChild(x);
  }
  return b;
}
function renderPresetUI() {
  for (const b of dom.presetMode.children) {
    b.setAttribute('aria-checked', String(b.dataset.mode === presetMode));
  }
  const current = captureSettings();
  dom.presetChips.textContent = '';
  for (const p of BUILTIN_PRESETS) dom.presetChips.appendChild(chipEl(p, false, current));
  for (const p of customPresets) dom.presetChips.appendChild(chipEl(p, true, current));
  renderPresetStatus();
}
/** Cheap enough to run on every input event: only toggles a class. */
function refreshChipStates() {
  const current = captureSettings();
  for (const b of dom.presetChips.children) {
    const p = findPreset(b.dataset.preset);
    b.classList.toggle('active', !!p && activePreset === p.name && settingsEqual(current, p.settings));
  }
}
function renderPresetStatus() {
  const where = trackLabel || '未加载音频';
  const p = activePreset ? findPreset(activePreset) : null;
  const el = dom.presetStatus;
  refreshChipStates();
  el.textContent = '';
  el.appendChild(document.createTextNode(`${where} — `));
  if (p) {
    const b = document.createElement('b');
    b.textContent = p.name;
    el.appendChild(b);
    if (!settingsEqual(captureSettings(), p.settings)) el.appendChild(document.createTextNode(' · 已微调'));
  } else {
    el.appendChild(document.createTextNode('自定义参数'));
  }
  if (presetMode === 'manual') el.appendChild(document.createTextNode(' · 手动'));
}
function onChipClick(ev) {
  const b = ev.target.closest('.chip');
  if (!b) return;
  const name = b.dataset.preset;
  const custom = customPresets.some((p) => p.name === name);
  if (ev.target.closest('.x') && custom) {
    clearTimeout(armTimer);
    if (armedDelete === name) {
      armedDelete = null;
      deletePreset(name);
    } else {
      armedDelete = name;
      armTimer = setTimeout(() => { armedDelete = null; renderPresetUI(); }, 3000);
      renderPresetUI();
    }
    return;
  }
  armedDelete = null;
  applyPreset(name);
}
function deletePreset(name) {
  const i = customPresets.findIndex((p) => p.name === name);
  if (i < 0) return;
  customPresets.splice(i, 1);
  if (activePreset === name) activePreset = null;
  for (const k of Object.keys(trackMemory)) {
    if (trackMemory[k].preset === name) trackMemory[k].preset = null;
  }
  savePresets();
  renderPresetUI();
  toast(`已删除「${name}」`);
}
function suggestName() {
  for (let i = 1; i < 99; i++) if (!findPreset(`我的预设 ${i}`)) return `我的预设 ${i}`;
  return '预设';
}
function openSaveRow(rename) {
  editingPreset = rename || null;
  dom.presetRow.hidden = false;
  dom.presetName.value = rename || suggestName();
  dom.presetName.focus();
  dom.presetName.select();
}
function closeSaveRow() {
  editingPreset = null;
  dom.presetRow.hidden = true;
}
function commitSave() {
  const wanted = cleanName(dom.presetName.value) || suggestName();
  const settings = captureSettings();
  if (!editingPreset && BUILTIN_NAMES.has(wanted)) {
    toast('内置预设不能覆盖，换个名字');
    return;
  }
  const name = uniqueName(wanted, editingPreset);
  const renameFrom = editingPreset;
  if (renameFrom) {
    const i = customPresets.findIndex((p) => p.name === renameFrom);
    if (i >= 0) customPresets[i] = { name, settings };
    else customPresets.push({ name, settings });
    if (activePreset === renameFrom) activePreset = name;
  } else {
    const dup = customPresets.find((p) => p.name === name);
    if (dup) dup.settings = settings;              // same name = overwrite
    else customPresets.push({ name, settings });
  }
  activePreset = name;
  closeSaveRow();
  savePresets();
  renderPresetUI();
  toast(renameFrom && renameFrom !== name ? `已重命名为「${name}」`
    : renameFrom ? `已更新「${name}」` : `已保存「${name}」`);
}
/* The box stays out of the way until it is needed: the preset group sits at
   the top of the panel, so an always-empty textarea would push every everyday
   control further down the scroll for the 1 % of the time it is in use. */
function doExport() {
  dom.presetText.hidden = false;
  dom.presetText.focus();
  if (!customPresets.length) {
    dom.presetText.value = '';
    toast('还没有自定义预设');
    return;
  }
  /* 2 spaces: this text is meant to be read and hand-edited, and the whole
     project indents in twos. (It was 1 for a while, which looked like a typo.) */
  dom.presetText.value = JSON.stringify({ kind: EXPORT_KIND, v: 1, presets: customPresets }, null, 2);
  dom.presetText.select();
  toast(`已导出 ${customPresets.length} 个预设，复制这段文本即可`);
}
function doImport() {
  if (dom.presetText.hidden) {
    dom.presetText.hidden = false;
    dom.presetText.value = '';
    dom.presetText.focus();
    toast('粘贴预设文本，再点一次「导入」');
    return;
  }
  if (!dom.presetText.value.trim()) { toast('先粘贴一段预设文本'); return; }
  const r = parseImport(dom.presetText.value);
  if (r.error) { toast(`导入失败：${r.error}`); return; }
  for (const p of r.presets) customPresets.push({ name: uniqueName(p.name), settings: p.settings });
  dom.presetText.value = '';
  dom.presetText.hidden = true;      // done with it — give the panel its space back
  savePresets();
  renderPresetUI();
  toast(`已导入 ${r.presets.length} 个预设`);
}
function setPresetMode(mode) {
  presetMode = mode === 'manual' ? 'manual' : 'auto';
  savePresets();
  renderPresetUI();
  if (presetMode === 'auto') restoreTrackSettings();   // honour the memory right away
  toast(presetMode === 'auto' ? '预设：自动（按曲记忆）' : '预设：手动');
}
function initPresets() {
  loadPresets();
  dom.presetChips.addEventListener('click', onChipClick);
  dom.presetChips.addEventListener('dblclick', (ev) => {
    const b = ev.target.closest('.chip');
    if (b && customPresets.some((p) => p.name === b.dataset.preset)) openSaveRow(b.dataset.preset);
  });
  dom.presetMode.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-mode]');
    if (b) setPresetMode(b.dataset.mode);
  });
  $('btnPresetSave').addEventListener('click', () => openSaveRow(null));
  $('btnPresetCommit').addEventListener('click', commitSave);
  $('btnPresetCancel').addEventListener('click', closeSaveRow);
  $('btnPresetExport').addEventListener('click', doExport);
  $('btnPresetImport').addEventListener('click', doImport);
  dom.presetName.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); commitSave(); }
    else if (ev.key === 'Escape') { ev.preventDefault(); closeSaveRow(); }
  });
  renderPresetUI();
}


export {
  BUILTIN_NAMES,
  BUILTIN_PRESETS,
  EXPORT_KIND,
  PRESET_STORE,
  allPresets,
  applyPreset,
  builtinPreset,
  chipEl,
  cleanName,
  closeSaveRow,
  commitSave,
  deletePreset,
  doExport,
  doImport,
  findPreset,
  initPresets,
  loadPresets,
  noteSettingsChanged,
  onChipClick,
  openSaveRow,
  parseImport,
  recordTrackSettings,
  refreshChipStates,
  renderPresetStatus,
  renderPresetUI,
  restoreTrackSettings,
  savePresets,
  setActivePreset,
  setPresetMode,
  setTrackKey,
  storage,
  suggestName,
  uniqueName,
};
