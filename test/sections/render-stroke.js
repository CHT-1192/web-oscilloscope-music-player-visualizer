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

  /* ---- a dash boundary is one sample wide, not three -------------------- */
  /* What the phosphor integrates is the DWELL RATE over its own footprint, so a
     fast stroke stays flat right up to where the beam slows down. This pattern
     keeps both halves on ONE line — a corner would put its own blob at the
     boundary and hide the effect: the fast half steps ~12 px per sample and the
     slow half ~0.12, so the dwell rate steps by ~100x with no kink in the path.
     Blanking has to be off for it, because the fast half is 20x the mean speed
     and the blanking threshold would simply drop it, and the phase trigger has to
     be off because it re-slices the window to a rising zero crossing, which would
     move both halves somewhere other than where this looks for them. */
  setSynth('speed');
  await setCtl('windowIdx', 2);            // 2048
  await setCtl('persistence', 0);          // one frame's deposit, no afterglow
  await setCtl('intensity', 1.2);          // the fast half lands mid-grey
  await setCtl('halo', 0);
  await page.evaluate(() => {
    for (const t of ['blanking', 'trigger']) {
      const b = document.querySelector(`[data-toggle="${t}"]`);
      if (b.getAttribute('aria-pressed') === 'true') b.click();
    }
  });
  await page.waitForTimeout(1800);
  const ramp = await page.evaluate(() => {
    const st = window.__scope.state;
    const c = st.canvas;
    const pc = window.__plotCenter();
    const d = window.__scope.readTrace(0, 0, c.w, c.h);
    const al = (x, y) => (x < 0 || y < 0 || x >= c.w || y >= c.h) ? 0 : d[((y | 0) * c.w + (x | 0)) * 4 + 3];
    const yc = Math.round(pc.cy - 0.2 * pc.PLOT / 2);
    const x0 = Math.round(pc.cx - 0.8 * pc.PLOT / 2);
    const xm = Math.round(pc.cx);                      // the speed change is at x = 0
    const prof = [];
    for (let x = x0; x <= Math.round(pc.cx + 0.8 * pc.PLOT / 2); x++) {
      let m = 0;
      for (let dy = -3; dy <= 3; dy++) m = Math.max(m, al(x, yc + dy));
      prof.push(m);
    }
    const at = (x) => prof[x - x0];
    const fast = at(x0 + 20);
    const slow = Math.max(...prof.slice(xm - x0, xm - x0 + 6));
    const lvl = (p) => fast + (slow - fast) * p;
    let hi = xm, lo = xm;
    for (let x = xm; x >= x0; x--) if (at(x) <= lvl(0.9)) { hi = x; break; }
    for (let x = xm; x >= x0; x--) if (at(x) <= lvl(0.1)) { lo = x; break; }
    const step = 0.8 * pc.PLOT / 2 / (0.01 * st.windowSize);
    /* The fast half's own level well away from the boundary, and how far the ramp
       reaches back into it: 35 px of smear is what the old ±3 SAMPLE box did. */
    return { step: +step.toFixed(2), fast, slow, rampPx: hi - lo, backPx: xm - lo, near: at(xm - 20) };
  });
  /* A scene that cannot show the ramp must fail loudly, not pass at zero. */
  const rampSeen = ramp.fast > 0 && ramp.slow > ramp.fast * 1.5;
  if (isGL) {
    if (rampSeen && ramp.rampPx <= ramp.step * 1.6 && ramp.near <= ramp.fast * 1.15) {
      ok('a dash boundary is one sample wide, not three',
        `ramp ${ramp.rampPx} px against a ${ramp.step} px sample; ${ramp.backPx} px back it is ${ramp.near} vs ${ramp.fast}`);
    } else {
      bad('a dash boundary is one sample wide, not three',
        JSON.stringify(ramp) + (rampSeen ? '' : ' — the scene shows no ramp at all'));
    }
  } else if (ramp.fast > 0 && ramp.fast === ramp.slow) {
    /* The 8-bit path has no 1/v law with blanking off at all — it strokes the
       whole path as ONE polyline at one alpha — so there is no ramp here for it
       to smear. Asserting exactly that is the honest check for this renderer. */
    ok('8-bit path: blanking off is one alpha, so nothing to smear', `flat at ${ramp.fast}`);
  } else {
    bad('8-bit path: blanking off is one alpha, so nothing to smear', JSON.stringify(ramp));
  }
  await page.evaluate(() => {
    for (const t of ['blanking', 'trigger']) {
      const b = document.querySelector(`[data-toggle="${t}"]`);
      if (b.getAttribute('aria-pressed') === 'false') b.click();
    }
  });
}

module.exports = { stroke };
