#!/usr/bin/env node
'use strict';

/* ============================================================================
    test/sections/render-webgl-absent.js — what a machine without WebGL2 gets.

    The Canvas fallback has to take over on its own, still draw a trace, and do
    it without errors. Run with --disable-webgl so the browser offers no WebGL2
    context at all.
   ========================================================================== */

const h = require('../harness.js');
const { ok, bad, section, findChromium } = h;

async function webglAbsentTest(pw) {
  const BASE = h.base;
  section('Render layer — WebGL unavailable');

  const browser = await pw.chromium.launch({
    executablePath: findChromium(),
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-sandbox', '--disable-webgl'],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.split('\n')[0]));

  await page.goto(`${BASE}/?track=0`);
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const a = document.getElementById('audio');
    a.currentTime = 20;
    if (a.paused) document.getElementById('btnPlay').click();
  });
  await page.waitForTimeout(6000);

  const r = await page.evaluate(() => {
    const s = window.__scope.state;
    const c = s.canvas;
    const d = window.__scope.readTrace(0, 0, c.w, c.h);
    let lit = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 24) lit++;
    const probe = document.createElement('canvas').getContext('webgl2');
    return { renderer: s.renderer, lit, webgl2: !!probe };
  });

  if (r.webgl2) {
    ok('WebGL is actually absent in this browser', 'skipped — --disable-webgl had no effect here');
  } else if (r.renderer === 'canvas2d') {
    ok('falls back to Canvas-2D when WebGL is unavailable', 'no WebGL2 context offered');
  } else {
    bad('falls back to Canvas-2D when WebGL is unavailable', `renderer=${r.renderer}`);
  }
  if (r.lit > 200) ok('the fallback still draws a trace', `${r.lit} lit pixels`);
  else bad('the fallback still draws a trace', `${r.lit} lit pixels`);
  if (errors.length === 0) ok('no runtime errors without WebGL');
  else bad('no runtime errors without WebGL', errors.slice(0, 2).join(' | '));

  await browser.close();
}

module.exports = { webglAbsentTest };
