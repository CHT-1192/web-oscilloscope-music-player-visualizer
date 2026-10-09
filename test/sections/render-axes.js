#!/usr/bin/env node
'use strict';

/* ============================================================================
    test/sections/render-axes.js — which way the axes point.

    X = left channel, Y = right, positive up, is the scope convention. A track
    made the other way round looks mirrored and the only honest fix is a switch,
    so: the switch has to move the picture, and the readout has to admit the sign
    it is actually using instead of showing a bare "+1.00" over an upside-down
    figure.
   ========================================================================== */

const h = require('../harness.js');
const { ok, bad } = h;

async function axes(ctx) {
  const { page, center, setSynth, setCtl } = ctx;

  /* ---- which way the axes point -----------------------------------------
     The convention is X = left, Y = right, positive up. A track (or a reference
     video) made the other way round looks mirrored, and the only honest fix is a
     switch — so assert that one moves the picture, and that the readout admits
     it rather than claiming a bare +1.00 next to an upside-down picture. */
  const inkAt = (dy) => page.evaluate(([d, cx, cy]) => {
    const y = Math.round(cy + d), x = Math.round(cx);
    const px = window.__scope.readTrace(x - 6, y - 6, 13, 13);
    let max = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > max) max = px[i];
    return max;
  }, [dy, center.cx, center.cy]);
  const QUARTER = center.PLOT / 4;   // the 'line' synth sits this far below centre
  await setSynth('line');
  await setCtl('halo', 0);
  await page.waitForTimeout(1600);
  const downBefore = await inkAt(QUARTER);
  const upBefore = await inkAt(-QUARTER);

  /* Where the seam's rows run. Every "above" and "below" reading in this suite
     goes through `readTrace`, and GL's readPixels counts rows from the BOTTOM:
     the energy path handed back an upside-down image while the 8-bit path
     (getImageData, top-down) did not. Small boxes cannot see it — the ink is
     inside the box either way — so this measures the centroid of a whole-canvas
     scan instead, against the plot centre, on a pattern that sits below it. */
  const seam = await page.evaluate(() => {
    const st = window.__scope.state;
    const c = st.canvas;
    const d = window.__scope.readTrace(0, 0, c.w, c.h);
    let sum = 0, n = 0;
    for (let y = 0; y < c.h; y++) {
      let row = 0;
      for (let x = 0; x < c.w; x++) row += d[(y * c.w + x) * 4 + 3];
      if (row) { sum += y * row; n += row; }
    }
    return { centroid: n ? +(sum / n).toFixed(1) : -1, centre: +(c.h / 2).toFixed(1), h: c.h };
  });
  if (seam.centroid > seam.centre + 10) {
    ok('the debug seam reads the same way up on both renderers',
      `ink centroid row ${seam.centroid} vs plot centre ${seam.centre} (the line sits below it)`);
  } else {
    bad('the debug seam reads the same way up on both renderers',
      `centroid ${seam.centroid} vs centre ${seam.centre} — the readback is upside down`);
  }

  const outBefore = await page.evaluate(() =>
    document.querySelector('[data-out="gainY"]').textContent);
  await page.evaluate(() => document.querySelector('[data-toggle="invertY"]').click());
  await page.waitForTimeout(1600);
  const downAfter = await inkAt(QUARTER);
  const upAfter = await inkAt(-QUARTER);
  const outAfter = await page.evaluate(() =>
    document.querySelector('[data-out="gainY"]').textContent);
  await page.evaluate(() => document.querySelector('[data-toggle="invertY"]').click());
  await page.waitForTimeout(1200);

  if (downBefore > 40 && upBefore === 0 && upAfter > 40 && downAfter === 0) {
    ok('Y 反向 flips the picture',
      `ink below/above the centre ${downBefore}/${upBefore} → ${downAfter}/${upAfter}`);
  } else {
    bad('Y 反向 flips the picture',
      JSON.stringify({ downBefore, upBefore, downAfter, upAfter }));
  }
  if (outBefore === '1.00' && outAfter === '-1.00') {
    ok('the gain readout shows the sign in use', `${outBefore} → ${outAfter}`);
  } else {
    bad('the gain readout shows the sign in use', `${outBefore} → ${outAfter}`);
  }
}

module.exports = axes;
