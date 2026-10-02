#!/usr/bin/env node
'use strict';

/* ============================================================================
    test/sections/render-stroke.js — a stroke is deposited once.

    The deposit is one primitive per sample segment: a disc of radius 3σ around
    the nearest point of that segment. If every segment reaches past its own ends
    — which is what a capsule does — then two neighbours deposit the same pixels
    twice, once per SAMPLE, and the trace comes out as a string of beads. On a
    synthetic circle at a constant pixel speed that is a comb at exactly one
    cycle per sample: 13.1 alpha (13.8 % of the mean) against 0.1-0.9 in the
    neighbouring bins at device pixel ratio 2, and 5.45 against 0.37/0.22 at the
    ratio this scene runs at, while the 8-bit path — which strokes contiguous
    runs as one polyline — stayed flat. Segments longer than the spot now reach to
    their own ends and tile; only a segment shorter than the spot keeps the round
    cap, which is the ball a lingering beam is supposed to make.

    So two things are checked here: the comb is gone, and a beam that really is
    parked (digital silence, which is in this material) is still a dot. The
    second one is not decoration — a degenerate segment has no direction, and
    both renderers used to draw NOTHING for a parked beam.
   ========================================================================== */

const h = require('../harness.js');
const { ok, bad } = h;

/** Comb depth at the sample pitch, over one turn of a constant-speed circle. */
const combOf = (page) => page.evaluate(() => {
  const st = window.__scope.state;
  const c = st.canvas;
  const pc = window.__plotCenter();
  const P = st.windowSize;
  const r0 = 0.7 * pc.PLOT / 2;
  const N = 2048;                                  // 4x the pitch, so k = P is not Nyquist
  const d = window.__scope.readTrace(0, 0, c.w, c.h);
  const at = (x, y) => (x < 0 || y < 0 || x >= c.w || y >= c.h) ? 0 : d[((y | 0) * c.w + (x | 0)) * 4 + 3];
  const prof = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    let best = 0;
    for (let o = -8; o <= 8; o++) best = Math.max(best, at(pc.cx + Math.cos(a) * (r0 + o), pc.cy + Math.sin(a) * (r0 + o)));
    prof[i] = best;
  }
  const mag = (k) => {
    let re = 0, im = 0;
    for (let i = 0; i < N; i++) { const p = -2 * Math.PI * k * i / N; re += prof[i] * Math.cos(p); im += prof[i] * Math.sin(p); }
    return Math.sqrt(re * re + im * im) * 2 / N;
  };
  let mean = 0;
  for (let i = 0; i < N; i++) mean += prof[i];
  const sigma = Number(document.querySelector('[data-set="lineWidth"]').value) * st.effectiveDpr * 0.5;
  return {
    mean: +(mean / N).toFixed(1),
    pitch: +mag(P).toFixed(2),
    beside: [+mag(P - 2).toFixed(2), +mag(P + 2).toFixed(2)],
    arcStep: +(2 * Math.PI * r0 / P).toFixed(2),
    sigma: +sigma.toFixed(2),
    dpr: st.effectiveDpr,
  };
});

/** The parked beam: how big and how bright the dot is. */
const dotOf = (page) => page.evaluate(() => {
  const st = window.__scope.state;
  const c = st.canvas;
  const d = window.__scope.readTrace(0, 0, c.w, c.h);
  let peak = 0, lit = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
  for (let y = 0; y < c.h; y++) {
    for (let x = 0; x < c.w; x++) {
      const a = d[(y * c.w + x) * 4 + 3];
      if (a > peak) peak = a;
      if (a > 24) { lit++; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
    }
  }
  return { peak, lit, box: x1 < 0 ? [0, 0] : [x1 - x0 + 1, y1 - y0 + 1] };
});

async function stroke(ctx) {
  const { page, setSynth, setCtl, isGL } = ctx;

  /* ---- the comb -------------------------------------------------------- */
  setSynth('uniform');                     // constant pixel speed round a circle
  await setCtl('windowIdx', 0);            // 512 samples: the largest step the window allows
  await setCtl('persistence', 0);          // one frame's deposit, nothing accumulated
  await setCtl('intensity', 1.6);          // mid-grey, where the tone map still shows a ratio
  await setCtl('halo', 0);                 // the cloud would smear the profile
  await page.waitForTimeout(1500);

  const comb = await combOf(page);
  /* The measurement is only meaningful when a sample step is at least a spot
     wide: with a much shorter step the caps of a dozen samples overlap into a
     uniform line, which is the wrong energy but not a comb. At this geometry —
     step 2.56 px, σ 0.88 px — the old always-capsule deposit measured 5.45 here,
     against 0.37 and 0.22 in the bins either side, so the scene can show one. */
  const resolvable = comb.arcStep > comb.sigma && comb.mean > 20;
  if (resolvable && comb.pitch < 2.5) {
    ok('a stroke is deposited once, not once per sample',
      `comb at the sample pitch ${comb.pitch} vs ${comb.beside[0]}/${comb.beside[1]} either side ` +
      `(step ${comb.arcStep} px, σ ${comb.sigma} px, was 5.45${isGL ? '' : ', 8-bit path'})`);
  } else {
    bad('a stroke is deposited once, not once per sample',
      `pitch ${comb.pitch} (beside ${comb.beside.join('/')}), step ${comb.arcStep}, σ ${comb.sigma}, mean ${comb.mean}` +
      (resolvable ? '' : ' — the scene cannot show a comb at all'));
  }

  /* ---- the parked beam ------------------------------------------------- */
  setSynth('stationary');                  // every sample the same point: digital silence
  await setCtl('intensity', 0.9);
  await page.waitForTimeout(900);
  const dot = await dotOf(page);
  if (dot.peak > 128 && dot.lit >= 4 && dot.box[0] >= 2 && dot.box[1] >= 2) {
    ok('a parked beam is a dot, not an empty screen',
      `peak ${dot.peak}, ${dot.lit} lit px, ${dot.box[0]}×${dot.box[1]}${isGL ? '' : ' (8-bit path)'}`);
  } else {
    bad('a parked beam is a dot, not an empty screen', JSON.stringify(dot));
  }

  /* ---- and the same with blanking off, which strokes one plain polyline -- */
  await page.evaluate(() => {
    const b = document.querySelector('[data-toggle="blanking"]');
    if (b.getAttribute('aria-pressed') === 'true') b.click();
  });
  await page.waitForTimeout(900);
  const dot2 = await dotOf(page);
  if (dot2.peak > 128 && dot2.lit >= 4) {
    ok('blanking off: still a dot', `peak ${dot2.peak}, ${dot2.lit} lit px`);
  } else {
    bad('blanking off: still a dot', JSON.stringify(dot2));
  }
  await page.evaluate(() => {
    const b = document.querySelector('[data-toggle="blanking"]');
    if (b.getAttribute('aria-pressed') === 'false') b.click();
  });
}

module.exports = { stroke };
