import * as core from './core.js';

/* The audio graph: one AudioContext whose sample rate is matched to the file,
   two analysers fed by a channel splitter, and the built-in demo oscillators.
   Nothing here knows about pixels, panels or presets. */
const {
  $,
  FORMATTERS,
  MAXN,
  S,
  clamp,
  dom,
  flags,
  toast,
  winSize,
} = core;

/* ----------------------------------------------------------- audio graph */

/*  Sample-rate policy
    ------------------
    A WebAudio graph runs at exactly one rate, and a MediaElementAudioSource
    resamples decoded media into it. A default AudioContext runs at the
    *device* rate (48 kHz on most machines), so a 192 kHz FLAC would be
    resampled down and everything above 24 kHz thrown away.

    Verified against an independent ffmpeg decode of the bundled FLAC: when
    the context rate equals the file's own rate, the analyser returns the
    file's samples BIT-FOR-BIT (residual exactly 0, max|diff| 0). So by
    default the context is built at the source's native rate and nothing is
    resampled on the visual path.

    (The OS still resamples the final output for your speakers. That is
    unavoidable — the device runs at 48 kHz — and it cannot affect what is
    drawn, because the analysers tap the graph, not the output.)
*/
const RATE_MIN = 8000;
const RATE_MAX = 384000;

let ac = null;
let engineWanted = 0;                       // rate requested; 0 = device default
let sourceRate = 0;                         // native rate of loaded media; 0 = unknown
let mediaSrc = null, splitter = null, zeroGain = null;
let anL = null, anR = null;                 // analysers fed by the <audio> element
let demoAnL = null, demoAnR = null;         // analysers fed by the built-in synth
let demo = null;                            // demo synth nodes
let demoBuilt = false;
let source = 'media';                       // 'media' | 'demo'
let useFloat = true;
let audioDead = false;                      // set once the graph can't be built

const bufL = new Float32Array(MAXN);
const bufR = new Float32Array(MAXN);
const byteL = new Uint8Array(MAXN);
const byteR = new Uint8Array(MAXN);

/* The analyser buffer is sized to the visible window, not always 32768.
   Copying 32768 samples x 2 channels 60 times a second is pure waste when
   only 4096 are ever drawn — and it is 4x (or 32x) more memory traffic. */
let analyserSize = 0;
let viewL = bufL;
let viewR = bufR;
let viewBL = byteL;
let viewBR = byteR;

const pow2ceil = (v) => {
  let p = 1024;
  while (p < v && p < MAXN) p <<= 1;
  return clamp(p, 1024, MAXN);
};

/** fftSize = 2x the window: enough for the window plus trigger search room. */
function applyAnalyserSize() {
  const want = pow2ceil(winSize() * 2);
  if (want === analyserSize) return;
  analyserSize = want;
  viewL = bufL.subarray(0, want);
  viewR = bufR.subarray(0, want);
  viewBL = byteL.subarray(0, want);
  viewBR = byteR.subarray(0, want);
  for (const a of [anL, anR, demoAnL, demoAnR]) {
    if (a && a.fftSize !== want) a.fftSize = want;
  }
}

function clampRate(r) {
  return Number.isFinite(r) && r >= RATE_MIN && r <= RATE_MAX ? Math.round(r) : 0;
}

const rateText = (r) => `${r % 1000 === 0 ? r / 1000 : (r / 1000).toFixed(1)} kHz`;

/** Which context rate the current settings + source call for (0 = device). */
function desiredRate() {
  if (S.rateMode === 'device') return 0;
  if (S.rateMode === 'auto') return sourceRate ? clampRate(sourceRate) : 0;
  return clampRate(Number(S.rateMode));
}

function makeAnalyser() {
  const a = ac.createAnalyser();
  a.fftSize = analyserSize || MAXN;
  a.smoothingTimeConstant = 0;   // time-domain data is unaffected, but be explicit
  return a;
}

function teardownEngine() {
  try { if (demo) { demo.ox.stop(); demo.oy.stop(); } } catch (e) { /* ignore */ }
  demo = null; demoBuilt = false; demoAnL = demoAnR = null;
  try { if (mediaSrc) mediaSrc.disconnect(); } catch (e) { /* ignore */ }
  try { if (zeroGain) zeroGain.disconnect(); } catch (e) { /* ignore */ }
  try { if (ac) ac.close(); } catch (e) { /* ignore */ }
  ac = null; mediaSrc = splitter = zeroGain = anL = anR = null;
  engineWanted = 0;
}

/** Build a fresh context at `want` Hz (0 = device default).
    createMediaElementSource may only ever be called once per element, so the
    <audio> element has to be replaced together with the context. */
let elementHook = null;
function setElementHook(fn) { elementHook = fn; }

let reloader = null;
/** Called after the graph is rebuilt: put the current source back. */
function setSourceReloader(fn) { reloader = fn; }

function buildEngine(want) {
  if (audioDead) return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) { audioDead = true; toast('此浏览器不支持 Web Audio API'); return null; }

  const prev = dom.audio;
  const el = document.createElement('audio');
  el.id = 'audio';
  el.preload = 'metadata';
  el.volume = prev ? prev.volume : Number(dom.volume.value);
  el.preservesPitch = true;
  el.playbackRate = Number(dom.rate.value) || 1;

  teardownEngine();

  if (prev && prev.parentNode) prev.replaceWith(el);
  else document.body.appendChild(el);
  dom.audio = el;
  // The element is swapped, so anything that had listeners on the old one
  // must rebind. Who that is, is not audio's business.
  if (elementHook) elementHook(el);

  let ctx;
  let actual = want;
  try {
    ctx = want ? new AC({ sampleRate: want }) : new AC();
  } catch (err) {
    // rate rejected by this browser/platform — fall back to the device rate
    actual = 0;
    try {
      ctx = new AC();
    } catch (err2) {
      audioDead = true;
      toast('音频初始化失败：' + err2.message);
      return null;
    }
  }

  ac = ctx;
  engineWanted = actual;
  useFloat = typeof AnalyserNode.prototype.getFloatTimeDomainData === 'function';

  mediaSrc = ac.createMediaElementSource(el);
  splitter = ac.createChannelSplitter(2);
  anL = makeAnalyser();
  anR = makeAnalyser();

  mediaSrc.connect(splitter);
  splitter.connect(anL, 0);
  splitter.connect(anR, 1);
  mediaSrc.connect(ac.destination);

  // Analysers with no downstream connection can be starved of processing in
  // some engines. A zero-gain path to the destination keeps them pulled
  // without adding any audible (or visible) signal.
  zeroGain = ac.createGain();
  zeroGain.gain.value = 0;
  anL.connect(zeroGain);
  anR.connect(zeroGain);
  zeroGain.connect(ac.destination);

  updateRateBadge();
  flags.redraw = true;
  return ac;
}

function ensureGraph() {
  if (ac) return ac;
  if (audioDead) return null;
  return buildEngine(desiredRate());
}

function resumeContext() {
  const ctx = ensureGraph();
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/** A brand new source is about to be loaded, so there is nothing to preserve. */
function ensureEngineRate() {
  if (audioDead) return;
  const want = desiredRate();
  if (!ac || want !== engineWanted) buildEngine(want);
  updateRateBadge();
}

/** The rate *setting* changed — keep the position and play state. */
function applyRateMode() {
  if (audioDead) return;
  const want = desiredRate();
  if (ac && want === engineWanted) { updateRateBadge(); return; }

  /* The engine is being torn down and rebuilt, so whatever was loaded has to
     be put back. WHAT that is belongs to the playlist, not here: the owner
     installs reloader(), and this function just hands it the facts. */
  const time = ac ? (dom.audio.currentTime || 0) : 0;
  const playing = ac ? (!dom.audio.paused && !dom.audio.ended) : false;
  const wasDemo = source === 'demo';

  buildEngine(want);
  if (reloader) reloader({ wasDemo, time, playing });
  updateRateBadge();
  flags.redraw = true;
}

/** Small always-visible readout: is the engine native to this file? */
function updateRateBadge() {
  const el = $('rateBadge');
  if (!el) return;
  const eng = ac ? ac.sampleRate : 0;

  // the window readout is a sample count; its duration depends on the rate
  const out = document.querySelector('[data-out="windowIdx"]');
  if (out) {
    out.textContent = FORMATTERS.windowIdx();
    out.title = `${((winSize() / (eng || 48000)) * 1000).toFixed(1)} ms`;
  }

  if (!eng) { el.textContent = '—'; el.className = 'rate-badge'; el.title = ''; return; }
  if (!sourceRate) {
    el.textContent = `${rateText(eng)} 引擎`;
    el.className = 'rate-badge';
    el.title = '当前音频引擎采样率（未载入音频，无从判断是否重采样）';
    return;
  }
  const native = eng === sourceRate;
  el.textContent = native
    ? `${rateText(eng)} 原生`
    : `${rateText(eng)} ← ${rateText(sourceRate)} 重采样`;
  el.className = 'rate-badge ' + (native ? 'is-native' : 'is-resampled');
  el.title = native
    ? `引擎与音频文件同为 ${sourceRate} Hz：分析器读到的是文件原始采样点，没有重采样`
    : `音频文件是 ${sourceRate} Hz，被重采样到 ${eng} Hz`;
}

function currentAnalysers() {
  if (source === 'demo') return demoAnL && demoAnR ? [demoAnL, demoAnR] : null;
  return anL && anR ? [anL, anR] : null;
}

/* ------------------------------------------------------- built-in demo sig */

/* Two oscillators at a 3:2 ratio drive a clean Lissajous figure. Handy for
   checking the renderer (and for tuning gain / persistence) with no file. */
function buildDemo() {
  if (demoBuilt || !ac) return;
  const merger = ac.createChannelMerger(2);
  const gx = ac.createGain(); gx.gain.value = 0.85;
  const gy = ac.createGain(); gy.gain.value = 0.85;
  const ox = ac.createOscillator(); ox.type = 'sine'; ox.frequency.value = 45; // X
  const oy = ac.createOscillator(); oy.type = 'sine'; oy.frequency.value = 30; // Y
  const dsp = ac.createChannelSplitter(2);

  ox.connect(gx); gx.connect(merger, 0, 0);
  oy.connect(gy); gy.connect(merger, 0, 1);
  merger.connect(dsp);
  demoAnL = makeAnalyser();
  demoAnR = makeAnalyser();
  dsp.connect(demoAnL, 0);
  dsp.connect(demoAnR, 1);
  demoAnL.connect(zeroGain);
  demoAnR.connect(zeroGain);

  ox.start(); oy.start();   // silent: everything reaches the output through zeroGain
  demo = { merger, dsp, gx, gy, ox, oy };
  demoBuilt = true;
}

/** Switch the analysis source to/from the built-in demo. The GRAPH is all
    this owns: titles, the button state, the preset memory and the render state
    belong to whoever asked (playlist.js). That is what keeps audio.js free of
    any dependency on the UI or the renderer. */
function setDemoSource(on) {
  const ctx = resumeContext();
  if (!ctx) return false;
  buildDemo();
  if (on) {
    try { demo.merger.connect(demo.dsp); } catch (e) { /* already connected */ }
    source = 'demo';
  } else {
    try { demo.merger.disconnect(); } catch (e) { /* not connected */ }
    source = 'media';
  }
  return true;
}



function readSignal() {
  const a = currentAnalysers();
  if (!a) return false;
  if (useFloat) {
    // Read only analyserSize samples, not the whole 32768-sample buffer.
    a[0].getFloatTimeDomainData(viewL);
    a[1].getFloatTimeDomainData(viewR);
  } else {
    a[0].getByteTimeDomainData(viewBL);
    a[1].getByteTimeDomainData(viewBR);
    for (let i = 0; i < analyserSize; i++) {
      bufL[i] = (byteL[i] - 128) / 128;
      bufR[i] = (byteR[i] - 128) / 128;
    }
  }
  return true;
}


function isLive() {
  if (!currentAnalysers()) return false;
  if (source === 'demo') return !!ac && ac.state === 'running';
  return !dom.audio.paused && !dom.audio.ended && !dom.audio.seeking;
}

/* ------------------------------------------------------ what the rest needs */

/** The demo is a pseudo-track; callers ask instead of peeking at the flag. */
const isDemo = () => source === 'demo';

/** loadTrack knows the file's native rate before the engine does. */
function setSourceRate(rate) { sourceRate = rate || 0; }

/** Buffers WITHOUT re-reading the analysers. A paused <audio> element reports
    silence, so the renderer keeps painting the last captured window instead. */
const signal = () => ({ L: bufL, R: bufR, capacity: analyserSize, float: useFloat });

/** Everything the debug seam and the rate badge need to know. */
const status = () => ({
  engineRate: ac ? ac.sampleRate : 0,
  contextState: ac ? ac.state : 'none',
  clockMs: ac ? ac.currentTime * 1000 : 0,   // advances only while the graph runs
  sourceRate,
  analyserSize,
  source,
  wanted: engineWanted,
  dead: audioDead,
});

export {
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
  setSourceRate,
  signal,
  status,
  setElementHook,
  setSourceReloader,
  teardownEngine,
  updateRateBadge,
};
