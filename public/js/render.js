import * as core from './core.js';
import * as audio from './audio.js';
import * as glmod from './gl.js';
import * as perf from './perf.js';
import * as trace from './trace.js';

/* Geometry, the graticule, the beam, the two accumulation layers, the frame
   loop and the quality governor. Everything in here is about pixels: the
   samples arrive as arguments from audio.js, and the transport readout is a
   hook the UI installs, so this module depends on neither. */
const {
  $,
  BUCKETS,
  FORMATTERS,
  MAXN,
  S,
  TAU,
  clamp,
  dom,
  flags,
  toast,
  winSize,
} = core;

const bctx = dom.bg.getContext('2d');

/* Which renderer the trace canvas gets is decided ONCE, here: a canvas hands out
   one context kind for its whole life, so there is no switching later. `?renderer=`
   forces the choice (used by the tests to exercise both paths); the default asks
   for WebGL and falls back to Canvas-2D when it is unavailable. */
const WANT_GL = (() => {
  const q = new URLSearchParams(location.search).get('renderer');
  return q !== '2d';
})();
const GL = (() => {
  if (!WANT_GL) return null;
  /* Ask the machine, do not assume: a float render target that silently
     discards every draw is worse than no WebGL at all, because the canvas is
     then committed to a path that shows nothing. */
  if (!glmod.probeGL()) return null;
  return glmod.createGL(dom.trace);
})();
const tctx = GL ? null : dom.trace.getContext('2d');

/* --------------------------------------------------------------- geometry */

let W = 0, H = 0, DPR = 1;          // canvas size, in device pixels
let PLOT = 0, PLOT_X = 0, PLOT_Y = 0; // square plotting area (keeps circles round)

/* Adaptive resolution. Canvas cost scales with pixel count, so on a slow
   machine the cheapest big win is to render fewer pixels and let the browser
   upscale. autoScale drops (and recovers) in 1/8 steps based on measured
   render time; it never goes below 0.5. */
const SCALE_MIN = 0.5;
let autoScale = 1;
let workAvg = 0;            // ms spent inside the render section, smoothed
let workP50 = 0;            // median of the rolling window
let qualityCooldown = 0;
let workStatCountdown = 30;

function effectiveDpr() {
  const base = clamp(window.devicePixelRatio || 1, 1, 3);
  const mul = S.renderScale === 'auto' ? autoScale : Number(S.renderScale);
  return clamp(base * (Number.isFinite(mul) && mul > 0 ? mul : 1), 0.4, 3);
}

/** How far the open side panels reach into the stage, in CSS px. The canvas
    itself is never resized for a panel; only the PLOT gives up room, and only
    as much as it must. On a wide window the square plot has a margin wide
    enough to hide a whole panel, so nothing moves at all. */
function panelInset() {
  const stage = dom.stage.getBoundingClientRect();
  if (!stage.width) return 0;
  const mid = (stage.left + stage.right) / 2;
  let inset = 0;
  for (const el of [dom.panelList, dom.panelSettings]) {
    if (!el || !el.classList.contains('open')) continue;
    const r = el.getBoundingClientRect();
    // measure the intrusion from the edge the panel actually sits on
    const onRight = (r.left + r.right) / 2 > mid;
    inset = Math.max(inset, onRight ? stage.right - r.left : r.right - stage.left);
  }
  return Math.max(0, inset);
}

let lastInset = -1;

function layout() {
  const rect = dom.stage.getBoundingClientRect();
  const dpr = effectiveDpr();
  const w = Math.max(2, Math.round((rect.width || window.innerWidth) * dpr));
  const h = Math.max(2, Math.round((rect.height || window.innerHeight) * dpr));
  const inset = panelInset();
  if (w === W && h === H && dpr === DPR && inset === lastInset) return false;
  lastInset = inset;

  DPR = dpr; W = w; H = h;
  dom.bg.width = W; dom.bg.height = H;           // redrawn from scratch below
  if (GL) {
    dom.trace.width = W;
    dom.trace.height = H;
    GL.resize(W, H);              // scaled carry-over of the accumulated energy
  } else {
    resizeKeeping(dom.trace, tctx);
  }

  // Stay centred in the canvas and only shrink when a panel genuinely does
  // not fit in the margin beside the plot. Using max() rather than the sum
  // keeps it centred, so opening one panel never shoves the plot sideways.
  const margin = inset * dpr;
  PLOT = Math.max(64 * dpr, Math.min(H * 0.9, (W - 2 * margin) * 0.96));
  PLOT_X = (W - PLOT) / 2;
  PLOT_Y = (H - PLOT) / 2;

  trace.setTarget({ gl: GL, ctx: tctx, dpr: DPR, w: W, h: H, plot: PLOT, plotX: PLOT_X, plotY: PLOT_Y });
  drawBackground();
  perf.noteResize(W, H, DPR);
  return true;
}

/** Resize a canvas without throwing away what is already on it.
    Assigning canvas.width clears the bitmap, which would silently destroy the
    accumulated afterglow on every window resize or fullscreen
    toggle — and the whole point of those layers is that they persist. */
function resizeKeeping(canvas, ctx) {
  const ow = canvas.width, oh = canvas.height;
  if (!ow || !oh) { canvas.width = W; canvas.height = H; return; }
  const off = document.createElement('canvas');
  off.width = ow; off.height = oh;
  off.getContext('2d').drawImage(canvas, 0, 0);
  canvas.width = W; canvas.height = H;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(off, 0, 0, ow, oh, 0, 0, W, H);   // rescaled to the new size
}

/** Force a fresh layout after the resolution changed. */
function applyScale() {
  W = 0; H = 0;
  if (layout()) { flags.redraw = true; flags.settle = 100; }
  perf.noteEvent(`画质 ${Math.round(autoScale * 100)}%`);
  updatePerfBadge();
  const out = document.querySelector('[data-out="renderScale"]');
  if (out) {
    out.textContent = scaleLabel();
    out.title = `画布 ${W}×${H} 设备像素`;
  }
}

const scaleLabel = () => `${Math.round(effectiveDpr() * 100)}%`;

function updatePerfBadge() {
  const el = $('perfBadge');
  if (!el) return;
  const reduced = S.renderScale === 'auto' && autoScale < 1;
  el.textContent = `画质 ${Math.round(autoScale * 100)}%`;
  el.className = 'rate-badge perf-badge' + (reduced ? ' is-warn' : '');
  el.hidden = !reduced;
}

/** Shrink the render target when a frame costs too much, grow it back when
    there is headroom.

    Driven by the MEDIAN of a rolling window rather than a mean: a single
    slow frame (GC pause, another app on the machine, a compile in the
    background) should not trigger a resolution drop, and the median is what
    a mean cannot give us. */
function adaptQuality(workMs) {
  perf.recordWork(workMs);
  workAvg += (workMs - workAvg) * 0.08;

  if (qualityCooldown > 0) qualityCooldown--;
  if (--workStatCountdown > 0) return;
  workStatCountdown = 30;

  workP50 = perf.workTrimmed(0.5);
  updatePerfBadge();
  if (S.renderScale !== 'auto' || qualityCooldown > 0) return;

  if (workP50 > 10 && autoScale > SCALE_MIN) {
    autoScale = Math.max(SCALE_MIN, autoScale - 0.125);
    qualityCooldown = 120;
    applyScale();
  } else if (workP50 < 3.5 && autoScale < 1) {
    autoScale = Math.min(1, autoScale + 0.125);
    qualityCooldown = 120;
    applyScale();
  }
}

/* --------------------------------------------------- static background/grid */

function hexToRgb(hex) {
  let h = String(hex || '').trim().replace(/^#/, '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  if (h.length !== 6 || !Number.isFinite(n)) return { r: 120, g: 190, b: 175 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function drawBackground() {
  const g = bctx;
  // Graticule inherits the beam colour so it never clashes with it.
  const c = hexToRgb(S.color);
  const tint = (a) => `rgba(${c.r},${c.g},${c.b},${a})`;

  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, W, H);

  g.fillStyle = '#03060a';
  g.fillRect(0, 0, W, H);

  // Vignette: the edges are simply *darker* than the centre. Nothing here
  // adds light around the beam, so it cannot read as glow.
  const vg = g.createRadialGradient(W / 2, H / 2, PLOT * 0.15, W / 2, H / 2, Math.max(W, H) * 0.78);
  vg.addColorStop(0, 'rgba(13,24,28,0.92)');
  vg.addColorStop(0.55, 'rgba(6,11,15,0.92)');
  vg.addColorStop(1, 'rgba(0,0,0,1)');
  g.fillStyle = vg;
  g.fillRect(0, 0, W, H);

  if (!S.grid) return;

  const lw = Math.max(1, Math.round(DPR));
  const snap = (v) => (lw % 2 ? Math.round(v) + 0.5 : Math.round(v));
  const DIV = 10;
  const x0 = PLOT_X, y0 = PLOT_Y, s = PLOT;
  const x1 = x0 + s, y1 = y0 + s;

  g.lineWidth = lw;

  // fine graticule
  g.strokeStyle = tint(0.07);
  g.beginPath();
  for (let i = 1; i < DIV; i++) {
    const px = snap(x0 + (s * i) / DIV);
    const py = snap(y0 + (s * i) / DIV);
    g.moveTo(px, snap(y0)); g.lineTo(px, snap(y1));
    g.moveTo(snap(x0), py); g.lineTo(snap(x1), py);
  }
  g.stroke();

  // centre axes
  g.strokeStyle = tint(0.17);
  g.beginPath();
  g.moveTo(snap(x0 + s / 2), snap(y0)); g.lineTo(snap(x0 + s / 2), snap(y1));
  g.moveTo(snap(x0), snap(y0 + s / 2)); g.lineTo(snap(x1), snap(y0 + s / 2));
  g.stroke();

  // frame
  g.strokeStyle = tint(0.24);
  g.strokeRect(snap(x0), snap(y0), Math.round(s), Math.round(s));

  // edge ticks
  g.strokeStyle = tint(0.30);
  g.beginPath();
  const tick = 5 * DPR;
  const N = DIV * 5;
  for (let i = 1; i < N; i++) {
    const p = (s * i) / N;
    const len = i % 5 === 0 ? tick * 1.7 : tick;
    const px = snap(x0 + p), py = snap(y0 + p);
    g.moveTo(px, snap(y0)); g.lineTo(px, snap(y0 + len));
    g.moveTo(px, snap(y1)); g.lineTo(px, snap(y1 - len));
    g.moveTo(snap(x0), py); g.lineTo(snap(x0 + len), py);
    g.moveTo(snap(x1), py); g.lineTo(snap(x1 - len), py);
  }
  g.stroke();

  // axis captions
  g.fillStyle = tint(0.34);
  g.font = `${Math.round(9.5 * DPR)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  g.textBaseline = 'top';
  g.fillText('X ← L', snap(x0 + 8), snap(y0 + 6));
  g.textBaseline = 'bottom';
  g.fillText('Y ← R', snap(x0 + 8), snap(y1 - 6));
}

/* ------------------------------------------------------------- renderer */

let rafId = 0;
let haveSignal = false;   // has a live frame ever been captured?
let wasLive = false;

let uiTick = 0;
let lastFrame = 0;                 // ms, for the energy model's dt
/* The last captured window. It has to outlive the frame it was read in:
   when paused the analysers report silence and the loop deliberately
   keeps painting this instead of re-reading them. */
let frame = null;
/** The transport readout lives in ui.js. The loop must not import the UI, so
    the consumer registers itself here instead — one line, one direction. */
let tick = null;
function setTickHandler(fn) { tick = fn; }

function loop(ts) {
  rafId = requestAnimationFrame(loop);
  const now = typeof ts === 'number' ? ts : performance.now();
  perf.recordFrame(now);           // every tick counts, even the ones that paint nothing
  // The scrubber only needs ~10 Hz; writing three DOM properties every frame
  // was costing more than it looked.
  if (now - uiTick > 100) { uiTick = now; if (tick) tick(); }
  if (document.hidden) return;
  if (!W || !H) return;

  const live = audio.isLive();

  if (live) {
    wasLive = true;
    flags.settle = 0;
    if (!audio.readSignal()) return;
    frame = audio.signal();
    haveSignal = true;
  } else {
    // A paused <audio> element feeds the graph silence, so the analysers go
    // flat. Never re-read them here — keep painting the last captured window
    // instead, otherwise pausing (or nudging a slider while paused) would
    // blank the screen.
    if (wasLive) {
      wasLive = false;
      flags.settle = 100;                                   // just paused: let the afterglow settle
      if (S.residue <= 0) trace.requestWipe();    // wipe the floor before it freezes
    }
    if (flags.redraw) flags.settle = 100;                    // settings changed: re-settle
    if (!haveSignal || flags.settle <= 0) { flags.redraw = false; return; }
    flags.settle--;
  }
  flags.redraw = false;

  const workStart = performance.now();
  if (GL) {
    /* Real elapsed time, so a stalled tab decays by the clock rather than by a
       frame count — the whole point of a time constant. Clamped: after a long
       stall the phosphor is simply dark, not negative. */
    const now = performance.now();
    const dt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 1 / 60;
    lastFrame = now;
    const rgb = hexToRgb(S.color);
    GL.setColour(rgb.r / 255, rgb.g / 255, rgb.b / 255);
    GL.setExposure(trace.exposureFor(S.intensity));
    GL.setSigma(trace.sigmaFor(S.lineWidth));
    GL.setTau(trace.tauFor(S.persistence));
    GL.setHalo(trace.haloMix());
    GL.decay(dt);
  } else {
    // Afterglow is pure subtraction: destination-out only ever removes alpha,
    // so a bright pixel can never bleed light into its neighbours.
    trace.fadeLayer(tctx, trace.fadeStep());
  }

  try {
    trace.drawTrace(frame.L, frame.R, frame.capacity, winSize(), live);
    if (GL) {
      GL.present();
      if (GL.state.lost && !loop.lostWarned) {
        loop.lostWarned = true;      // a lost context is silent otherwise
        perf.noteEvent('WebGL 上下文丢失');
        toast('WebGL 上下文丢失，请刷新页面');
      }
    }
  } catch (err) {
    if (!loop.warned) { loop.warned = true; console.error('[scope] render error', err); }
  }
  if (tctx) tctx.globalAlpha = 1;
  perf.setContext(GL ? GL.state.segments : 0, S.halo > 0 ? 1 : 0);
  perf.setPeaks(trace.peaks().l, trace.peaks().r);
  adaptQuality(performance.now() - workStart);
}

/* ------------------------------------------------- what the rest of the app uses */

/** A track change, a preset or a reset: forget everything the previous picture
    taught the beam. `settle` asks the afterglow to rebuild from scratch. */

/** The quality governor restarts from scratch (used by "restore defaults"). */
function resetQuality() { autoScale = 1; workAvg = 0; qualityCooldown = 120; }

function resettle() { flags.settle = 100; flags.redraw = true; }

/** Background + beam, for the save-PNG button. The ghost layer is deliberately
    not composited: it is a screen artefact, not part of the picture. */
function composite() {
  if (!W || !H) return null;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  g.drawImage(dom.bg, 0, 0);
  g.drawImage(dom.trace, 0, 0);
  return c;
}

/** Read-only view of the renderer (the debug seam composes this with audio). */
function state() {
  return {
    rateMode: S.rateMode,
    windowSize: winSize(),
    renderScale: S.renderScale,
    effectiveDpr: effectiveDpr(),
    canvas: { w: W, h: H },
    plot: { x: PLOT_X, y: PLOT_Y, size: PLOT },
    workMs: workAvg,
    halo: S.halo,
    doseMax: trace.doseMax(),
    work: {
      trimmed: perf.workTrimmed(0.25),   // load-proof headline number
      trimmed50: perf.workTrimmed(0.5),
      min: perf.workStat(0),
      p50: perf.workStat(0.5),
      p95: perf.workStat(0.95),
      avg: workAvg,
      frames: perf.workFilledCount(),
    },
    autoScale,
  };
}

/** The trace layer as RGBA bytes, whichever renderer is running, so a test can
 *  read the picture without knowing or caring where it came from. */
function readTrace(x, y, w, h) {
  if (GL) return GL.readPixels(x, y, w, h);
  const d = tctx.getImageData(x, y, w, h);
  return new Uint8Array(d.data.buffer.slice(0));
}

const rendererKind = () => (GL ? 'webgl2' : 'canvas2d');

/** Kick off the frame loop (idempotent — the loop re-arms itself). */
function startLoop() { if (!rafId) rafId = requestAnimationFrame(loop); }

const {
  noteEvent,
  perfLog,
  recordWork,
  resetWorkStats,
  workSorted,
  workStat,
  workTrimmed,
} = perf;

const {
  drawTrace,
  exposureFor,
  fadeAlpha,
  fadeLayer,
  fadeStep,
  findTrigger,
  haloMix,
  paintInto,
  resetRefSpeed,
  resetTraceState,
  scrubAlpha,
  sigmaFor,
  tauFor,
} = trace;

export {
  adaptQuality,
  applyScale,
  composite,
  drawBackground,
  drawTrace,
  effectiveDpr,
  fadeAlpha,
  fadeLayer,
  fadeStep,
  findTrigger,
  hexToRgb,
  layout,
  loop,
  paintInto,
  panelInset,
  readTrace,
  noteEvent,
  perfLog,
  recordWork,
  rendererKind,
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
  updatePerfBadge,
  workSorted,
  workStat,
  workTrimmed,
};
