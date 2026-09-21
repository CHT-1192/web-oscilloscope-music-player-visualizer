import * as core from './core.js';
import * as audio from './audio.js';
import * as render from './render.js';
import * as ui from './ui.js';
import * as playlist from './playlist.js';
import * as presets from './presets.js';
import * as apply from './apply.js';

const {
  syncControlsFromState,
} = apply;

const {
  initPresets,
} = presets;

const {
  loadServerTracks,
  loadTrack,
  play,
  reloadCurrentSource,
  renderPlaylist,
  setDemo,
  tracks,
} = playlist;

const {
  bindAudioEvents,
  bindControls,
  bindDragDrop,
  updateTransportUI,
} = ui;

const {
  $,
  MAXN,
  S,
  dom,
  toast,
} = core;
const {
  applyAnalyserSize,
  applyRateMode,
  currentAnalysers,
  desiredRate,
  resumeContext,
  signal,
} = audio;
const {
  layout,
  readTrace,
  rendererKind,
  resetWorkStats,
  scaleLabel,
  state,
  updatePerfBadge,
} = render;

/* ============================================================================
    Web Oscilloscope Music Player / Visualizer
    ---------------------------------------------------------------------------
    Renders a stereo signal as an X/Y beam path:  left channel -> X, right -> Y.

    DESIGN CONSTRAINTS (explicitly requested)
    ---------------------------------------------------------------------------
    1. NO RETRACE LINES (无回扫线)
       - A trace path is never `closePath()`d, so the beam never jumps from the
         end of a sweep back to its start.
       - Every frame starts a fresh sub-path with `moveTo()`; segments are never
         joined across analysis frames, so no wrap-around chord is ever drawn.
       - Optional VELOCITY BLANKING dims fast beam movements (brightness ∝ 1/v).
         Retrace/blanking sweeps in oscilloscope music are fast, so they fade to
         near-invisible exactly as they do on a real CRT — this is the principled
         way to kill retrace lines, not a post-process trick.

    2. NO GLOW (无辉光)
       - No `shadowBlur` / `shadowColor`, no bloom pass.
       - No `globalCompositeOperation = 'lighter'` (additive) accumulation.
       - No CSS blur/drop-shadow filter anywhere near the canvas.
       - Afterglow uses `destination-out` alpha decay: pixels only ever get
         *dimmer*, they never add brightness to their neighbours.
   ========================================================================== */



/* ------------------------------------------------------------ debug seam */

/* Read-only view of the engine, used by test/verify.js to assert that the
   analysis path really is running at the file's native rate (and therefore
   that no resampling is happening). Harmless in normal use. */
window.__scope = {
  get state() {
    // `renderer` says which trace path is live — 'webgl2' or the 'canvas2d'
    // fallback — because a test measuring brightness needs to know which model
    // produced it.
    return Object.assign(render.state(), audio.status(), { renderer: render.rendererKind() });
  },
  /* Frame-time tail as text: __scope.perf() or __scope.perf(60) for the last
     minute. Anything a profiler would be needed for is in here instead. */
  perf: (seconds) => render.perfLog(seconds),
  /* The trace layer as RGBA bytes, whichever renderer is running. */
  readTrace: (x, y, w, h) => render.readTrace(x, y, w, h),
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