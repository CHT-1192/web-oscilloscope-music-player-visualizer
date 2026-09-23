#!/usr/bin/env node
'use strict';

/* ============================================================================
    test/sections/standalone.js — the single-file edition, opened from disk.

    No external CSS/JS requests, boots from file:// with no errors, falls back to
    the file picker because it cannot scan a directory, and measures a picked
    file at its own sample rate. This is the edition that has no server behind
    it, so it is the one that breaks differently.
   ========================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execSync } = require('node:child_process');
const h = require('../harness.js');
const { ok, bad, section, SHOTS, findChromium, ROOT } = h;

async function standaloneTests(pw) {
  section('Single-file edition (opened from disk)');

  const file = path.join(ROOT, 'oscilloscope-standalone.html');
  // whatever audio happens to be in the project root
  const sample = fs.readdirSync(ROOT).find((f) => /\.(wav|flac|mp3|m4a|ogg|opus|aif+|caf)$/i.test(f));
  const browser = await pw.chromium.launch({
    executablePath: findChromium(),
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });

  const external = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/\.(css|js|woff2?)($|\?)/i.test(u)) external.push(u);
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('file://' + file);
  await page.waitForTimeout(900);

  if (external.length === 0) ok('no external CSS/JS requests — truly self-contained');
  else bad('no external CSS/JS requests — truly self-contained', external.join(', '));

  if (errors.length === 0) ok('boots from file:// with no errors');
  else bad('boots from file:// with no errors', errors.join(' | '));

  const hintShown = await page.evaluate(() => !document.getElementById('dropHint').classList.contains('hidden'));
  if (hintShown) ok('shows the file-picker hint when it cannot scan a directory');
  else bad('shows the file-picker hint when it cannot scan a directory');

  const backdrop = await page.evaluate(() => {
    const c = document.getElementById('bg');
    return c.width > 0 && c.height > 0;
  });
  if (backdrop) ok('graticule canvas is live');
  else bad('graticule canvas is live');

  // load audio through the real <input type=file> path
  await page.evaluate(() => { document.getElementById('fileInput').hidden = false; });
  await page.setInputFiles('#fileInput', path.join(ROOT, sample));
  await page.waitForTimeout(3200);

  const state = await page.evaluate(() => {
    const a = document.getElementById('audio');
    const c = window.__scope.state.canvas;
    const d = window.__scope.readTrace(0, 0, c.w, c.h);
    let lit = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 24) lit++;
    return { src: /^blob:/.test(a.src || ''), paused: a.paused, t: a.currentTime, lit };
  });

  if (state.src && !state.paused && state.t > 0.4) ok('picked file plays from a blob URL', `t=${state.t.toFixed(2)}s`);
  else bad('picked file plays from a blob URL', JSON.stringify(state));

  if (state.lit > 200) ok('trace renders in the single-file edition', `${state.lit} lit pixels`);
  else bad('trace renders in the single-file edition', `${state.lit} lit pixels`);

  /* Presets are shared code, but file:// is a different storage neighbourhood:
     localStorage can be blocked outright there. Saving must still work for the
     session, and must not take the page down with it. */
  const presetOnFile = await page.evaluate(() => {
    const out = { chips: 0, saved: false, usable: false, threw: false };
    try {
      out.chips = document.querySelectorAll('#presetChips .chip').length;
      const b = document.querySelector('#presetChips .chip[data-preset="描边"]');
      b.click();
      document.getElementById('btnPresetSave').click();
      document.getElementById('presetName').value = '本地';
      document.getElementById('btnPresetCommit').click();
      out.usable = document.querySelector('[data-set="windowIdx"]').value === '1';
      out.saved = !!document.querySelector('#presetChips .chip[data-preset="本地"]');
    } catch (e) { out.threw = true; }
    return out;
  });
  if (presetOnFile.chips === 3 && presetOnFile.usable && presetOnFile.saved && !presetOnFile.threw) {
    ok('presets work in the single-file edition too', '3 built-ins + 1 saved');
  } else {
    bad('presets work in the single-file edition too', JSON.stringify(presetOnFile));
  }

  /* The local-file probe in playlist.js shares no code with the server's parser,
     and only runs for a dragged-in or picked file. Both of the awkward cases
     are here: ALAC's rate hides in a 36-byte codec box (the generic sample entry
     cannot express >65535 Hz), and AIFF's is an 80-bit IEEE extended float.
     Neither file may even be decodable by this browser — the RATE still has to
     be read, because that is what decides whether the analysis path resamples. */
  const LOCAL_PROBES = [
    { label: 'ALAC', ext: 'm4a', codec: 'alac', expect: 'ALAC' },
    { label: 'AIFF', ext: 'aiff', codec: 'pcm_s16be', expect: 'AIFF' },
  ];
  for (const f of LOCAL_PROBES) {
    const file = path.join(os.tmpdir(), `scope-probe.${f.ext}`);
    let made = false;
    try {
      execSync('ffmpeg -v error -y -f lavfi -i "sine=frequency=440:duration=1:sample_rate=44100" '
        + `-ac 2 -c:a ${f.codec} "${file}"`, { stdio: 'ignore' });
      made = true;
    } catch { /* encoder missing in this build */ }

    if (!made) { ok(`a picked ${f.label} file is measured at its own rate`, 'skipped — no ffmpeg encoder'); continue; }
    await page.setInputFiles('#fileInput', file);
    await page.waitForTimeout(2500);
    const probe = await page.evaluate(() => {
      const s = window.__scope.state;
      return {
        rate: s.sourceRate,
        engine: s.engineRate,
        meta: (document.querySelector('.track.active .meta') || {}).textContent || '',
      };
    });
    if (probe.rate === 44100 && probe.engine === 44100 && probe.meta.includes(f.expect)) {
      ok(`a picked ${f.label} file is measured at its own rate`, `${probe.rate} Hz · ${probe.meta.trim()}`);
    } else {
      bad(`a picked ${f.label} file is measured at its own rate`, JSON.stringify(probe));
    }
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  }

  await page.screenshot({ path: path.join(SHOTS, 'standalone-file-protocol.png') });
  await browser.close();
}

module.exports = { standaloneTests };
