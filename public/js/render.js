import * as core from './core.js';
import * as audio from './audio.js';
import * as glmod from './gl.js';

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

/* Rolling window of per-frame render times.

    performance.now() is quantised to 100 us in Chrome, which is coarser than
    the differences worth measuring, so no single sample is useful. Two
    properties make the window work anyway:
      - averaging many quantised samples recovers sub-quantum resolution;
      - background load (another app, a compile) can only ever ADD slow
        frames, so it shows up purely as a right tail.
    So `trimmed()` — the mean of the fastest quarter — is both sub-quantum
    accurate and insensitive to whatever else the machine is doing.

    Keep the window SHORT (~2 s): a long one both slows the quality
    adaptation down and, when a measurement starts, is still full of stale
    frames from before the change. */
const WORK_RING = new Float32Array(120);
const WORK_SORT = new Float32Array(120);
let workPos = 0;
let workFilled = 0;

function recordWork(ms) {
  WORK_RING[workPos] = ms;
  workPos = (workPos + 1) % WORK_RING.length;
  if (workFilled < WORK_RING.length) workFilled++;
}

function resetWorkStats() {
  workPos = 0;
  workFilled = 0;
  workAvg = 0;
  workP50 = 0;
}

function workSorted() {
  WORK_SORT.set(WORK_RING.subarray(0, workFilled));
  const a = WORK_SORT.subarray(0, workFilled);
  a.sort();
  return a;
}

function workStat(p) {
  if (!workFilled) return 0;
  const a = workSorted();
  return a[Math.min(workFilled - 1, Math.floor(p * (workFilled - 1)))];
}

/** Mean of the fastest `q` fraction — the load-proof cost estimate. */
function workTrimmed(q) {
  if (!workFilled) return 0;
  const a = workSorted();
  const n = Math.max(1, Math.floor(workFilled * q));
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i];
  return s / n;
}

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

  drawBackground();
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
  recordWork(workMs);
  workAvg += (workMs - workAvg) * 0.08;

  if (qualityCooldown > 0) qualityCooldown--;
  if (--workStatCountdown > 0) return;
  workStatCountdown = 30;

  workP50 = workTrimmed(0.5);
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

const PX = new Float32Array(MAXN);
const PY = new Float32Array(MAXN);
const SEGR = new Float32Array(MAXN);   // raw per-sample step, in pixels
/* Segment indices grouped by brightness bucket. Building these in the same
   pass that maps samples to pixels means the whole trace is produced with
   ONE pass over the samples plus one canvas op per drawn segment, instead of
   one full scan per brightness level. */
const BUCKET_IDX = new Int32Array(BUCKETS * MAXN);
const BUCKET_N = new Int32Array(BUCKETS);

let rafId = 0;
let haveSignal = false;   // has a live frame ever been captured?
let wasLive = false;
let refSpeed = 0;        // smoothed mean beam speed, the 1/v blanking reference
let agGain = 1;          // auto-gain (applied to BOTH axes to keep the figure's shape)
let monoCounter = 0;
let monoLike = false;
let lastPeakL = 0;       // previous frame's peaks — auto-gain is smoothed anyway
let lastPeakR = 0;
let lastDoseMax = 1;     // largest 1/v dose of the last frame (1 = the mean beam speed)

/* ---- energy-model parameters (WebGL path) ------------------------------
   The Canvas path fades with a per-frame alpha a(p); the energy path decays with
   a time constant. τ = -dt/ln(1-a) is the time constant that decays at the same
   rate, so the 余辉 slider keeps its meaning across both renderers instead of
   needing a second set of numbers. */
function tauFor(p) {
  const a = Math.pow(1 - clamp(p / 100, 0, 1), 2) * 0.97 + 0.03;
  if (a >= 1) return 0;                       // 0 % = no accumulation at all
  return Math.min(2, -1 / 60 / Math.log(1 - a));
}

/** Beam spot sigma in device pixels. The Canvas path strokes a line of width
 *  lineWidth; a Gaussian of sigma = w/2 has the same apparent thickness. */
function sigmaFor(lw) { return Math.max(0.5, lw * DPR * 0.5); }

/* ---- the halo: halation, the cloud the emitted light makes ----------------
   Applied to the tone-mapped frame, not to the energy, because the scatter
   happens to light the phosphor has ALREADY emitted: its input is bounded and
   its output can never exceed this amplitude. Two earlier attempts got this
   wrong in instructive ways.

   Doing it in the energy buffer made the halo a wider beam spot. Wrong on the
   physics (the spot is set by the beam current, not by the writing speed) and
   wrong on the screen: a dwell deposits thousands of times what saturates the
   tone map, so the halo term saturated out to its own cutoff and the "glow"
   ended in a cliff — a flat disc with a hard edge.

   Making sigma vary per segment also beaded the trace like a string of dots,
   because adjacent samples have different doses and therefore different widths.
   The round flare at a stroke end in the reference photos is not a wider spot at
   all: it is the cloud around a bright point.

   The slider runs the amplitude all the way to 0.9 because the two reference
   cases are far apart: around a dense figure the wide taps already average 20-40
   % of full brightness and the cloud is obvious, while around a single thin
   stroke the same taps average a few percent and no amplitude short of this makes
   it read at all. 光晕 is the knob for which of those you are looking at. */
const HALO_CLOUD = 0.9;
function haloMix() {
  if (!S.halo) return 0;
  // Curved, because the cloud is a convolution of what is already on screen: on
  // a dense figure it is obvious by 40 % and by 100 % it has washed the trace
  // out. h^1.5 keeps the whole slider usable instead of saturating halfway.
  return HALO_CLOUD * Math.pow(clamp(S.halo / 100, 0, 1), 1.5);
}

/** Energy deposited per unit of 1/v, per frame. The constant is measured, not
 *  chosen: sweeping it on the busiest passage of a line-type track and counting
 *  how much ink the tone map blows out gives 0.05→0 %, 0.13→0.06 %, 0.17→0.9 %,
 *  0.25→3.6 %. 0.9 % at the default intensity is the same operating point the
 *  8-bit path was calibrated to (0.66 % there), so the two renderers agree about
 *  what "not blown out" means. */
function exposureFor(intensity) { return intensity * 0.19; }

function fadeAlpha() {
  // 0 %  -> 1.0  (full clear every frame, zero afterglow)
  // 100% -> 0.03 (long phosphor-like tail)
  const p = clamp(S.persistence / 100, 0, 1);
  return Math.pow(1 - p, 2) * 0.97 + 0.03;
}

/** Erase a layer by `alpha` — pure subtraction, never addition. */
function fadeLayer(ctx, alpha) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = `rgba(0,0,0,${alpha})`;
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'source-over';
}

/* ---- the 8-bit quantisation floor (the "residue" slider) --------------
   destination-out multiplies alpha: n <- n*(1-a). With round-to-nearest
   8-bit storage, every n <= 1/(2a) is a FIXED POINT and never decays. So a
   slow fade (high 余辉) does not leave a longer ghost, it leaves a BRIGHTER
   one — at 100% the floor is alpha ~15, clearly visible, and the whole region
   the beam has ever swept keeps it forever.

   A periodic strong scrub is the only way out: a step of 1.0 clears the floor
   completely, and anything weaker leaves a predictable amount of it behind.
   Hence one slider, expressed as the residue you are willing to keep.
*/
/* The ten alpha rungs are the 8-bit path's whole brightness range, and they have
   to cover the same 1/v ratio the energy path does. Mapping the dose straight
   onto them puts an ordinary segment on rung 5 of 9 at alpha 0.5·base instead of
   the 0.44·base this path was calibrated at, and its afterglow accumulates, so
   the picture drifts brighter. Scaling the rungs by this keeps the operating
   point and spends the extra headroom on the slow strokes — which is where the
   dashes are. */
const BUCKET_ALPHA = 0.8;
const SCRUB_EVERY = 180;   // frames (~3 s, longer than any visible trail)
let scrubTick = 0;

function scrubAlpha() {
  const r = clamp(S.residue / 100, 0, 1);
  if (r <= 0) return 1;                     // off -> wipe the floor completely
  return Math.min(1, 3.125 / (r * 100));    // leaves a floor of roughly 16*r
}

/** Rising zero-crossing on X, used to phase-lock periodic figures. */
function findTrigger(buf, maxStart, n) {
  const limit = Math.min(maxStart, n);
  let armed = false;
  let best = -1;
  for (let i = 1; i < limit; i++) {
    const v = buf[i];
    if (v < -0.03) { armed = true; continue; }
    if (armed && v >= 0) { best = i; break; }
  }
  return best < 0 ? 0 : best;
}

function drawTrace(L, R, capacity, n, live) {
  const m = n - 1;
  const maxStart = Math.max(0, capacity - n);

  let start = 0;
  if (S.trigger && maxStart > 0) start = findTrigger(L, maxStart, n);

  /* ---- auto-gain from the previous frame's peaks (one frame of lag on a
     value that is exponentially smoothed anyway) ------------------------ */
  if (S.autoGain) {
    const pk = Math.max(lastPeakL, monoLike ? lastPeakL : lastPeakR, 1e-4);
    const target = clamp(0.9 / pk, 0.35, 12);
    const k = target < agGain ? 0.10 : 0.012;   // quick attack, slow release
    agGain += (target - agGain) * k;
  } else if (agGain !== 1) {
    agGain += (1 - agGain) * 0.12;
    if (Math.abs(agGain - 1) < 1e-3) agGain = 1;
  }

  const scale = PLOT * 0.5;
  const ox = PLOT_X + PLOT * 0.5 + S.offX * scale;
  const oy = PLOT_Y + PLOT * 0.5 - S.offY * scale;
  /* Which way each axis points is a property of the MATERIAL, not a mistake to
     be corrected silently: X = left channel and Y = right with positive up is the
     scope convention, and a track made for the opposite polarity (or a reference
     video whose Y input was inverted) will look mirrored without these. */
  const kx = scale * S.gainX * agGain * (S.invertX ? -1 : 1);
  const ky = scale * S.gainY * agGain * (S.invertY ? -1 : 1);

  const blanking = S.blanking;
  const ref = Math.max(refSpeed > 0 ? refSpeed : PLOT * 0.01, PLOT * 0.0004);
  /* ONLY a numerical floor: it keeps ref/s finite when a segment does not move
     at all. It is deliberately tiny — anything comparable to the mean beam step
     would compress the 1/v law (see the dose below). */
  const eps = PLOT * 0.00002;
  const blankAt = S.blankRatio * ref;   // explicit drop threshold, no hidden clamp
  const topBucket = BUCKETS - 1;
  /* ---- pass 1: map to pixels, track peaks, measure the step lengths --- */
  let peakL = 0, peakR = 0, total = 0;
  let prevX = 0, prevY = 0;
  let segN = 0;                       // instances handed to the energy renderer
  let doseMax = 1;                    // largest dose this frame (for tests)
  if (blanking) BUCKET_N.fill(0);

  for (let i = 0; i < n; i++) {
    let l = L[start + i];
    const al = l < 0 ? -l : l;
    if (al > peakL) peakL = al;
    let r = monoLike ? l : R[start + i];
    const ar = r < 0 ? -r : r;
    if (ar > peakR) peakR = ar;
    if (l > 16) l = 16; else if (l < -16) l = -16;
    if (r > 16) r = 16; else if (r < -16) r = -16;

    const x = ox + l * kx;
    const y = oy - r * ky;
    PX[i] = x;
    PY[i] = y;

    if (i > 0) {
      const dx = x - prevX, dy = y - prevY;
      const s = Math.sqrt(dx * dx + dy * dy);
      SEGR[i] = s;
      total += s;
    }
    prevX = x;
    prevY = y;
  }

  /* ---- pass 2: deposit, with the dose smoothed along the path ---------
     Brightness is 1/speed, and on a REAL tube that is a property of a stroke:
     the beam lingers along a slow one and races through a fast one. Sample by
     sample, though, the step jitters (the trace of an audio signal is not a
     smooth curve at 44 kHz), so a raw 1/step flickers at the sample pitch and
     the trace comes out BEADED — a string of little dots, which is exactly what
     it looked like. A phosphor does not see individual samples either: the spot
     is a few pixels wide, so what it integrates is the average speed over its
     own width. That is the ±3 sample box below, and it is why the dashes are
     stroke-length rather than dot-length. */
  for (let i = 1; i < n; i++) {
    const s = SEGR[i];
    {
      const j0 = i > 3 ? i - 3 : 1, j1 = i + 3 < n ? i + 3 : n - 1;
      let sum = 0;
      for (let j = j0; j <= j1; j++) sum += SEGR[j];
      const sSmooth = sum / (j1 - j0 + 1);
      const x = PX[i];
      const y = PY[i];
      const prevX = PX[i - 1];
      const prevY = PY[i - 1];
      // Retrace blanking is an explicit comparison against the running mean
      // speed, NOT a side effect of the bucket index. Making it explicit is
      // what lets the threshold be a number you can state, test, and set:
      // a segment is dropped when it is more than blankRatio times faster
      // than the typical beam speed. It uses the RAW step: a retrace is a
      // retrace, and averaging would smear it back in.
      if (!blanking || s <= blankAt) {
        /* Brightness ∝ 1/speed, and on a real tube that ratio is what makes a
           trace DASHED: a stroke the beam lingers on blazes while the fast
           sweep between strokes falls below the phosphor's visible threshold.
           So the denominator carries only a numerical floor (2e-5 of the plot
           ≈ 0.01 px), not a display floor — a floor near the mean step would
           flatten the whole law into a 2x range and the picture would read as a
           uniformly bright web whose contrast comes from self-overlap instead. */
        const dose = ref / (sSmooth + eps);     // 1/v, in units of the mean step
        if (dose > doseMax) doseMax = dose;
        if (GL) {
          /* Energy model: the same 1/v law, but it ADDS — no ladder to quantise
             into and no ceiling, because the tone map saturates instead. The cap
             only stops a stationary beam from overflowing a half float; 64 is
             already far past full brightness. */
          if (segN < GL.maxSegments) {
            const o = segN * 5;
            GL.segData[o] = prevX;
            GL.segData[o + 1] = prevY;
            GL.segData[o + 2] = x;
            GL.segData[o + 3] = y;
            GL.segData[o + 4] = Math.min(dose, 64);
            segN++;
          }
        } else if (blanking) {
          /* The 8-bit path has ten rungs and no accumulation buffer, so it maps
             the same dose through a saturating curve (the tone map's, cheaply):
             a linear ramp would pin every ordinary segment to the top rung and
             lose the dashes. */
          let b = Math.ceil(topBucket * (1 - 1 / (1 + dose)));
          if (b > topBucket) b = topBucket;
          else if (b < 1) b = 1;
          BUCKET_IDX[b * MAXN + BUCKET_N[b]++] = i - 1;
        }
      }
    }
  }

  if (blanking) {
    const mean = total / m;
    if (!(refSpeed > 0)) refSpeed = mean;
    refSpeed += (mean - refSpeed) * 0.06;
  }

  /* ---- mono fallback: a single-channel file leaves Y flat ------------ */
  if (peakR < 1e-4 && peakL > 1e-3) monoCounter++;
  else monoCounter = 0;
  if (monoCounter > 40) monoLike = true;
  else if (monoCounter === 0 && monoLike && peakR > 1e-3) monoLike = false;
  lastPeakL = peakL;
  lastPeakR = peakR;

  /* ---- paint ---------------------------------------------------------- */
  if (GL) {
    if (S.beamDot && segN < GL.maxSegments) {
      // A zero-length segment with a lot of energy IS a stationary beam: the
      // spot profile makes the dot, and the cloud makes it a flare.
      const o = segN * 5;
      GL.segData[o] = PX[n - 1];
      GL.segData[o + 1] = PY[n - 1];
      GL.segData[o + 2] = PX[n - 1] + 0.01;
      GL.segData[o + 3] = PY[n - 1] + 0.01;
      GL.segData[o + 4] = 4;
      segN++;
    }
    GL.deposit(segN);
  } else {
    paintInto(tctx, n, S.intensity);
  }
  lastDoseMax = doseMax;


  if (S.beamDot && tctx) {
    const lw = S.lineWidth * DPR;
    tctx.fillStyle = S.color;
    tctx.beginPath();
    tctx.arc(PX[n - 1], PY[n - 1], Math.max(1.5 * DPR, lw * 1.4), 0, TAU);
    tctx.fill();
  }
}

/** Stroke the already-computed beam path into `ctx` with `base` as the peak
    alpha. This is the only accumulation layer left. */
function paintInto(ctx, n, base) {
  ctx.lineWidth = S.lineWidth * DPR;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = S.color;

  if (!S.blanking) {
    // Plain beam path: one continuous polyline, never closed.
    ctx.globalAlpha = clamp(base, 0, 1);
    ctx.beginPath();
    ctx.moveTo(PX[0], PY[0]);
    for (let i = 1; i < n; i++) ctx.lineTo(PX[i], PY[i]);
    ctx.stroke();
    ctx.globalAlpha = 1;
    return;
  }

  // Only the surviving segments reach here: anything faster than
  // blankRatio × the mean beam speed was already dropped in the pass above.
  // Those are retrace / blanking strokes — on a CRT the beam is racing, so
  // they carry almost no charge per unit length, and under afterglow even a
  // very dim one would still accumulate frame after frame into a visible
  // chord. Dropping them outright is what removes retrace lines for good,
  // rather than merely fading them. What is left is dimmed ∝ 1/speed.
  for (let b = 1; b < BUCKETS; b++) {
    const cnt = BUCKET_N[b];
    if (!cnt) continue;
    const base0 = b * MAXN;
    ctx.globalAlpha = clamp(base * BUCKET_ALPHA * (b / (BUCKETS - 1)), 0, 1);
    ctx.beginPath();
    let prev = -2;
    for (let k = 0; k < cnt; k++) {
      const si = BUCKET_IDX[base0 + k];
      if (si !== prev + 1) ctx.moveTo(PX[si], PY[si]);   // contiguous runs skip the moveTo
      ctx.lineTo(PX[si + 1], PY[si + 1]);
      prev = si;
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}


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
      if (S.residue <= 0) scrubTick = SCRUB_EVERY;    // and wipe the floor before it freezes
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
    GL.setExposure(exposureFor(S.intensity));
    GL.setSigma(sigmaFor(S.lineWidth));
    GL.setTau(tauFor(S.persistence));
    GL.setHalo(haloMix());
    GL.decay(dt);
  } else {
    // Afterglow is pure subtraction: destination-out only ever removes alpha,
    // so a bright pixel can never bleed light into its neighbours.
    if (++scrubTick >= SCRUB_EVERY) {
      scrubTick = 0;
      fadeLayer(tctx, scrubAlpha());
    } else {
      fadeLayer(tctx, fadeAlpha());
    }
  }

  try {
    drawTrace(frame.L, frame.R, frame.capacity, winSize(), live);
    if (GL) {
      GL.present();
      if (GL.state.lost && !loop.lostWarned) {
        loop.lostWarned = true;      // a lost context is silent otherwise
        toast('WebGL 上下文丢失，请刷新页面');
      }
    }
  } catch (err) {
    if (!loop.warned) { loop.warned = true; console.error('[scope] render error', err); }
  }
  if (tctx) tctx.globalAlpha = 1;
  adaptQuality(performance.now() - workStart);
}

/* ------------------------------------------------- what the rest of the app uses */

/** A track change, a preset or a reset: forget everything the previous picture
    taught the beam. `settle` asks the afterglow to rebuild from scratch. */
function resetTraceState({ settle = false } = {}) {
  refSpeed = 0;
  agGain = 1;
  scrubTick = 0;
  monoCounter = 0;
  monoLike = false;
  lastPeakL = 0;
  lastPeakR = 0;
  flags.redraw = true;
  if (settle) flags.settle = 100;
}

/** The reference speed is stale whenever the window or the trigger moves. */
function resetRefSpeed() { refSpeed = 0; flags.redraw = true; }

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
    doseMax: lastDoseMax,
    work: {
      trimmed: workTrimmed(0.25),   // load-proof headline number
      trimmed50: workTrimmed(0.5),
      min: workStat(0),
      p50: workStat(0.5),
      p95: workStat(0.95),
      avg: workAvg,
      frames: workFilled,
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

export {
  adaptQuality,
  applyScale,
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
  readTrace,
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
