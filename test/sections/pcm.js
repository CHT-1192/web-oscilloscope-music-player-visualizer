#!/usr/bin/env node
'use strict';

/* ============================================================================
    test/sections/pcm.js — where the samples come from.

    The element tap cannot be read before the element's effective volume is
    applied (Web Audio 1.22; Gecko does it in the node's own input track), so
    音量 0, element .muted and a browser tab mute all silence the analysis. The
    默认-on 原始样本 path decodes the file itself instead. What has to hold:

      1. it is on by default, and it is the source in use on a decodable file;
      2. the samples are the FILE's, checked against an independent ffmpeg decode;
      3. a muted element no longer blanks the scope while it is in use — and still
         does once the switch is off, which is what proves the check measures
         something;
      4. a file too big to decode falls back instead of pretending, and the size
         caps are reported rather than silently ignored;
      5. the read position tracks the audio clock: forwards, plausible steps,
         never jumping (the figure would strobe if it did).
   ========================================================================== */

const path = require('node:path');
const { execSync } = require('node:child_process');
const h = require('../harness.js');
const { ok, bad, section, SHOTS, findChromium, ROOT } = h;

/** The element tap is what the scope used to read: post-volume, so a mute takes
    the picture with it. */
const analyserRms = (page) => page.evaluate(() => {
  const a = window.__scope.readAnalyser();
  const r = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
  return +Math.max(r(a.L), r(a.R)).toFixed(5);
});
/** What the renderer was actually handed this frame. */
const signalRms = (page) => page.evaluate(() => {
  const f = window.__scope.readSignal();
  const r = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
  return +Math.max(r(f.L), r(f.R)).toFixed(5);
});
const litPixels = (page) => page.evaluate(() => {
  const c = window.__scope.state.canvas;
  const d = window.__scope.readTrace(0, 0, c.w, c.h);
  let lit = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 24) lit++;
  return lit;
});
const pcmState = (page) => page.evaluate(() => window.__scope.state.pcm);
const setSwitch = (page, on) => page.evaluate((want) => {
  const b = document.querySelector('[data-toggle="pcm"]');
  const now = b.getAttribute('aria-pressed') === 'true';
  if (now !== want) b.click();
  return document.querySelector('[data-toggle="pcm"]').getAttribute('aria-pressed');
}, on);

async function pcmTests(pw) {
  const BASE = h.base;
  section('Analysis source / the file\'s own samples');

  const browser = await pw.chromium.launch({
    executablePath: findChromium(),
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  /* ---- 1. on by default, and in use ------------------------------------- */
  await page.goto(`${BASE}/?track=0`, { waitUntil: 'load' });
  await page.waitForTimeout(900);
  let p = await pcmState(page);
  if (p.enabled) ok('the switch is on by default');
  else bad('the switch is on by default', JSON.stringify(p));

  /* The decode is asynchronous: until it lands the element tap keeps painting,
     which is the point of it being asynchronous. Poll rather than sleep. */
  for (let i = 0; i < 40 && !p.active; i++) { await page.waitForTimeout(250); p = await pcmState(page); }
  if (p.active) ok('the file decodes at its own rate', `${p.rate} Hz · ${p.frames} frames · ${(p.bytes / 1048576).toFixed(1)} MB held`);
  else bad('the file decodes at its own rate', JSON.stringify(p));

  const st = await page.evaluate(() => window.__scope.state);
  if (p.rate === st.sourceRate && p.usable) {
    ok('the analysis reads them, un-resampled', `source ${st.sourceRate} Hz, engine ${st.engineRate} Hz`);
  } else {
    bad('the analysis reads them, un-resampled', JSON.stringify({ p, source: st.sourceRate, engine: st.engineRate }));
  }

  /* ---- 2. are they the file's samples? --------------------------------- */
  const FF = (() => {
    try { execSync('command -v ffmpeg', { stdio: 'ignore' }); return true; } catch { return false; }
  })();
  if (!FF) {
    console.log('  \x1b[33m•\x1b[0m ffmpeg not found — skipping the independent decode comparison.');
  } else {
    /* A second in, on a loud passage, away from the digital silence at the head. */
    const OFF = 44100, N = 8192;
    const got = await page.evaluate(([off, n]) => window.__scope.pcmSlice(off, n), [OFF, N]);
    const file = path.join(ROOT, 'oscillofun.flac');
    const raw = execSync(`ffmpeg -v error -i "${file}" -f f32le -acodec pcm_f32le -`, { maxBuffer: 1 << 30 });
    let max = 0, at = -1;
    for (let i = 0; i < got.L.length; i++) {
      const d = Math.abs(raw.readFloatLE((OFF + i) * 8) - got.L[i]);   // interleaved L,R
      if (d > max) { max = d; at = i; }
    }
    /* One 16-bit LSB is 3.05e-5. Measured: 0 for 24/32-bit PCM, 0.73 LSB for
       16-bit — most of it the int->float scale (32767 in Chromium, 32768 in
       ffmpeg). The bound is stated as a bound on purpose: this is not exact. */
    const lsb = 1 / 32768;
    if (max <= 1.5 * lsb) {
      ok('the samples are the file\'s own', `${N} frames at ${OFF}: max|diff| ${max.toExponential(2)} = ${(max / lsb).toFixed(2)} LSB of 16-bit`);
    } else {
      bad('the samples are the file\'s own', `max|diff| ${max} at ${at} (${(max / lsb).toFixed(2)} LSB)`);
    }
  }

  /* ---- 3. a muted element no longer blanks the scope -------------------- */
  await page.evaluate(() => { const a = document.getElementById('audio'); if (a.paused) document.getElementById('btnPlay').click(); });
  await page.waitForTimeout(3000);
  const before = { sig: await signalRms(page), lit: await litPixels(page) };

  await page.evaluate(() => { document.getElementById('audio').muted = true; });
  await page.waitForTimeout(1600);
  const mutedOn = { sig: await signalRms(page), an: await analyserRms(page), lit: await litPixels(page) };
  if (mutedOn.an < 0.002 && mutedOn.sig > 0.01 && mutedOn.lit > 200) {
    ok('a muted element does not silence the picture',
      `element tap ${mutedOn.an} (silenced) · analysis ${mutedOn.sig} · ${mutedOn.lit} lit pixels`);
  } else {
    bad('a muted element does not silence the picture', JSON.stringify({ before, mutedOn }));
  }

  /* The other half: with the switch off the element tap IS the source, so the
     same mute must take the picture with it. Without this, the check above
     could pass by measuring nothing. */
  const pressed = await setSwitch(page, false);
  await page.waitForTimeout(1600);
  const mutedOff = { sig: await signalRms(page), lit: await litPixels(page) };
  if (pressed === 'false' && mutedOff.sig < 0.002 && mutedOff.lit < mutedOn.lit / 2) {
    ok('switched off, the same mute does blank it', `analysis ${mutedOff.sig} · ${mutedOff.lit} lit pixels (was ${mutedOn.lit})`);
  } else {
    bad('switched off, the same mute does blank it', JSON.stringify({ pressed, mutedOff, mutedOn }));
  }

  await setSwitch(page, true);
  await page.evaluate(() => { document.getElementById('audio').muted = false; });
  await page.waitForTimeout(1200);
  const back = { sig: await signalRms(page), lit: await litPixels(page) };
  if (back.sig > 0.01 && back.lit > 200) ok('switching back on restores it', `${back.sig} · ${back.lit} lit pixels`);
  else bad('switching back on restores it', JSON.stringify(back));

  /* ---- 4. the read position follows the audio clock --------------------- */
  const track = await page.evaluate(async () => {
    const s = [];
    await new Promise((res) => {
      const t0 = performance.now();
      const tick = () => {
        s.push(window.__scope.state.pcm.pos);
        if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else res();
      };
      requestAnimationFrame(tick);
    });
    return { s, rate: window.__scope.state.pcm.rate, clock: window.__scope.state.engineRate };
  });
  const steps = [];
  for (let i = 1; i < track.s.length; i++) steps.push(track.s[i] - track.s[i - 1]);
  const back2 = steps.filter((d) => d < 0).length;
  const zero = steps.filter((d) => d === 0).length;
  const expect = track.rate * 0.0167;           // one frame at 60 Hz
  const wild = steps.filter((d) => d > expect * 3).length;
  if (track.s.length > 30 && back2 === 0 && wild === 0) {
    ok('the read position advances with the audio clock',
      `${track.s.length} frames, step ${steps[0]}–${Math.max(...steps)} samples (expected ~${Math.round(expect)}), 0 backwards, ${zero} still`);
  } else {
    bad('the read position advances with the audio clock',
      `${track.s.length} frames, ${back2} backwards, ${wild} wild (>${Math.round(expect * 3)}), ${zero} still`);
  }

  /* ---- 5. a file too big to decode says so and still plays -------------- */
  await page.goto(`${BASE}/?track=1`, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  p = await pcmState(page);
  /* The refusal has to be the cap that the file actually exceeds — a message
     that names a limit it does not cross is a control lying about itself. */
  const api = JSON.parse((await h.get(`${BASE}/api/tracks`)).body.toString());
  const big = (api.tracks || []).find((t) => t.name === 'primer-final.flac') || {};
  if (p.enabled && !p.active && p.reason && big.size > p.limits.file) {
    ok('a file over the memory cap falls back, and says which cap',
      `${(big.size / 1048576).toFixed(0)} MB > 上限 ${(p.limits.file / 1048576).toFixed(0)} MB · ${p.reason}`);
  } else {
    bad('a file over the memory cap falls back, and says which cap', JSON.stringify({ p, size: big.size }));
  }
  const note = await page.evaluate(() => document.getElementById('pcmNote').textContent);
  if (/元素采样/.test(note)) ok('the status line names the source in use', note.trim());
  else bad('the status line names the source in use', note.trim());

  /* The head of this file is digital silence, so land on a loud passage before
     judging whether anything was drawn. */
  await page.evaluate(() => {
    const a = document.getElementById('audio');
    a.currentTime = 10;
    if (a.paused) document.getElementById('btnPlay').click();
  });
  await page.waitForTimeout(3200);
  const fell = { sig: await signalRms(page), lit: await litPixels(page) };
  if (fell.sig > 0.01 && fell.lit > 200) ok('the fallback still draws the file', `${fell.sig} · ${fell.lit} lit pixels`);
  else bad('the fallback still draws the file', JSON.stringify(fell));

  if (errors.length === 0) ok('no errors while switching the analysis source');
  else bad('no errors while switching the analysis source', errors.slice(0, 2).join(' | '));

  /* The built-in generator is the source in demo mode, so the line must not name
     either sample path there: it would be describing audio that is not playing.
     ?demo=1 alone (with ?track= the track wins, by design) still loads a track in
     the background first, so a decode is genuinely in flight when the demo takes
     over — which is the case that would otherwise read 未就绪. */
  await page.goto(`${BASE}/?demo=1`, { waitUntil: 'load' });
  await page.waitForTimeout(1800);
  const demo = await page.evaluate(() => ({
    source: window.__scope.state.source,
    note: document.getElementById('pcmNote').textContent,
  }));
  if (demo.source === 'demo' && demo.note === '') {
    ok('the status line is silent while the demo signal is playing', 'source demo, note empty');
  } else {
    bad('the status line is silent while the demo signal is playing', JSON.stringify(demo));
  }

  await page.screenshot({ path: path.join(SHOTS, 'pcm-source.png') });
  await browser.close();
}

module.exports = { pcmTests };
