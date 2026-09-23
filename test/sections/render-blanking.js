#!/usr/bin/env node
'use strict';

/* ============================================================================
    test/sections/render-blanking.js — velocity blanking.

    With the synthetic source drawing a slow square plus one fast diagonal
    retrace, the pixels in the middle of the plot can only come from that
    retrace: off, it has to be there; on, it has to be gone; and the threshold
    has to be the number the slider says, all the way down to the aggressive
    bottom of the range.
   ========================================================================== */

const path = require('node:path');
const h = require('../harness.js');
const { ok, bad, SHOTS } = h;

async function blanking(ctx) {
  const { page, center } = ctx;

  // turn blanking off through the real UI control
  await page.evaluate(() => {
    const b = document.querySelector('[data-toggle="blanking"]');
    if (b && b.getAttribute('aria-pressed') === 'true') b.click();
  });
  await page.waitForTimeout(1400);
  const offMid = await page.evaluate((c) => window.__measure(c.cx, c.cy, c.PLOT * 0.12, c.PLOT * 0.12), center);
  const offEdge = await page.evaluate((c) => window.__measure(c.cx + c.PLOT * 0.35, c.cy, 6, c.PLOT * 0.2), center);
  await page.screenshot({ path: path.join(SHOTS, 'retrace-blanking-off.png') });

  if (offEdge.max > 40) ok('synthetic square stroke is rendered', `edge alpha ${offEdge.max}`);
  else bad('synthetic square stroke is rendered', `edge alpha ${offEdge.max}`);

  /* ---- synthetic retrace, blanking ON --------------------------------- */
  await page.evaluate(() => {
    const b = document.querySelector('[data-toggle="blanking"]');
    if (b && b.getAttribute('aria-pressed') === 'false') b.click();
  });
  await page.waitForTimeout(1600);
  const onMid = await page.evaluate((c) => window.__measure(c.cx, c.cy, c.PLOT * 0.12, c.PLOT * 0.12), center);
  const onEdge = await page.evaluate((c) => window.__measure(c.cx + c.PLOT * 0.35, c.cy, 6, c.PLOT * 0.2), center);
  await page.screenshot({ path: path.join(SHOTS, 'retrace-blanking-on.png') });

  if (onEdge.max > 40) ok('square stroke still rendered with blanking on', `edge alpha ${onEdge.max}`);
  else bad('square stroke still rendered with blanking on', `edge alpha ${onEdge.max}`);
  if (onMid.max <= 4) ok('NO RETRACE LINE through the centre', `centre alpha ${onMid.max} (was ${offMid.max})`);
  else bad('NO RETRACE LINE through the centre', `centre alpha ${onMid.max} — retrace still visible`);

  /* The control: with velocity blanking off the retrace has to get THROUGH. How
     bright it is differs by model and the check is stated so both are honest
     about it — the 8-bit path strokes everything at one alpha when blanking is
     off, while the energy path keeps the 1/v law (a fast beam deposits very
     little) and only stops DROPPING it. So: brighter than with blanking on, and
     not zero. */
  if (offMid.max > 0 && offMid.max > onMid.max) {
    ok('control: blanking off lets the retrace through', `centre ${offMid.max} off vs ${onMid.max} on`);
  } else {
    bad('control: blanking off lets the retrace through', `centre ${offMid.max} off vs ${onMid.max} on — nothing is reaching the renderer`);
  }

  /* ---- the blanking threshold is exact, and adjustable ---------------- */
  const centreAlpha = () => page.evaluate(() => {
    const st = window.__scope.state;
    const c = window.__scope.state.canvas;
    const size = window.__scope.state.canvas;
    const x = Math.round(st.plot.x + st.plot.size / 2);
    const y = Math.round(st.plot.y + st.plot.size / 2);
    const d = window.__scope.readTrace(x - 5, y - 5, 11, 11);
    let max = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > max) max = d[i];
    return max;
  });
  const runAt = async (ratio, threshold) => {
    await page.evaluate((c) => {
      window.__synthF = 0.2612 / c.ratio;      // 1.98 / (f * 7.58)
      const el = document.querySelector('[data-set="blankRatio"]');
      el.value = String(c.threshold);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, { ratio, threshold });
    await page.waitForTimeout(1700);
    return centreAlpha();
  };

  const thrKept = await runAt(8, 12);          // 8x, threshold 12x -> drawn
  const thrDropped = await runAt(8, 5);        // 8x, threshold  5x -> blanked
  if (thrKept > 12 && thrDropped === 0) {
    ok('blanking threshold is the number the slider says',
      `8x kept at a 12x threshold (alpha ${thrKept}), dropped at 5x`);
  } else {
    bad('blanking threshold is the number the slider says', `12x -> ${thrKept}, 5x -> ${thrDropped}`);
  }

  /* The useful range is bounded by where the material's segment speeds live:
     they cluster (slow stroke, fast retrace) with a gap in between, so past the
     top of the gap the slider does nothing at all. Hence 1x-15x, not 1x-30x. */
  const thrEdge = await runAt(12, 15);         // 12x, threshold 15x -> drawn
  if (thrEdge > 12) ok('15x is wide enough to readmit a 12x retrace', `alpha ${thrEdge}`);
  else bad('15x is wide enough to readmit a 12x retrace', `alpha ${thrEdge}`);

  const slider = await page.evaluate(() => {
    const el = document.querySelector('[data-set="blankRatio"]');
    const out = document.querySelector('[data-out="blankRatio"]');
    const read = (v) => {
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return out.textContent;
    };
    const labels = [1, 7.5, 10, 15].map(read);
    el.value = '10';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { min: el.min, max: el.max, step: el.step, labels };
  });
  if (slider.min === '1' && slider.max === '15' && slider.step === '0.5') {
    ok('blanking slider spans 1x-15x in half steps', `${slider.min}-${slider.max} step ${slider.step}, labels ${slider.labels.join(' ')}`);
  } else {
    bad('blanking slider spans 1x-15x in half steps', JSON.stringify(slider));
  }
  if (slider.labels[1] === '7.5×' && slider.labels[3] === '15×') {
    ok('fractional thresholds keep their half', slider.labels.join(' '));
  } else {
    bad('fractional thresholds keep their half', slider.labels.join(' '));
  }

  /* The bottom of the range is aggressive (half the segments can go) but must
     never erase the picture: at 1x the slow stroke is all that is left. */
  await runAt(8, 1);
  const edgeAtOne = await page.evaluate(
    (c) => window.__measure(c.cx + c.PLOT * 0.35, c.cy, 6, c.PLOT * 0.2).max, center);
  if (edgeAtOne > 40) ok('1x is aggressive but does not wipe the stroke', `edge alpha ${edgeAtOne}`);
  else bad('1x is aggressive but does not wipe the stroke', `edge alpha ${edgeAtOne}`);
  await runAt(8, 12);

  await page.evaluate(() => {
    const el = document.querySelector('[data-set="blankRatio"]');
    el.value = '10';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(400);
}

module.exports = blanking;
