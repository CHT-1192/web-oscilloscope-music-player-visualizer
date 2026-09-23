#!/usr/bin/env node
'use strict';

/* ============================================================================
    test/sections/render-surface.js — the drawing surface itself.

    The accumulation layer surviving a relayout (assigning canvas.width clears
    the bitmap), the 8-bit quantisation floor and the residue slider that
    scrubs it, the plot sitting dead centre with the panels open, the shots the
    docs use, and the accumulated runtime errors for the whole session.
   ========================================================================== */

const path = require('node:path');
const h = require('../harness.js');
const { ok, bad, SHOTS } = h;

async function surface(ctx) {
  const { page, realErrors } = ctx;

  /* ---- the accumulation layer survives a relayout ----------------------
     Assigning canvas.width clears the bitmap, so resizeKeeping has to carry the
     layer across or a window resize silently eats the picture. Paused, with a
     long afterglow and no hard scrub: otherwise this measures the music instead
     of the carry-over. */
  await page.evaluate(() => {
    const set = (k, v) => {
      const el = document.querySelector(`[data-set="${k}"]`);
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    document.getElementById('audio').pause();
    set('persistence', 100);
    set('residue', 40);          // keep the periodic scrub gentle between samples
  });
  await page.waitForTimeout(2500);
  /* Box-average the frame onto a fixed grid, through the seam: the viewport
     changes size between the two samples, so the grids have to match. */
  const sigOf = () => page.evaluate(() => {
    const c = window.__scope.state.canvas;
    const d = window.__scope.readTrace(0, 0, c.w, c.h);
    const TW = 256, TH = 160;
    const out = [];
    for (let ty = 0; ty < TH; ty++) {
      for (let tx = 0; tx < TW; tx++) {
        const x0 = Math.floor(tx * c.w / TW);
        const x1 = Math.max(x0 + 1, Math.floor((tx + 1) * c.w / TW));
        const y0 = Math.floor(ty * c.h / TH);
        const y1 = Math.max(y0 + 1, Math.floor((ty + 1) * c.h / TH));
        let sum = 0, n = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) { sum += d[(y * c.w + x) * 4 + 1]; n++; }
        }
        out.push(n ? sum / n : 0);
      }
    }
    return out;
  });

  const sigBefore = await sigOf();
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.waitForTimeout(1400);
  const sigAfter = await sigOf();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(1400);
  let sigSum = 0;
  for (let i = 0; i < sigBefore.length; i++) sigSum += Math.abs(sigBefore[i] - sigAfter[i]);
  const sigMean = sigSum / sigBefore.length;
  /* 8 rather than the 4 this used when it probed the burn-in ghost: the probe is
     now the live afterglow layer, which keeps converging towards saturation
     while paused. A layer actually eaten by the relayout is a delta of tens. */
  if (sigMean < 8) ok('layers survive a window resize', `mean pixel delta ${sigMean.toFixed(2)} / 255`);
  else bad('layers survive a window resize', `mean pixel delta ${sigMean.toFixed(2)} — the layer was eaten`);

  /* ---- residue: the 8-bit quantisation floor --------------------------- */
  /* destination-out multiplies alpha, so with round-to-nearest every value
     n <= 1/(2a) is a fixed point. A slow fade (high 余辉) therefore leaves a
     BRIGHTER permanent ghost, not a longer one. The 残留 slider scrubs it. */
  const ghostBand = () => page.evaluate(() => {
    const c = window.__scope.state.canvas;
    const d = window.__scope.readTrace(0, 0, c.w, c.h);
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8 && d[i] <= 64) n++;
    return +((n * 100) / (c.w * c.h)).toFixed(3);
  });
  const setNum = (k, v) => page.evaluate((c) => {
    const el = document.querySelector(`[data-set="${c.k}"]`);
    el.value = String(c.v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, { k, v });

  const ghostAfterRun = async (residue) => {
    await setNum('persistence', 100);
    await setNum('residue', residue);
    await page.evaluate(() => {
      const a = document.getElementById('audio');
      a.currentTime = 60;
      if (a.paused) document.getElementById('btnPlay').click();
    });
    await page.waitForTimeout(9000);
    await page.evaluate(() => document.getElementById('audio').pause());
    await page.waitForTimeout(5000);
    return ghostBand();
  };

  const ghostOn = await ghostAfterRun(100);
  const ghostOff = await ghostAfterRun(0);
  /* The floor is a property of an 8-bit backing store: `destination-out` rounds,
     so everything at or below 1/(2a) is a fixed point and never fades. The float
     accumulation buffer has no such value, which is the whole reason the energy
     path exists — so on that path the check is stated as its absence, and the
     residue slider is not asked to do anything. */
  const renderer = await page.evaluate(() => window.__scope.state.renderer);
  if (renderer === 'webgl2') {
    /* No floor to scrub. A float buffer decays as exp(-dt/τ) with no smallest
       representable value, so the 残留 slider changes nothing — and that is what
       gets asserted, by measuring the same run at 100 % and at 0 % and requiring
       them to agree. (An earlier version of this check looked for ink in the
       alpha 9-64 band and failed: that band is just legitimately dim afterglow,
       and while paused the frozen frame keeps being painted, so ink never
       disappears — the floor is not what that metric can see.) */
    if (Math.abs(ghostOn - ghostOff) < 1) {
      ok('the residue slider does nothing on the float path',
        `${ghostOn}% vs ${ghostOff}% with the slider at 100 % and 0 %`);
    } else {
      bad('the residue slider does nothing on the float path', `${ghostOn}% vs ${ghostOff}%`);
    }
  } else {
    if (ghostOn > 5) ok('residue 100% leaves a permanent ghost', `${ghostOn}% of the canvas at alpha 9-64`);
    else bad('residue 100% leaves a permanent ghost', `${ghostOn}%`);
    if (ghostOff < ghostOn / 10) {
      ok('residue off (default) wipes the quantisation floor', `${ghostOff}% vs ${ghostOn}%`);
    } else {
      bad('residue off (default) wipes the quantisation floor', `${ghostOff}% vs ${ghostOn}%`);
    }
  }
  await page.evaluate(() => document.getElementById('btnReset').click());
  await page.waitForTimeout(600);

  /* ---- the plot must sit dead centre --------------------------------
     A stray `grid-column: 2` on the toast conjured a second implicit grid
     column, which squeezed the stage and shoved the plot 74px left — visible
     to the eye but invisible to every other assertion here. */
  const centreOffset = () => page.evaluate(() => {
    const st = document.getElementById('stage').getBoundingClientRect();
    const s = window.__scope.state;
    const d = s.effectiveDpr;
    const cx = st.left + (s.plot.x + s.plot.size / 2) / d;
    const cy = st.top + (s.plot.y + s.plot.size / 2) / d;
    return {
      dx: +Math.abs(cx - innerWidth / 2).toFixed(1),
      dy: +Math.abs(cy - (st.top + st.height / 2)).toFixed(1),
      size: Math.round(s.plot.size / d),
    };
  });

  const centreClosed = await centreOffset();
  await page.evaluate(() => document.getElementById('btnSettings').click());
  await page.waitForTimeout(500);
  const centreOpen = await centreOffset();
  await page.evaluate(() => document.getElementById('btnSettings').click());
  await page.waitForTimeout(500);

  if (centreClosed.dx <= 1 && centreClosed.dy <= 1) {
    ok('plot is centred in the window', `off by ${centreClosed.dx}, ${centreClosed.dy} px`);
  } else {
    bad('plot is centred in the window', JSON.stringify(centreClosed));
  }
  if (centreOpen.dx <= 1 && centreOpen.dy <= 1) {
    ok('opening a panel does not move the plot', `off by ${centreOpen.dx} px, size ${centreOpen.size}px`);
  } else {
    bad('opening a panel does not move the plot', JSON.stringify(centreOpen));
  }

  await page.evaluate(() => document.querySelector('#btnList').click());
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, 'playlist.png') });
  await page.evaluate(() => {
    document.querySelector('#btnList').click();
    document.querySelector('#btnSettings').click();
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, 'settings.png') });

  const lateErrors = realErrors();
  if (lateErrors.length === 0) ok('no runtime errors during playback');
  else bad('no runtime errors during playback', lateErrors.slice(0, 3).join(' | '));
}

module.exports = surface;
