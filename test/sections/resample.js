#!/usr/bin/env node
'use strict';

/* ============================================================================
    test/sections/resample.js — the premise: the analysis path must not resample.

    The engine is forced to the file's own rate, and the proof is spectral: a
    192 kHz file carries content above 30 kHz, which cannot exist at all once the
    engine is moved to 48 kHz. The control run proves the band is really gone, so
    the first check cannot pass by measuring nothing.
   ========================================================================== */

const path = require('node:path');
const h = require('../harness.js');
const { ok, bad, section, SHOTS, findChromium } = h;

function fftInPlace(re, im) {
  const N = re.length;
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j], ui = im[i + j];
        const xr = re[i + j + len / 2], xi = im[i + j + len / 2];
        const vr = xr * cr - xi * ci, vi = xr * ci + xi * cr;
        re[i + j] = ur + vr; im[i + j] = ui + vi;
        re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

function bandBins(samples, lo, hi, rate) {
  const N = 16384;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));   // Hann
    re[i] = samples[i] * w;
  }
  fftInPlace(re, im);
  const bh = rate / N;
  let e = 0, n = 0;
  const kHi = Math.min(N / 2 - 1, Math.floor(hi / bh));
  for (let k = Math.ceil(lo / bh); k <= kHi; k++) { e += re[k] * re[k] + im[k] * im[k]; n++; }
  return n === 0 ? { psd: 0, bins: 0 } : { psd: e / n, bins: n };   // per-bin => PSD
}

/** Band power spectral density in dB relative to the 1–10 kHz band.
    PSD (not total band energy) so a wide band isn't flattered by bin count. */
function bandDb(samples, lo, hi, rate) {
  const b = bandBins(samples, lo, hi, rate);
  if (b.bins === 0 || b.psd === 0) return { db: -Infinity, bins: b.bins };
  const ref = bandBins(samples, 1000, 10000, rate);
  return { db: 10 * Math.log10(b.psd / ref.psd), bins: b.bins };
}

const rms = (x) => {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
};

async function resampleTests(pw) {
  const BASE = h.base;
  section('Sample rate / no resampling');

  const browser = await pw.chromium.launch({
    executablePath: findChromium(),
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const state = () => page.evaluate(() => window.__scope.state);
  const capture = () => page.evaluate(() => window.__scope.readAnalyser());

  /* The first ~3 s of this FLAC are digital silence, so always land on a solidly
     loud passage — otherwise a band measurement just reads the noise floor. */
  const playAt = async (url, seekTo) => {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(800);
    await page.evaluate((t) => {
      const a = document.getElementById('audio');
      if (t != null) { a.currentTime = t; }
      if (a.paused) document.getElementById('btnPlay').click();
    }, seekTo == null ? null : seekTo);
    await page.waitForTimeout(2800);
  };

  /* ---- 192 kHz FLAC: the engine must follow the file ---- */
  await playAt(`${BASE}/?track=1`, 10);
  let st = await state();
  if (st.sourceRate === 192000) ok('FLAC native rate detected', '192000 Hz');
  else bad('FLAC native rate detected', JSON.stringify(st));

  if (st.engineRate === 192000) ok('engine ran at the file rate (no resampling)', '192000 Hz');
  else bad('engine ran at the file rate (no resampling)', `engine ${st.engineRate} vs source ${st.sourceRate}`);

  const badge = await page.evaluate(() => document.getElementById('rateBadge').textContent);
  if (/原生/.test(badge)) ok('UI reports "native"', badge.trim());
  else bad('UI reports "native"', badge.trim());

  let cap = await capture();
  const level = rms(cap.L);
  if (level > 0.01) ok('captured a real signal (not silence)', `rms ${(20 * Math.log10(level)).toFixed(1)} dBFS`);
  else bad('captured a real signal (not silence)', `rms ${(20 * Math.log10(level)).toFixed(1)} dBFS — cannot judge the band`);

  const ultraNative = bandDb(cap.L, 30000, 88000, 192000);
  if (ultraNative.db > -60) {
    ok('ultrasonic content (>30 kHz) reaches the analyser intact',
      `30–88 kHz vs 1–10 kHz: ${ultraNative.db.toFixed(1)} dB PSD (${ultraNative.bins} bins)`);
  } else {
    bad('ultrasonic content (>30 kHz) reaches the analyser intact', JSON.stringify(ultraNative));
  }

  /* ---- control: force the device rate; Nyquist now cuts that band off ---- */
  await page.evaluate(() => window.__scope.setRateMode('device'));
  await page.waitForTimeout(3000);
  st = await state();
  if (st.engineRate === 48000) ok('forcing "device" moves the engine to 48 kHz');
  else bad('forcing "device" moves the engine to 48 kHz', `${st.engineRate} Hz`);

  cap = await capture();
  const ultraDevice = bandDb(cap.L, 30000, 88000, 48000);
  if (ultraDevice.bins === 0 || ultraDevice.db === -Infinity) {
    ok('control: at 48 kHz that band cannot exist at all', 'beyond Nyquist — zero bins');
  } else if (ultraDevice.db < ultraNative.db - 30) {
    ok('control: at 48 kHz that content is gone',
      `${ultraDevice.db.toFixed(1)} dB vs ${ultraNative.db.toFixed(1)} dB`);
  } else {
    bad('control: at 48 kHz that content is gone', `${ultraDevice.db} dB vs ${ultraNative.db} dB`);
  }

  const badge2 = await page.evaluate(() => document.getElementById('rateBadge').textContent);
  if (/重采样/.test(badge2)) ok('UI warns about resampling', badge2.trim());
  else bad('UI warns about resampling', badge2.trim());

  /* ---- the 44.1 kHz file: the engine must follow that one too ---- */
  await playAt(`${BASE}/?track=0`, 10);
  st = await state();
  if (st.sourceRate === 44100 && st.engineRate === 44100) {
    ok('engine follows the 44.1 kHz file', `${st.engineRate} Hz`);
  } else {
    bad('engine follows the 44.1 kHz file', JSON.stringify(st));
  }
  cap = await capture();
  if (rms(cap.L) > 0.01) ok('44.1 kHz analyser carries real signal', `rms ${(20 * Math.log10(rms(cap.L))).toFixed(1)} dBFS`);
  else bad('44.1 kHz analyser carries real signal', `${rms(cap.L)}`);

  if (errors.length === 0) ok('no errors while switching sample rates');
  else bad('no errors while switching sample rates', errors.slice(0, 2).join(' | '));

  await page.screenshot({ path: path.join(SHOTS, 'native-rate.png') });
  await browser.close();
}

module.exports = { resampleTests };
