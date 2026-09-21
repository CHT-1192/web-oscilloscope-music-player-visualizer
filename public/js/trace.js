/* ============================================================================
 *  trace.js — the beam: samples to pixels, and pixels to light
 *
 *  This is the only module that knows the shape of a trace: one pass maps the
 *  two channels to device pixels while measuring the per-sample step, a second
 *  deposits the (dose-smoothed) 1/v energy — additively into the float buffer on
 *  the WebGL path, into a ten-rung alpha ladder on the 8-bit one.
 *
 *  The geometry (plot rectangle, DPR) and the renderer handle are installed by
 *  render.js with setTarget(), so this module never reaches back into it.
 * ========================================================================== */

import * as core from './core.js';

const {
  BUCKETS,
  MAXN,
  S,
  TAU,
  clamp,
  flags,
} = core;

/** Installed by render.js after layout(). */
const T = { gl: null, ctx: null, dpr: 1, w: 0, h: 0, plot: 0, plotX: 0, plotY: 0 };
function setTarget(t) {
  T.gl = t.gl; T.ctx = t.ctx; T.dpr = t.dpr; T.w = t.w; T.h = t.h;
  T.plot = t.plot; T.plotX = t.plotX; T.plotY = t.plotY;
}

const PX = new Float32Array(MAXN);
const PY = new Float32Array(MAXN);
const SEGR = new Float32Array(MAXN);   // raw per-sample step, in pixels
/* Segment indices grouped by brightness bucket. Building these in the same
   pass that maps samples to pixels means the whole trace is produced with
   ONE pass over the samples plus one canvas op per drawn segment, instead of
   one full scan per brightness level. */
const BUCKET_IDX = new Int32Array(BUCKETS * MAXN);
const BUCKET_N = new Int32Array(BUCKETS);

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
function sigmaFor(lw) { return Math.max(0.5, lw * T.dpr * 0.5); }

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
  ctx.fillRect(0, 0, T.w, T.h);
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

/** The 8-bit path's erase step, once per frame. Every SCRUB_EVERY frames it
    wipes the quantisation floor instead of fading — see scrubAlpha. A pause asks
    for that wipe immediately so the frozen picture does not keep it forever. */
function fadeStep() {
  if (++scrubTick >= SCRUB_EVERY) { scrubTick = 0; return scrubAlpha(); }
  return fadeAlpha();
}
/** Ask the NEXT fade to be the full wipe instead. Separate from fadeStep()
    because the caller must use the alpha it gets back — an earlier version
    asked for the wipe and discarded it, and the floor never went away. */
function requestWipe() { scrubTick = SCRUB_EVERY; }

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

  const scale = T.plot * 0.5;
  const ox = T.plotX + T.plot * 0.5 + S.offX * scale;
  const oy = T.plotY + T.plot * 0.5 - S.offY * scale;
  /* Which way each axis points is a property of the MATERIAL, not a mistake to
     be corrected silently: X = left channel and Y = right with positive up is the
     scope convention, and a track made for the opposite polarity (or a reference
     video whose Y input was inverted) will look mirrored without these. */
  const kx = scale * S.gainX * agGain * (S.invertX ? -1 : 1);
  const ky = scale * S.gainY * agGain * (S.invertY ? -1 : 1);

  const blanking = S.blanking;
  const ref = Math.max(refSpeed > 0 ? refSpeed : T.plot * 0.01, T.plot * 0.0004);
  /* ONLY a numerical floor: it keeps ref/s finite when a segment does not move
     at all. It is deliberately tiny — anything comparable to the mean beam step
     would compress the 1/v law (see the dose below). */
  const eps = T.plot * 0.00002;
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
        if (T.gl) {
          /* Energy model: the same 1/v law, but it ADDS — no ladder to quantise
             into and no ceiling, because the tone map saturates instead. The cap
             only stops a stationary beam from overflowing a half float; 64 is
             already far past full brightness. */
          if (segN < T.gl.maxSegments) {
            const o = segN * 5;
            T.gl.segData[o] = prevX;
            T.gl.segData[o + 1] = prevY;
            T.gl.segData[o + 2] = x;
            T.gl.segData[o + 3] = y;
            T.gl.segData[o + 4] = Math.min(dose, 64);
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
  if (T.gl) {
    if (S.beamDot && segN < T.gl.maxSegments) {
      // A zero-length segment with a lot of energy IS a stationary beam: the
      // spot profile makes the dot, and the cloud makes it a flare.
      const o = segN * 5;
      T.gl.segData[o] = PX[n - 1];
      T.gl.segData[o + 1] = PY[n - 1];
      T.gl.segData[o + 2] = PX[n - 1] + 0.01;
      T.gl.segData[o + 3] = PY[n - 1] + 0.01;
      T.gl.segData[o + 4] = 4;
      segN++;
    }
    T.gl.deposit(segN);
  } else {
    paintInto(T.ctx, n, S.intensity);
  }
  lastDoseMax = doseMax;


  if (S.beamDot && T.ctx) {
    const lw = S.lineWidth * T.dpr;
    T.ctx.fillStyle = S.color;
    T.ctx.beginPath();
    T.ctx.arc(PX[n - 1], PY[n - 1], Math.max(1.5 * T.dpr, lw * 1.4), 0, TAU);
    T.ctx.fill();
  }
}

/** Stroke the already-computed beam path into `ctx` with `base` as the peak
    alpha. This is the only accumulation layer left. */
function paintInto(ctx, n, base) {
  ctx.lineWidth = S.lineWidth * T.dpr;
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

/** The peaks the frame log timestamps, and the dose the tests read. */
const peaks = () => ({ l: lastPeakL, r: lastPeakR });
const doseMax = () => lastDoseMax;
const segmentCount = () => (T.gl ? T.gl.state.segments : 0);
const haloOn = () => (S.halo > 0 ? 1 : 0);
export {
  doseMax,
  drawTrace,
  exposureFor,
  fadeAlpha,
  fadeLayer,
  fadeStep,
  findTrigger,
  haloMix,
  paintInto,
  peaks,
  requestWipe,
  resetRefSpeed,
  resetTraceState,
  scrubAlpha,
  segmentCount,
  setTarget,
  sigmaFor,
  tauFor,
};
