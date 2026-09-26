#!/usr/bin/env node
'use strict';

/* ============================================================================
    test/sections/render-audio.js — the two hard requirements, on live audio.

    No glow (shadowBlur and 'lighter' are never written), no closed path, a real
    file playing through the Web Audio graph, and the shipped defaults not
    blowing the picture out — measured on the busy passage of a real track, not
    on the synthetic one. Plus the pause regression: a paused <audio> feeds
    silence to the analysers, so the renderer has to keep painting its last
    captured window instead of erasing the screen.
   ========================================================================== */

const path = require('node:path');
const h = require('../harness.js');
const { ok, bad, SHOTS } = h;

async function audio(ctx) {
  const { page, nav } = ctx;

  /* ---- glow instrumentation ------------------------------------------- */
  const glow = await page.evaluate(() => window.__glow);
  if (glow.shadowBlur === 0 && glow.lighter === 0 && glow.filter === 0) {
    ok('NO GLOW: no shadowBlur, no additive blending', JSON.stringify(glow));
  } else bad('NO GLOW: no shadowBlur, no additive blending', JSON.stringify(glow));

  if (glow.closePathCalls === 0) ok('trace path is never closed', 'closePath calls: 0');
  else bad('trace path is never closed', `${glow.closePathCalls} closePath call(s)`);

  /* ---- real audio ------------------------------------------------------ */
  await page.evaluate(() => { window.__synthOn = false; });
  await page.goto(nav('?track=0'), { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const a = document.getElementById('audio');
    if (a.paused) document.getElementById('btnPlay').click();
  });
  await page.waitForTimeout(3500);

  const played = await page.evaluate(() => {
    const a = document.getElementById('audio');
    return { paused: a.paused, t: a.currentTime, dur: a.duration, err: a.error ? a.error.code : 0 };
  });
  if (!played.paused && played.t > 0.4) {
    ok('real audio plays through the Web Audio graph', `t=${played.t.toFixed(2)}s of ${played.dur.toFixed(1)}s`);
  } else bad('real audio plays through the Web Audio graph', JSON.stringify(played));

  const litPixels = () => page.evaluate(() => {
    const c = window.__scope.state.canvas;
    const d = window.__scope.readTrace(0, 0, c.w, c.h);
    let lit = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 24) lit++;
    return lit;
  });

  const live = await litPixels();
  if (live > 200) ok('live trace is drawn from the audio file', `${live} lit pixels`);
  else bad('live trace is drawn from the audio file', `${live} lit pixels`);

  /* ---- the picture must not depend on the listening level ----------------
     HTMLMediaElement.volume and .muted are applied BEFORE
     MediaElementAudioSourceNode, so anything that sets them for playback
     silences the analysis too. That is exactly what happened: 音量 0 blanked the
     scope, and a tab muted by the browser did the same with the transport still
     saying "playing". The audio path now uses a GainNode below the analysers and
     leaves the element at 1/unmuted, so both of these have to hold. */
  const rmsNow = () => page.evaluate(() => {
    const a = window.__scope.readAnalyser();
    const r = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
    return +Math.max(r(a.L), r(a.R)).toFixed(4);
  });
  const before0 = await rmsNow();
  await page.evaluate(() => {
    const el = document.getElementById('volume');
    el.value = '0';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(1600);
  const atZero = { rms: await rmsNow(), lit: await litPixels() };
  await page.evaluate(() => {
    const el = document.getElementById('volume');
    el.value = '0.85';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  if (before0 > 0.005 && atZero.rms > before0 * 0.4 && atZero.lit > 200) {
    ok('音量 0 does not silence the scope', `analyser ${before0} → ${atZero.rms}, ${atZero.lit} lit pixels`);
  } else {
    bad('音量 0 does not silence the scope', JSON.stringify({ before0, ...atZero }));
  }
  /* The other half: a muted element (which is what a browser tab mute does) is
     still silent, and the app has to say so rather than draw an empty screen.
     The watchdog counts 100 ms per 250 ms tick, so 1.2 s of silence is ~3 s of
     wall clock — poll for the notice instead of guessing. */
  await page.evaluate(() => { document.getElementById('audio').muted = true; });
  let notice = { text: '' };
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(250);
    notice = await page.evaluate(() => ({ text: document.getElementById('toast').textContent }));
    if (/没有信号/.test(notice.text)) break;
  }
  await page.evaluate(() => { document.getElementById('audio').muted = false; });
  if (/没有信号/.test(notice.text) && /静音/.test(notice.text)) {
    ok('a muted element is reported, not drawn as an empty screen', notice.text);
  } else {
    bad('a muted element is reported, not drawn as an empty screen', JSON.stringify(notice));
  }
  await page.waitForTimeout(900);

  await page.screenshot({ path: path.join(SHOTS, 'live-audio.png') });

  /* ---- the shipped defaults must not blow the picture out ---------------
     The old default (4096 window / 62 % afterglow) put 12.8 % of the lit ink
     at alpha 255 on this passage: the figure had dissolved into a solid mass.
     That number is what makes "no universal best" a measurement rather than an
     excuse, so pin it. The chip is clicked instead of writing the defaults
     into the test — a copy of DEFAULTS here is exactly how the last default
     change turned into a confusing failure. */
  await page.evaluate(() => {
    const b = document.querySelector('#presetChips .chip[data-preset="默认"]');
    if (b) b.click();
    document.getElementById('audio').currentTime = 20;      // the busy cube passage
  });
  await page.waitForTimeout(6000);
  const exposure = await page.evaluate(() => {
    const st = window.__scope.state;
    const c = window.__scope.state.canvas;
    const x = Math.round(st.plot.x);
    const y = Math.round(st.plot.y);
    const s = Math.round(st.plot.size);
    const d = window.__scope.readTrace(x, y, s, s);
    let lit = 0, blown = 0;
    for (let i = 3; i < d.length; i += 4) {
      if (d[i] > 8) { lit++; if (d[i] >= 250) blown++; }
    }
    return {
      lit,
      cover: +((lit / (s * s)) * 100).toFixed(2),
      blown: lit ? +((blown / lit) * 100).toFixed(2) : 0,
    };
  });
  /* The bound is 3 % rather than the 0.7 % this setting measures in isolation:
     the saturated share depends on the plot size (a smaller plot packs the same
     segments into fewer pixels and self-overlaps more), so it is not a pure
     function of the settings. 3 % still rejects the old default by 4x, which is
     the thing this check exists to catch. */
  if (exposure.lit > 500 && exposure.blown < 3) {
    ok('the default settings do not blow the picture out',
      `cover ${exposure.cover}%, ${exposure.blown}% of the ink at alpha 255`);
  } else {
    bad('the default settings do not blow the picture out',
      `cover ${exposure.cover}%, ${exposure.blown}% saturated — the old default measured 12.8%`);
  }

  /* ---- regression: a paused <audio> feeds the analysers silence, so the
     renderer must keep painting its last captured window instead of
     re-reading them (that bug blanked the screen on pause). -------------- */
  await page.evaluate(() => document.getElementById('audio').pause());
  await page.waitForTimeout(1000);
  const pausedInk = await litPixels();
  if (pausedInk > 200) ok('picture survives pause', `${pausedInk} lit pixels`);
  else bad('picture survives pause', `${pausedInk} lit pixels — paused renderer went blank`);

  await page.evaluate(() => document.querySelector('[data-toggle="grid"]').click());
  await page.waitForTimeout(1000);
  const toggledInk = await litPixels();
  if (toggledInk > 200) ok('picture survives a settings change while paused', `${toggledInk} lit pixels`);
  else bad('picture survives a settings change while paused', `${toggledInk} lit pixels`);
  await page.evaluate(() => document.querySelector('[data-toggle="grid"]').click());
}

module.exports = audio;
