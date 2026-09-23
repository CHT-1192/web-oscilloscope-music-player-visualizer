#!/usr/bin/env node
'use strict';

/* ============================================================================
    test/verify.js — end-to-end verification (the runner).

    Zero required dependencies. Every check lives in test/sections/, one file per
    failure mode, and this file only allocates a port, boots server.js and runs
    the sections in order. The render sections drive a real Chromium through
    Playwright (skipped with a notice when Playwright is unavailable).

    Screenshots land in test/shots/ for eyeballing.

      node test/verify.js
      node test/verify.js --only=render

   ========================================================================== */

const fs = require('node:fs');
const h = require('./harness.js');
const { state, SHOTS, pickPort, startServer, loadPlaywright } = h;

const { defaultPortTests, portRetryTest } = require('./sections/port.js');
const { httpTests } = require('./sections/http.js');
const { renderTests } = require('./sections/render.js');
const { webglAbsentTest } = require('./sections/render-webgl-absent.js');
const { presetTests } = require('./sections/presets.js');
const { resampleTests } = require('./sections/resample.js');
const { standaloneTests } = require('./sections/standalone.js');

const ONLY = (() => {
  const eq = process.argv.find((a) => a.startsWith('--only='));
  const i = process.argv.indexOf('--only');
  const raw = eq ? eq.slice('--only='.length) : (i >= 0 ? process.argv[i + 1] : '');
  return String(raw || '').trim().toLowerCase();
})();
const wants = (key) => !ONLY || key.includes(ONLY) || ONLY.includes(key);

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log(`\n\x1b[1m◉ oscilloscope music player — verification\x1b[0m  \x1b[2m(node ${process.version})\x1b[0m`);

  state.port = await pickPort();
  state.base = `http://127.0.0.1:${state.port}`;

  const server = await startServer();
  try {
    if (wants('port')) {
      defaultPortTests();
      await portRetryTest();
    }
    if (wants('http')) await httpTests();

    const browser = ['render', 'presets', 'resample', 'standalone'].filter(wants);
    const pw = browser.length ? loadPlaywright() : null;
    if (browser.length && !pw) {
      section('Render layer');
      console.log('  \x1b[33m•\x1b[0m Playwright not found — skipping browser checks.');
      console.log('    \x1b[2minstall with: npm i -g playwright\x1b[0m');
    } else if (pw) {
      if (wants('render')) {
        await renderTests(pw);
        await renderTests(pw, '?renderer=2d');
        await webglAbsentTest(pw);
      }
      if (wants('presets')) await presetTests(pw);
      if (wants('resample')) await resampleTests(pw);
      if (wants('standalone')) await standaloneTests(pw);
    }
  } finally {
    server.child.kill('SIGKILL');
  }

  console.log(`\n\x1b[1mresult\x1b[0m  \x1b[32m${state.pass} passed\x1b[0m` + (state.fail ? `, \x1b[31m${state.fail} failed\x1b[0m` : '')
    + (ONLY ? `  \x1b[33m(filtered: --only=${ONLY} — this is NOT a full-suite result)\x1b[0m` : ''));
  if (state.fail) {
    console.log('\n' + state.failures.map((f) => '  \x1b[31m✗\x1b[0m ' + f).join('\n'));
  }
  console.log(`  \x1b[2mscreenshots: ${require('node:path').relative(process.cwd(), SHOTS)}/\x1b[0m\n`);
  process.exit(state.fail ? 1 : 0);
})().catch((err) => {
  console.error('\n\x1b[31mverification crashed:\x1b[0m', err);
  process.exit(2);
});
