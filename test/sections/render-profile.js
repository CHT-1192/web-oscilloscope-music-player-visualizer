#!/usr/bin/env node
'use strict';

/* ============================================================================
    test/sections/render-profile.js — the SHAPE of the halo.

    A cloud of scattered light has to reach far and fall smoothly. Two earlier
    versions failed this: one widened the beam spot with the dose, so the light
    stopped dead at 3σ of that spot (a disc with an edge), and one put the halo
    in the energy buffer, where it saturated out to its own cutoff. So the
    profile is sampled at eight radii, and it has to be monotone with no cliff.
   ========================================================================== */

const h = require('../harness.js');
const { ok, bad } = h;

async function profile(ctx) {
  const { page, center, setSynth, setCtl, isGL } = ctx;

  /* The halo is a cloud of scattered light, so the profile running away from the
     beam has to REACH FAR and FALL SMOOTHLY. Two earlier versions failed this:
     one widened the beam spot with the dose, so the light stopped dead at 3σ of
     that spot (a disc with an edge, and a beaded trace), and one put the halo in
     the energy buffer, where it saturated out to its own cutoff — the same cliff. */
  const inkAbove = (dy) => page.evaluate(([d, cx, cy, size]) => {
    const y = Math.round(cy + 0.25 * size - d);      // the line sits at cy + PLOT/4
    const x = Math.round(cx);
    const px = window.__scope.readTrace(x - 6, y - 6, 13, 13);
    let max = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > max) max = px[i];
    return max;
  }, [dy, center.cx, center.cy, center.PLOT]);

  const meanInk = () => page.evaluate(() => {
    const st = window.__scope.state;
    const s = Math.round(st.plot.size);
    const d = window.__scope.readTrace(Math.round(st.plot.x), Math.round(st.plot.y), s, s);
    let sum = 0, n = 0;
    for (let i = 3; i < d.length; i += 4) { sum += d[i]; n++; }
    return sum / n;
  });

  await setSynth('line');
  await page.waitForTimeout(1800);
  const OFFSETS = [10, 18, 28, 40, 55, 75, 100, 130];
  await setCtl('halo', 100);          // the axis block above parked it at 0
  await page.waitForTimeout(1800);
  const profOn = [];
  for (const d of OFFSETS) profOn.push(await inkAbove(d));
  await setCtl('halo', 0);
  await page.waitForTimeout(1800);
  const nearOff = await inkAbove(10);
  const profOff = [];
  for (const d of OFFSETS) profOff.push(await inkAbove(d));

  if (isGL) {
    if (profOn[1] > 4 && nearOff === 0) {
      ok('the halo really is drawn around a dwelling beam', `10 px off the beam: ${nearOff} → ${profOn[1]}`);
    } else {
      bad('the halo really is drawn around a dwelling beam', `10 px: ${nearOff} off, ${profOn[1]} at 100`);
    }
    const rises = profOn.slice(1).some((v, i) => v > profOn[i] + 8);
    /* "No cliff": the profile may fade fast but it may not step off an edge. The
       old halos both ended in one — light stopped dead at 3σ of a widened spot,
       or at the cutoff of a halo term that had itself saturated. */
    const worstDrop = Math.max(...profOn.slice(1).map((v, i) => profOn[i] - v));
    if (profOn[0] > 5 && profOn[2] > 0 && !rises && worstDrop <= 12) {
      ok('the halo is a bounded skirt with no cliff',
        `alpha at ${OFFSETS.join('/')} px: ${profOn.join('/')}, worst drop ${worstDrop}`);
    } else {
      bad('the halo is a bounded skirt with no cliff',
        `alpha ${profOn.join('/')} · worst drop ${worstDrop}`);
    }
    if (profOff[0] === 0 && profOff[3] === 0) {
      ok('光晕 0 is exactly the old spot: nothing leaves the beam',
        `off at 10 px and at 28 px (${profOn[3]} at 光晕 100)`);
    } else {
      bad('光晕 0 is exactly the old spot', `${profOff.join('/')}`);
    }
    await setSynth('dense');
    await setCtl('halo', 0);
    await page.waitForTimeout(1800);
    const dense0 = await meanInk();
    await setCtl('halo', 100);
    await page.waitForTimeout(1800);
    const dense100 = await meanInk();
    if (dense100 > dense0 * 1.5) {
      ok('around a dense figure the cloud is unmissable',
        `mean alpha ${dense0.toFixed(1)} → ${dense100.toFixed(1)}`);
    } else {
      bad('around a dense figure the cloud is unmissable', `${dense0} → ${dense100}`);
    }
  } else if (profOn[0] === 0 && profOn[profOn.length - 1] === 0) {
    ok('Canvas path: no halo at all, as the disabled row says', `nothing past the stroke: ${profOn.join('/')}`);
  } else {
    bad('Canvas path: no halo at all', profOn.join('/'));
  }

  await page.evaluate(() => {
    const b = document.querySelector('[data-toggle="trigger"]');
    if (b && b.getAttribute('aria-pressed') === 'false') b.click();
  });
}

module.exports = profile;
