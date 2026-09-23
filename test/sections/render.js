#!/usr/bin/env node
'use strict';

/* ============================================================================
    test/sections/render.js — the render layer, as one browser session.

    One Playwright launch, one page, and a sequence of scenes that each measure
    a different property of the drawing: the retrace blanking, the halo, the
    model badge, the axes, the halo profile, live audio, the accumulation
    surface, and the theme colour. They share the session because that is what
    keeps a full run under ten minutes, and because the console/page errors
    collected along the way are asserted at the end of the run.

    The scenes are the render-*.js files next to this one. Each receives a ctx
    with the page, the navigation helper and the shared measurement helpers; the
    whole sequence runs twice, once per renderer path (rq = '?renderer=2d').
   ========================================================================== */

const h = require('../harness.js');
const { ok, bad, section, findChromium } = h;
const { SYNTH } = require('./render-synth.js');
const blanking = require('./render-blanking.js');
const halo = require('./render-halo.js');
const model = require('./render-model.js');
const axes = require('./render-axes.js');
const profile = require('./render-profile.js');
const audio = require('./render-audio.js');
const surface = require('./render-surface.js');
const theme = require('./render-theme.js');

async function renderTests(pw, rq = '') {
  const BASE = h.base;
  /* One query string, not two: `${rq}${rest}` produced '?renderer=2d?demo=1',
     which silently dropped demo=1 — and the synthetic phase then measured an
     empty screen while every other check passed. */
  const nav = (rest) => `${BASE}/${rq}${rq ? rest.replace('?', '&') : rest}`;
  section(`Render layer (Chromium) — ${rq ? 'forced Canvas-2D' : 'default (WebGL when available)'}`);

  const browser = await pw.chromium.launch({
    executablePath: findChromium(),
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = m.location() && m.location().url ? m.location().url : '';
    errors.push(`console: ${m.text()}${url ? ` @ ${url}` : ''}`);
  });
  const realErrors = () => errors.filter((e) => !/favicon/i.test(e));

  await page.addInitScript(SYNTH);
  await page.goto(nav('?demo=1'), { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  if (!realErrors().length) ok('app boots with no console/page errors');
  else bad('app boots with no console/page errors', realErrors().slice(0, 3).join(' | '));

  // The AudioContext must actually be running for the analysers to produce data.
  const running = await page.evaluate(() => {
    const c = window.__scope.state.canvas;
    return !!c && c.w > 0 && c.h > 0;
  });
  if (running) ok('canvases sized for the viewport');
  else bad('canvases sized for the viewport');

  /* ---- synthetic retrace, blanking OFF -------------------------------- */
  await page.evaluate(() => { window.__synthOn = true; });
  const center = await page.evaluate(() => window.__plotCenter());

  /* Helpers the scenes share: switch the synthetic figure, set a slider, read
     the live dose, and which renderer is actually drawing. */
  const setSynth = (mode) => page.evaluate((m) => {
    window.__synthMode = m;
    window.__synthPoint = function (t) {
      const k = window.__synthMode;
      if (k === 'uniform') {                     // constant pixel speed: no dwell
        return [0.7 * Math.cos(t * Math.PI * 2), 0.7 * Math.sin(t * Math.PI * 2)];
      }
      if (k === 'stationary') return [0, 0];     // a beam that never moves
      if (k === 'dense') {                       // a figure with strokes everywhere
        return [0.62 * Math.sin(t * 6.283) + 0.26 * Math.sin(t * 43.98 + 1.1),
                0.62 * Math.sin(t * 12.566 + 0.4) + 0.26 * Math.sin(t * 31.4)];
      }
      if (t < 0.5) return [-0.6 + 1.2 * (t / 0.5), -0.5];        // a slow line
      return [-0.02 + 0.04 * ((t - 0.5) / 0.5), -0.5];           // ...then a creep
    };
  }, mode);
  const doseOf = () => page.evaluate(() => window.__scope.state.doseMax);
  const setCtl = (key, v) => page.evaluate(([k, val]) => {
    const el = document.querySelector(`[data-set="${k}"]`);
    el.value = String(val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, [key, v]);

  const isGL = (await page.evaluate(() => window.__scope.state.renderer)) === 'webgl2';

  const ctx = { page, nav, center, isGL, setSynth, doseOf, setCtl, realErrors };

  await blanking(ctx);
  await halo(ctx);
  await model(ctx);
  await axes(ctx);
  await profile(ctx);
  await audio(ctx);
  await surface(ctx);
  await theme(ctx);

  await browser.close();
}

module.exports = { renderTests };
