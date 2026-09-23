#!/usr/bin/env node
'use strict';

/* ============================================================================
    test/sections/render-halo.js — the halo control and the dose behind it.

    Two claims are checked here, and they are different claims: the halo row is
    live exactly on the renderer that implements it (the residue row is its
    mirror image), and the dose that drives the dashes does not depend on the
    halo slider at all.
   ========================================================================== */

const h = require('../harness.js');
const { ok, bad } = h;

async function halo(ctx) {
  const { page, isGL, setSynth, setCtl, doseOf } = ctx;

  /* ---- the halo (光晕): a spot that grows with the dose ------------------
     The reference is a photo of a real analog scope: a thin trace with a big
     round flare exactly where the beam slowed down. So these assert the SHAPE of
     that law rather than "a slider exists":

       · the DOSE decides, not the slider — a constant-speed figure barely swells
         while a stationary beam reaches the cap;
       · the halo is still the spot: nothing appears beyond 3σ of the widest one,
         which is what keeps this a bigger beam and not a bloom pass;
       · and the row is honest about which renderer implements it. */
  const haloRow = await page.evaluate(() => {
    const el = document.querySelector('[data-set="halo"]');
    return {
      min: el.min, max: el.max, step: el.step, def: el.value,
      disabled: el.disabled, title: el.title,
      out: document.querySelector('[data-out="halo"]').textContent,
      residueOff: document.querySelector('[data-set="residue"]').disabled,
    };
  });
  if (haloRow.min === '0' && haloRow.max === '100' && haloRow.def === '0' && haloRow.out === '关') {
    ok('the halo control exists, defaults to off', `${haloRow.min}-${haloRow.max}, label 关`);
  } else {
    bad('the halo control exists, defaults to off', JSON.stringify(haloRow));
  }
  if (haloRow.disabled === !isGL) {
    ok('the halo row is enabled exactly where it works', `${isGL ? 'webgl2' : 'canvas2d'} → disabled=${haloRow.disabled}`);
  } else {
    bad('the halo row is enabled exactly where it works', JSON.stringify({ isGL, disabled: haloRow.disabled }));
  }
  /* The mirror image: 残留 scrubs an 8-bit floor the energy path does not have,
     so leaving THAT one live under WebGL is the same lie in reverse. */
  if (haloRow.residueOff === isGL) {
    ok('the residue row is enabled exactly where it works', `disabled=${haloRow.residueOff}`);
  } else {
    bad('the residue row is enabled exactly where it works', JSON.stringify({ isGL, disabled: haloRow.residueOff }));
  }

  /* The trigger is what makes the drawn window deterministic here: findTrigger
     shifts the start index, and a dwell that slid out of the drawn half of the
     buffer would silently turn these measurements into "nothing happened". */
  await page.evaluate(() => {
    const b = document.querySelector('[data-toggle="trigger"]');
    if (b && b.getAttribute('aria-pressed') === 'true') b.click();
  });

  await setCtl('halo', 0);
  await setSynth('uniform');
  await page.waitForTimeout(1500);
  const uni0 = await doseOf();
  await setSynth('stationary');
  await page.waitForTimeout(1500);
  const flat0 = await doseOf();

  await setCtl('halo', 100);
  await setSynth('stationary');
  await page.waitForTimeout(1500);
  const flat100 = await doseOf();

  /* The DOSES are where the dashes come from, so assert them directly: a beam
     that never moves must deposit orders of magnitude more per unit length than
     one sweeping at the mean speed. A display-sized floor in the denominator
     (PLOT x 0.0015 ≈ 1.7x the mean step of a 600 px plot, which is what this
     used to be) flattens that to ~2x, and the trace then renders as a uniformly
     bright web whose contrast comes only from self-overlap. */
  if (flat0 > 8 && uni0 > 0.5 && uni0 < 3) {
    ok('the 1/v dose is unbounded above the mean',
      `stationary x${flat0.toFixed(0)} vs sweeping x${uni0.toFixed(2)}`);
  } else {
    bad('the 1/v dose is unbounded above the mean', JSON.stringify({ stationary: flat0, uniform: uni0 }));
  }
  if (Math.abs(flat100 - flat0) < 1e-6) {
    ok('the dose does not depend on the halo slider', `x${flat100.toFixed(0)}`);
  } else {
    bad('the dose does not depend on the halo slider', `${flat0} vs ${flat100}`);
  }
}

module.exports = halo;
