import * as core from './core.js';
import * as audio from './audio.js';
import * as render from './render.js';

const {
  $,
  BUCKETS,
  DEFAULTS,
  FORMATTERS,
  MAXN,
  PRESET_COLORS,
  S,
  TAU,
  WINDOW_CHOICES,
  clamp,
  dom,
  flags,
  fmtBytes,
  fmtHz,
  fmtTime,
  setHint,
  stamp,
  toast,
  winSize,
} = core;
const {
  applyAnalyserSize,
  applyRateMode,
  buildDemo,
  buildEngine,
  clampRate,
  currentAnalysers,
  desiredRate,
  ensureEngineRate,
  ensureGraph,
  isDemo,
  isLive,
  makeAnalyser,
  rateText,
  readSignal,
  resumeContext,
  setDemoSource,
  setElementHook,
  setSourceRate,
  signal,
  status,
  teardownEngine,
  updateRateBadge,
} = audio;
const {
  adaptQuality,
  applyScale,
  clearBurnIn,
  composite,
  drawBackground,
  drawTrace,
  effectiveDpr,
  fadeAlpha,
  fadeLayer,
  findTrigger,
  hexToRgb,
  layout,
  loop,
  paintInto,
  panelInset,
  recordWork,
  resetQuality,
  resetRefSpeed,
  resetTraceState,
  resetWorkStats,
  resettle,
  resizeKeeping,
  scaleLabel,
  scrubAlpha,
  setTickHandler,
  startLoop,
  state,
  updateBurnIn,
  updatePerfBadge,
  workSorted,
  workStat,
  workTrimmed,
} = render;

/* ============================================================================
 *  Web Oscilloscope Music Player / Visualizer
 *  ---------------------------------------------------------------------------
 *  Renders a stereo signal as an X/Y beam path:  left channel -> X, right -> Y.
 *
 *  DESIGN CONSTRAINTS (explicitly requested)
 *  ---------------------------------------------------------------------------
 *  1. NO RETRACE LINES (无回扫线)
 *     - A trace path is never `closePath()`d, so the beam never jumps from the
 *       end of a sweep back to its start.
 *     - Every frame starts a fresh sub-path with `moveTo()`; segments are never
 *       joined across analysis frames, so no wrap-around chord is ever drawn.
 *     - Optional VELOCITY BLANKING dims fast beam movements (brightness ∝ 1/v).
 *       Retrace/blanking sweeps in oscilloscope music are fast, so they fade to
 *       near-invisible exactly as they do on a real CRT — this is the principled
 *       way to kill retrace lines, not a post-process trick.
 *
 *  2. NO GLOW (无辉光)
 *     - No `shadowBlur` / `shadowColor`, no bloom pass.
 *     - No `globalCompositeOperation = 'lighter'` (additive) accumulation.
 *     - No CSS blur/drop-shadow filter anywhere near the canvas.
 *     - Afterglow uses `destination-out` alpha decay: pixels only ever get
 *       *dimmer*, they never add brightness to their neighbours.
 * ========================================================================== */



/* --------------------------------------------------------------- presets */

/* A preset captures the LOOK — everything that decides the picture. The two
   exceptions are rateMode and renderScale: those describe the machine you
   happen to be sitting at, and a preset that silently moved someone else's
   audio engine to 192 kHz would be a bug, not a feature. */
const PRESET_KEYS = Object.keys(DEFAULTS).filter((k) => k !== 'rateMode' && k !== 'renderScale');
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



/* -------------------------------------------------------------- playlist */

let tracks = [];
let curIndex = -1;

function renderPlaylist() {
  const ul = dom.trackList;
  ul.textContent = '';
  if (!tracks.length) {
    const li = document.createElement('li');
    li.className = 'empty-note';
    li.textContent = location.protocol === 'file:'
      ? '单文件版无法自动读取本地目录。\n把音频文件拖进窗口，或点下方按钮选择。'
      : '项目目录里没有找到音频文件。\n拖入文件，或用下方按钮添加。';
    li.style.whiteSpace = 'pre-line';
    ul.appendChild(li);
    dom.listCount.textContent = '';
    return;
  }
  tracks.forEach((t, i) => {
    const li = document.createElement('li');
    li.className = 'track' + (i === curIndex ? ' active' : '');
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = String(i + 1).padStart(2, '0');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = t.name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = t.meta || '';
    li.append(n, name, meta);
    li.addEventListener('click', () => loadTrack(i, true));
    ul.appendChild(li);
  });
  dom.listCount.textContent = `(${tracks.length})`;
}

async function loadServerTracks() {
  if (location.protocol === 'file:') return false;
  try {
    const res = await fetch('/api/tracks', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!Array.isArray(data.tracks) || !data.tracks.length) return false;
    tracks = data.tracks.map((t) => ({
      name: t.name,
      url: t.url,
      blob: false,
      sampleRate: t.sampleRate || 0,
      meta: [
        t.format,
        t.sampleRate ? `${fmtHz(t.sampleRate)}` : null,
        t.bits ? `${t.bits}-bit` : null,
        t.channels === 2 ? '立体声' : t.channels ? `${t.channels}ch` : null,
        t.durationText,
        t.sizeText,
      ].filter(Boolean).join(' · '),
    }));
    renderPlaylist();
    return true;
  } catch (err) {
    return false;   // standalone / file:// — the file picker takes over
  }
}

const AUDIO_RE = /\.(wav|wave|flac|mp3|m4a|aac|ogg|oga|opus|weba|webm|aif|aiff|caf)$/i;

/* Read the native sample rate straight out of the file header (a small
   leading slice — nothing is decoded). Needed so a local file can get an
   engine at its own rate instead of being resampled into the device rate.
   Same logic as server.js uses for the playlist. */
async function probeNativeRate(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 262144).arrayBuffer());
    const dv = new DataView(head.buffer);
    const tag = (o) => String.fromCharCode(head[o] || 0, head[o + 1] || 0, head[o + 2] || 0, head[o + 3] || 0);

    // ---- WAV / RIFF
    if (tag(0) === 'RIFF' && tag(8) === 'WAVE') {
      let off = 12;
      while (off + 24 <= head.length) {
        const id = tag(off);
        const size = dv.getUint32(off + 4, true);
        if (id === 'fmt ') {
          return {
            format: 'WAV',
            rate: dv.getUint32(off + 12, true),
            channels: dv.getUint16(off + 10, true),
            bits: dv.getUint16(off + 22, true),
          };
        }
        if (id === 'data') break;
        off += 8 + size + (size % 2);
      }
    }

    // ---- FLAC / STREAMINFO
    if (tag(0) === 'fLaC' && head.length >= 42) {
      const b = head.subarray(8, 42);
      const bits = (bitOff, count) => {
        let v = 0;
        for (let i = 0; i < count; i++) { const p = bitOff + i; v = v * 2 + ((b[p >> 3] >> (7 - (p & 7))) & 1); }
        return v;
      };
      return { format: 'FLAC', rate: bits(80, 20), channels: bits(100, 3) + 1, bits: bits(103, 5) + 1 };
    }

    // ---- MP3 (first MPEG frame header)
    const scan = Math.min(head.length - 4, 65536);
    for (let i = 0; i < scan; i++) {
      if (head[i] !== 0xff || (head[i + 1] & 0xe0) !== 0xe0) continue;
      const ver = (head[i + 1] >> 3) & 3;
      const srIdx = (head[i + 2] >> 2) & 3;
      if (ver === 1 || srIdx === 3) continue;
      const table = ver === 3 ? [44100, 48000, 32000]
        : ver === 2 ? [22050, 24000, 16000]
          : [11025, 12000, 8000];
      return { format: 'MP3', rate: table[srIdx], channels: ((head[i + 3] >> 6) & 3) === 3 ? 1 : 2, bits: 16 };
    }

    // ---- MP4 / M4A (mdhd timescale)
    const ascii = Array.from(head.subarray(0, Math.min(head.length, 262144)), (c) => String.fromCharCode(c)).join('');
    const mi = ascii.indexOf('mdhd');
    if (mi >= 0) {
      const version = head[mi + 4];
      const tsOff = mi + 4 + 4 + (version === 1 ? 16 : 8);
      if (tsOff + 4 <= head.length) return { format: 'M4A', rate: dv.getUint32(tsOff), channels: 2, bits: 16 };
    }
  } catch (err) { /* unreadable header — fall back to the device rate */ }
  return null;
}

function describeAudio(info, size) {
  if (!info) return fmtBytes(size);
  return [
    info.format,
    info.rate ? rateText(info.rate) : null,
    info.bits ? `${info.bits}-bit` : null,
    info.channels === 2 ? '立体声' : info.channels ? `${info.channels}ch` : null,
    fmtBytes(size),
  ].filter(Boolean).join(' · ');
}

async function addLocalFiles(files) {
  const list = Array.from(files).filter((f) => /^audio\//.test(f.type) || AUDIO_RE.test(f.name));
  if (!list.length) { toast('没有识别到音频文件'); return; }
  setDemo(false);
  const first = tracks.length;
  for (const f of list) {
    const info = await probeNativeRate(f);
    tracks.push({
      name: f.name,
      url: URL.createObjectURL(f),
      blob: true,
      sampleRate: info && info.rate ? info.rate : 0,
      meta: describeAudio(info, f.size),
    });
  }
  renderPlaylist();
  loadTrack(first, true);
}

/** Rebuild the <audio> element around the engine change and restore where the
 *  listener was. audio.js drives this because it owns the graph; knowing which
 *  file that is, is this layer's job. */
function reloadCurrentSource({ wasDemo, time, playing }) {
  if (wasDemo) { setDemo(true); return; }
  const t = tracks[curIndex];
  if (!t) return;
  dom.audio.src = t.url;
  if (time > 0.05) {
    const onMeta = () => {
      dom.audio.removeEventListener('loadedmetadata', onMeta);
      try { dom.audio.currentTime = time; } catch (e) { /* ignore */ }
      if (playing) play();
    };
    dom.audio.addEventListener('loadedmetadata', onMeta);
  } else if (playing) {
    play();
  }
}

function loadTrack(i, autoplay) {
  const t = tracks[i];
  if (!t) return;
  const same = i === curIndex && !audio.isDemo();
  if (audio.isDemo()) setDemo(false);
  curIndex = i;
  // Build/rebuild the engine at this file's own rate *before* loading, so the
  // media is never resampled into the device rate on the analysis path.
  audio.setSourceRate(t.sampleRate);
  ensureEngineRate();
  dom.audio.src = t.url;
  dom.audio.load();

  dom.trackTitle.textContent = t.name;
  dom.trackSub.textContent = t.meta || '';
  document.title = `${t.name} · 示波器音乐播放器`;
  setHint(false);
  renderPlaylist();
  // Re-selecting the same row must not undo tweaks the user has not saved yet.
  if (!same) restoreTrackSettings();
  render.resetTraceState();

  if (autoplay) play();
}

/* --------------------------------------------------------------- playback */

async function play() {
  resumeContext();
  if (audio.isDemo()) {
    if (!dom.audio.src) return;   // nothing to switch to — stay on the demo
    setDemo(false);              // playing a track leaves demo mode
  }
  if (!dom.audio.src) {
    if (tracks.length) { loadTrack(curIndex >= 0 ? curIndex : 0, true); return; }
    setHint(true);
    toast('先载入一个音频文件');
    return;
  }
  try {
    await dom.audio.play();
  } catch (err) {
    if (err && err.name === 'NotAllowedError') toast('被浏览器拦截，请再点一次 ▶');
    else toast('无法播放：' + (err && err.message ? err.message : err));
  }
}

function togglePlay() {
  if (dom.audio.paused || dom.audio.ended) play();
  else dom.audio.pause();
}

function nextTrack(step) {
  if (!tracks.length) return;
  const i = (curIndex + step + tracks.length) % tracks.length;
  loadTrack(i, true);
}

function seekBy(delta) {
  const d = dom.audio.duration;
  if (!Number.isFinite(d)) return;
  dom.audio.currentTime = clamp(dom.audio.currentTime + delta, 0, d);
  flags.redraw = true;
}

/* ------------------------------------------------------------ main loop */

/* ------------------------------------------------------- transport UI sync */

const uiCache = { cur: -1, dur: -1, seek: -1 };

function updateTransportUI() {
  const a = dom.audio;
  const cur = Number.isFinite(a.currentTime) ? a.currentTime : 0;
  const dur = Number.isFinite(a.duration) ? a.duration : 0;

  if (Math.abs(cur - uiCache.cur) >= 0.06 || Math.abs(dur - uiCache.dur) > 0.2) {
    uiCache.cur = cur;
    uiCache.dur = dur;
    dom.tCur.textContent = fmtTime(cur);
    dom.tDur.textContent = Number.isFinite(a.duration) ? fmtTime(dur) : '--:--';
    const pct = dur > 0 ? clamp((cur / dur) * 100, 0, 100) : 0;
    if (!seekHeld) {
      dom.seek.value = String(Math.round(pct * 10));
      dom.seek.style.setProperty('--p', pct.toFixed(2));
    }
  }
}

let seekHeld = false;

/* ------------------------------------------------------------- UI wiring */

function applyAccent(color) {
  document.documentElement.style.setProperty('--accent', color);
  for (const sw of dom.swatches.children) {
    sw.classList.toggle('active', sw.dataset.color.toLowerCase() === String(color).toLowerCase());
  }
  drawBackground();   // the graticule is tinted from the same colour
  flags.redraw = true;
}

function syncControlsFromState() {
  for (const el of document.querySelectorAll('[data-set]')) {
    el.value = S[el.dataset.set];
    const out = document.querySelector(`[data-out="${el.dataset.set}"]`);
    if (out) out.textContent = FORMATTERS[el.dataset.set](S[el.dataset.set]);
  }
  for (const btn of document.querySelectorAll('[data-toggle]')) {
    btn.setAttribute('aria-pressed', String(!!S[btn.dataset.toggle]));
  }
  const rm = $('rateMode');
  if (rm) rm.value = S.rateMode;
  const rs = $('renderScale');
  if (rs) rs.value = S.renderScale;
  const br = document.querySelector('[data-set="blankRatio"]');
  if (br) {
    br.disabled = !S.blanking;
    if (br.parentElement) br.parentElement.classList.toggle('is-off', !S.blanking);
  }
  updateBurnIn(false);
  applyAccent(S.color);
}

function bindControls() {
  for (const el of document.querySelectorAll('[data-set]')) {
    const key = el.dataset.set;
    const out = document.querySelector(`[data-out="${key}"]`);
    const onInput = () => {
      S[key] = el.type === 'range' ? parseFloat(el.value) : el.value;
      if (out) out.textContent = FORMATTERS[key](S[key]);
      if (key === 'color') applyAccent(S.color);
      if (key === 'windowIdx') { render.resetRefSpeed(); applyAnalyserSize(); }
      if (key === 'burnIn') updateBurnIn(false);
      flags.redraw = true;
      noteSettingsChanged();
    };
    el.addEventListener('input', onInput);
  }

  // colour presets
  for (const c of PRESET_COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.dataset.color = c;
    b.style.setProperty('--c', c);
    b.title = c;
    b.addEventListener('click', () => {
      S.color = c;
      const input = document.querySelector('[data-set="color"]');
      input.value = c;
      const out = document.querySelector('[data-out="color"]');
      if (out) out.textContent = c.toUpperCase();
      applyAccent(c);
      flags.redraw = true;
      noteSettingsChanged();
    });
    dom.swatches.appendChild(b);
  }

  for (const btn of document.querySelectorAll('[data-toggle]')) {
    const key = btn.dataset.toggle;
    btn.setAttribute('aria-pressed', String(!!S[key]));
    btn.addEventListener('click', () => {
      S[key] = !S[key];
      btn.setAttribute('aria-pressed', String(S[key]));
      if (key === 'grid') drawBackground();
      if (key === 'trigger') render.resetRefSpeed();
      if (key === 'blanking') syncControlsFromState();   // enable/disable the threshold row
      flags.redraw = true;
      noteSettingsChanged();
    });
  }

  for (const el of document.querySelectorAll('[data-close]')) {
    el.addEventListener('click', () => $(el.dataset.close).classList.remove('open'));
  }

  // transport
  dom.btnPlay.addEventListener('click', togglePlay);
  dom.btnPrev.addEventListener('click', () => nextTrack(-1));
  dom.btnNext.addEventListener('click', () => nextTrack(1));
  dom.btnDemo.addEventListener('click', () => {
    const turningOn = !audio.isDemo();
    setDemo(turningOn);
    if (turningOn && !S.trigger) { S.trigger = true; syncControlsFromState(); }
    if (turningOn) toast('演示信号');
  });
  dom.btnSettings.addEventListener('click', () => togglePanel('panelSettings'));
  dom.btnList.addEventListener('click', () => togglePanel('panelList'));

  dom.btnFull.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => toast('无法进入全屏'));
  });
  dom.btnShot.addEventListener('click', screenshot);
  dom.btnReset.addEventListener('click', () => {
    resetSettings();
    toast('已恢复默认设置');
  });

  const openPicker = () => dom.fileInput.click();
  $('btnOpen').addEventListener('click', openPicker);
  $('hintOpen').addEventListener('click', (e) => { e.stopPropagation(); openPicker(); });
  dom.fileInput.addEventListener('change', () => {
    if (dom.fileInput.files && dom.fileInput.files.length) addLocalFiles(dom.fileInput.files);
    dom.fileInput.value = '';
  });
  dom.hint.addEventListener('click', () => { if (tracks.length || dom.audio.src) play(); });

  // seek
  dom.seek.addEventListener('pointerdown', () => { seekHeld = true; });
  dom.seek.addEventListener('input', () => {
    const d = dom.audio.duration;
    if (Number.isFinite(d) && d > 0) {
      const pct = Number(dom.seek.value) / 10;
      dom.seek.style.setProperty('--p', pct.toFixed(2));
      dom.audio.currentTime = (pct / 100) * d;
      dom.tCur.textContent = fmtTime(dom.audio.currentTime);
    }
    flags.redraw = true;
  });
  const releaseSeek = () => { seekHeld = false; };
  dom.seek.addEventListener('pointerup', releaseSeek);
  dom.seek.addEventListener('pointercancel', releaseSeek);
  dom.seek.addEventListener('change', releaseSeek);

  dom.volume.addEventListener('input', () => { dom.audio.volume = Number(dom.volume.value); });
  dom.rate.addEventListener('change', () => {
    dom.audio.preservesPitch = true;
    dom.audio.playbackRate = Number(dom.rate.value);
  });
  dom.audio.volume = Number(dom.volume.value);

  const rateModeSel = $('rateMode');
  if (rateModeSel) {
    rateModeSel.value = S.rateMode;
    rateModeSel.addEventListener('change', () => {
      S.rateMode = rateModeSel.value;
      applyRateMode();
      const eng = audio.status().engineRate;
      const srcRate = audio.status().sourceRate;
      toast(!eng ? '引擎跟随设备采样率'
        : !srcRate ? `引擎 ${rateText(eng)}`
          : `引擎 ${rateText(eng)} · ${eng === srcRate ? '原生' : `源 ${rateText(srcRate)} · 重采样`}`);
    });
  }

  const scaleSel = $('renderScale');    if (scaleSel) {
    scaleSel.value = S.renderScale;
    scaleSel.addEventListener('change', () => {
      S.renderScale = scaleSel.value;
      if (S.renderScale === 'auto') { render.resetQuality(); }
      applyScale();
      toast(`渲染缩放 ${Math.round(effectiveDpr() * 100)}%`);
    });
  }

  const perfBtn = $('btnPerf');
  if (perfBtn) perfBtn.addEventListener('click', () => setPerfMode(!perfSnapshot));

  window.addEventListener('resize', () => { if (layout()) flags.redraw = true; });
  if (window.ResizeObserver) {
    new ResizeObserver(() => { if (layout()) flags.redraw = true; }).observe(dom.stage);
  }
  document.addEventListener('fullscreenchange', () => { if (layout()) flags.redraw = true; });
}

/** Audio-element listeners. Re-attached every time the engine rebuilds the
 *  element (a new AudioContext needs a new <audio> — see buildEngine). */
function bindAudioEvents(el) {
  el.addEventListener('play', () => {
    dom.btnPlay.classList.add('playing');
    flags.redraw = true;
  });
  el.addEventListener('pause', () => dom.btnPlay.classList.remove('playing'));
  el.addEventListener('ended', () => {
    dom.btnPlay.classList.remove('playing');
    if (tracks.length > 1) nextTrack(1);
  });
  el.addEventListener('error', () => {
    if (!el.src) return;
    const code = el.error ? el.error.code : 0;
    toast(code === 4 ? '浏览器无法解码此文件' : '音频加载失败');
  });
  el.addEventListener('seeking', () => { flags.redraw = true; });
  el.addEventListener('loadedmetadata', () => {
    uiCache.dur = -1;
    flags.redraw = true;
  });
}

/** Restore every setting to its default, including the derived state that
 *  syncControlsFromState() alone does not touch (analyser size, render
 *  scale, smoothing accumulators). Forgetting the analyser size here left a
 *  4096-sample window being drawn out of a 1024-sample buffer. */
/** Switch the visible source to/from the built-in demo. audio.js owns the
 *  graph; the titles, the button, the preset memory and the render state are
 *  this layer's business — which is why the engine takes a hook instead. */
function setDemo(on) {
  if (!audio.setDemoSource(on)) return;
  if (on) {
    dom.audio.pause();
    dom.btnDemo.classList.add('on');
    dom.trackTitle.textContent = '演示信号 · Demo';
    dom.trackSub.textContent = '内置合成器 · 3:2 利萨如曲线';
    document.title = '演示信号 · 示波器音乐播放器';
    setHint(false);
    flags.redraw = true;
    render.resetRefSpeed();
    restoreTrackSettings();   // the demo is remembered like any other "track"
  } else {
    dom.btnDemo.classList.remove('on');
    restoreTitle();
  }
}

function restoreTitle() {
  const t = tracks[curIndex];
  if (t) {
    dom.trackTitle.textContent = t.name;
    dom.trackSub.textContent = t.meta || '';
    document.title = `${t.name} · 示波器音乐播放器`;
  } else {
    dom.trackTitle.textContent = '未加载音频';
    dom.trackSub.textContent = '拖入文件，或打开播放列表';
    document.title = '示波器音乐播放器 · Oscilloscope Music Player';
  }
}

function resetSettings() {
  Object.assign(S, DEFAULTS);
  render.resetQuality();
  render.resetTraceState({ settle: true });
  syncControlsFromState();
  applyAnalyserSize();
  applyScale();
  drawBackground();
  updateBurnIn(true);
  activePreset = '默认';      // defaults ARE the 默认 preset, for the keys it covers
  noteSettingsChanged();
}

/** One-click low-power preset. The levers are chosen from measurements in
 *  test/bench.js: the per-frame cost is dominated by how many segments get
 *  drawn, so shrinking the window is what actually helps (32768 -> 1024 took
 *  a frame from 1.49 ms to 0.08 ms). Render scale barely moved the needle. */
let perfSnapshot = null;

function setPerfMode(on) {
  const btn = $('btnPerf');
  if (on) {
    if (!perfSnapshot) {
      perfSnapshot = {
        windowIdx: S.windowIdx, grid: S.grid, persistence: S.persistence,
        rateMode: S.rateMode, renderScale: S.renderScale,
      };
    }
    S.windowIdx = 2;        // 2048 samples
    S.grid = false;
    S.persistence = 45;
    S.rateMode = 'device';  // let the audio graph run at the device rate
    S.renderScale = '0.75';
  } else if (perfSnapshot) {
    Object.assign(S, perfSnapshot);
    perfSnapshot = null;
  }
  if (btn) btn.setAttribute('aria-pressed', String(!!on));

  syncControlsFromState();
  applyAnalyserSize();
  applyRateMode();
  applyScale();
  drawBackground();
  render.resetRefSpeed();
  flags.settle = 100;
  activePreset = null;   // perf mode is a machine setting, not a preset
  noteSettingsChanged();
  toast(on ? '性能模式：开' : '性能模式：关');
}

function togglePanel(id) {
  const p = $(id);
  const open = !p.classList.contains('open');
  p.classList.toggle('open', open);
  $(id === 'panelSettings' ? 'btnSettings' : 'btnList').classList.toggle('on', open);
  if (layout()) { flags.redraw = true; flags.settle = 100; }   // the plot may need to give up margin
  // Left and right rails are independent now that they reserve their own
  // space, so both panels can be open at once.
}

function screenshot() {
  const c = render.composite();
  if (!c) return;
  c.toBlob((blob) => {
    if (!blob) return toast('截图失败');
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = `oscilloscope-${stamp()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
    toast('已保存 PNG');
  }, 'image/png');
}

/* ---------------------------------------------------------------- presets */

function storage() {
  try { return window.localStorage; } catch (e) { return null; }   // file://, private mode
}

function cleanName(v) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
}

/** Snap a number onto its control's own grid. Presets arrive from storage and
 *  from other people's exports, and a value the slider cannot express would
 *  make the readout disagree with what is actually rendering — the exact bug
 *  class this file keeps having to fix. */
function snapToControl(key, n) {
  const el = document.querySelector(`[data-set="${key}"]`);
  let v = n;
  if (!el) return v;
  const min = Number(el.min);
  const max = Number(el.max);
  const step = Number(el.step);
  if (Number.isFinite(step) && step > 0) {
    const base = Number.isFinite(min) ? min : 0;
    v = Number((base + Math.round((v - base) / step) * step).toFixed(4));
  }
  if (Number.isFinite(min)) v = Math.max(min, v);
  if (Number.isFinite(max)) v = Math.min(max, v);
  return v;
}

/** Keep only keys we know, with types the UI can express. */
function sanitizeSettings(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of PRESET_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
    const ref = DEFAULTS[k];
    const v = raw[k];
    if (typeof ref === 'number') {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = snapToControl(k, k === 'windowIdx' ? Math.round(n) : n);
    } else if (typeof ref === 'boolean') {
      out[k] = v === true || v === 'true' || v === 1;
    } else if (k === 'color') {
      if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) out[k] = v.toLowerCase();
    }
  }
  return out;
}

function captureSettings() {
  const out = {};
  for (const k of PRESET_KEYS) out[k] = S[k];
  return out;
}

function settingsEqual(a, b) {
  if (!a || !b) return false;
  for (const k of PRESET_KEYS) {
    const x = a[k];
    const y = b[k];
    if (typeof x === 'number' && typeof y === 'number') {
      if (Math.abs(x - y) > 1e-6) return false;
    } else if (x !== y) return false;
  }
  return true;
}

const allPresets = () => BUILTIN_PRESETS.concat(customPresets);
const findPreset = (name) => allPresets().find((p) => p.name === name) || null;

function applySettings(raw) {
  Object.assign(S, sanitizeSettings(raw));
  render.resetTraceState({ settle: true });
  syncControlsFromState();     // sliders, toggles, colour and the dependent rows
  audio.applyAnalyserSize();   // the window may have moved
}

function applyPreset(name) {
  const p = findPreset(name);
  if (!p) return;
  applySettings(p.settings);
  activePreset = name;
  noteSettingsChanged();
  renderPresetUI();
  toast(`预设：${name}`);
}

function currentTrackKey() {
  if (audio.isDemo()) return '@demo';
  const t = tracks[curIndex];
  return t ? t.name : null;
}

/* Every change is recorded for the track you are looking at, in BOTH modes:
   manual mode only declines to *apply* it automatically, and keeping the
   record means switching modes later does not lose anything. */
function noteSettingsChanged() {
  renderPresetStatus();
  clearTimeout(recordTimer);
  recordTimer = setTimeout(recordTrackSettings, 400);
}

function recordTrackSettings() {
  const key = currentTrackKey();
  if (!key) return;
  trackMemory[key] = { preset: activePreset, settings: captureSettings() };
  const keys = Object.keys(trackMemory);
  if (keys.length > 80) delete trackMemory[keys[0]];   // bound the store
  savePresets();
}

function restoreTrackSettings() {
  if (presetMode === 'manual') { renderPresetStatus(); return; }
  const key = currentTrackKey();
  const entry = key ? trackMemory[key] : null;
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

/* ------------------------------------------------------------- preset ui */

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
  const where = audio.isDemo() ? '演示信号' : (currentTrackKey() || '未加载音频');
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
  dom.presetText.value = JSON.stringify({ kind: EXPORT_KIND, v: 1, presets: customPresets }, null, 1);
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


/* -------------------------------------------------------------- keyboard */

function onKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  const typing = t && t.closest && t.closest('input, select, textarea');
  if (typing && e.key !== 'Escape') return;

  switch (e.key) {
    case ' ': case 'k': case 'K':
      e.preventDefault(); togglePlay(); break;
    case 'ArrowLeft': e.preventDefault(); seekBy(-5); break;
    case 'ArrowRight': e.preventDefault(); seekBy(5); break;
    case 'ArrowUp':
      e.preventDefault();
      dom.volume.value = String(clamp(Number(dom.volume.value) + 0.05, 0, 1));
      dom.audio.volume = Number(dom.volume.value);
      toast(`音量 ${Math.round(dom.audio.volume * 100)}%`);
      break;
    case 'ArrowDown':
      e.preventDefault();
      dom.volume.value = String(clamp(Number(dom.volume.value) - 0.05, 0, 1));
      dom.audio.volume = Number(dom.volume.value);
      toast(`音量 ${Math.round(dom.audio.volume * 100)}%`);
      break;
    case ',': nextTrack(-1); break;
    case '.': nextTrack(1); break;
    case 'd': case 'D': {
      const on = !audio.isDemo();
      setDemo(on);
      if (on && !S.trigger) { S.trigger = true; syncControlsFromState(); }
      break;
    }
    case 'l': case 'L': togglePanel('panelList'); break;
    case 'p': case 'P': togglePanel('panelSettings'); break;
    case 'f': case 'F':
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
      break;
    case 's': case 'S': screenshot(); break;
    case 'g': case 'G': S.grid = !S.grid; syncControlsFromState(); drawBackground(); flags.redraw = true; break;
    case 'b': case 'B': S.blanking = !S.blanking; syncControlsFromState(); toast('速度消隐 ' + (S.blanking ? '开' : '关')); break;
    case 't': case 'T': S.trigger = !S.trigger; syncControlsFromState(); render.resetRefSpeed(); toast('相位锁定 ' + (S.trigger ? '开' : '关')); break;
    case 'r': case 'R':
      resetSettings();
      toast('已恢复默认设置'); break;
    case 'o': case 'O':
      setPerfMode(!perfSnapshot); break;
    case 'Escape':
      dom.panelSettings.classList.remove('open');
      dom.panelList.classList.remove('open');
      dom.btnSettings.classList.remove('on');
      dom.btnList.classList.remove('on');
      break;
    default: break;
  }
}

/* ------------------------------------------------------- drag & drop + idle */

function bindDragDrop() {
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    depth++;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    depth = Math.max(0, depth - 1);
    if (!depth) document.body.classList.remove('dragging');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      addLocalFiles(e.dataTransfer.files);
    }
  });

  // hide the chrome when the pointer is idle and not over any control
  let idleTimer = 0;
  let overUI = false;
  const wake = () => {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const panelOpen = document.querySelector('.panel.open');
      if (!overUI && !panelOpen && !document.body.classList.contains('dragging')) {
        document.body.classList.add('idle');
      }
    }, 3200);
  };
  for (const el of [document.querySelector('.dock'), document.querySelector('.topbar')]) {
    el.addEventListener('pointerenter', () => { overUI = true; wake(); });
    el.addEventListener('pointerleave', () => { overUI = false; wake(); });
  }
  for (const el of [dom.panelSettings, dom.panelList]) {
    el.addEventListener('pointerenter', () => { overUI = true; wake(); });
    el.addEventListener('pointerleave', () => { overUI = false; wake(); });
  }
  window.addEventListener('pointermove', wake, { passive: true });
  window.addEventListener('pointerdown', wake, { passive: true });
  wake();
}

/* ------------------------------------------------------------ debug seam */

/* Read-only view of the engine, used by test/verify.js to assert that the
   analysis path really is running at the file's native rate (and therefore
   that no resampling is happening). Harmless in normal use. */
window.__scope = {
  get state() {
    return Object.assign(render.state(), audio.status());
  },
  readAnalyser() {
    const a = currentAnalysers();
    if (!a) return null;
    const L = new Float32Array(MAXN);
    const R = new Float32Array(MAXN);
    a[0].getFloatTimeDomainData(L);
    a[1].getFloatTimeDomainData(R);
    return { engineRate: audio.status().engineRate, L: Array.from(L), R: Array.from(R) };
  },
  setRateMode(mode) {
    S.rateMode = String(mode);
    syncControlsFromState();
    applyRateMode();
    return desiredRate();
  },
  resetWorkStats,
};

/* ------------------------------------------------------------------ init */

async function init() {
  layout();
  applyAnalyserSize();
  bindAudioEvents(dom.audio);
  audio.setElementHook(bindAudioEvents);
  audio.setSourceReloader(reloadCurrentSource);
  bindControls();
  initPresets();
  bindDragDrop();
  syncControlsFromState();
  updatePerfBadge();
  const scaleOut = document.querySelector('[data-out="renderScale"]');
  if (scaleOut) scaleOut.textContent = scaleLabel();
  dom.volume.value = '0.85';
  dom.audio.volume = 0.85;

  if (location.protocol === 'file:') {
    dom.hintNote.textContent = '浏览器不允许网页读取本地目录，请选择或拖入文件';
  } else {
    dom.hintNote.textContent = '已自动列出项目目录下的音频文件';
  }

  renderPlaylist();
  render.setTickHandler(updateTransportUI);
  render.startLoop();

  const found = await loadServerTracks();
  if (found) {
    const first = tracks.findIndex((t) => /oscillo/i.test(t.name));
    loadTrack(first >= 0 ? first : 0, false);
    toast(`已找到 ${tracks.length} 个音频文件`);
  }

  const params = new URLSearchParams(location.search);
  if (params.has('demo')) {
    setDemo(true);
    if (!S.trigger) { S.trigger = true; syncControlsFromState(); }
  }
  if (params.has('track')) {
    const idx = Number(params.get('track'));
    if (Number.isFinite(idx) && tracks[idx]) loadTrack(idx, tracks.length > 0);
  }
  if (params.has('play') && tracks.length) play();

  // Some browsers need one gesture before the AudioContext may run.
  const unlock = () => { resumeContext(); window.removeEventListener('pointerdown', unlock); };
  window.addEventListener('pointerdown', unlock, { once: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
