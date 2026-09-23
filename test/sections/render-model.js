#!/usr/bin/env node
'use strict';

/* ============================================================================
    test/sections/render-model.js — does the app say which model is drawing, and
    is the frame log a real instrument?

    The top bar badge, the frame log's tail statistics, the ⇧L shortcut and one
    ordinary keyboard shortcut. All four were wrong at least once (the badge did
    not exist, the log had no 1% low, the shortcuts were never bound), which is
    what makes them worth asserting rather than eyeballing.
   ========================================================================== */

const h = require('../harness.js');
const { ok, bad } = h;

async function model(ctx) {
  const { page } = ctx;

  /* The top bar states which model is drawing. It is the one place a user can
     see the difference between accumulated energy and a 10-rung alpha ladder, so
     it must not drift from state.renderer. */
  const badge = await page.evaluate(() => {
    const el = document.getElementById('modelBadge');
    return { text: el ? el.textContent : null, hidden: el ? el.hidden : null,
             warn: el ? el.classList.contains('is-warn') : null,
             renderer: window.__scope.state.renderer };
  });
  const wantBadge = badge.renderer === 'webgl2' ? '能量模型' : '8 位路径';
  if (badge.text === wantBadge && badge.hidden === false && badge.warn === (badge.renderer !== 'webgl2')) {
    ok('the top bar names the model that is drawing', `${badge.renderer} → ${badge.text}`);
  } else {
    bad('the top bar names the model that is drawing', JSON.stringify(badge));
  }

  /* ---- the frame log: the numbers, in text, without a profiler ---------- */
  const perf = await page.evaluate(() => {
    const text = window.__scope.perf();
    return { text, hasLow: /1% low/.test(text), hasWorst: /最差的几帧/.test(text),
             hasAudio: /音频上下文|音频时钟落后/.test(text),
             frames: /(\d+) 帧/.exec(text) ? Number(/(\d+) 帧/.exec(text)[1]) : 0 };
  });
  if (perf.hasLow && perf.hasWorst && perf.hasAudio && perf.frames > 200) {
    ok('the frame log reports the tail, not just the median',
      perf.text.split('\n')[1].trim().slice(0, 78));
  } else {
    bad('the frame log reports the tail',
      JSON.stringify({ frames: perf.frames, hasLow: perf.hasLow, hasAudio: perf.hasAudio }));
  }
  const logged = await page.evaluate(() => new Promise((res) => {
    const orig = console.log;
    console.log = (m) => { console.log = orig; res(String(m).slice(0, 24)); };
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'L', bubbles: true }));
    setTimeout(() => { console.log = orig; res(''); }, 800);
  }));
  if (/帧日志/.test(logged)) ok('⇧L logs the frame stats', logged);
  else bad('⇧L logs the frame stats', logged || '(nothing)');

  /* The shortcut table in the README was dead: onKey survived the module split
     and nothing bound it. Assert one shortcut that is observable without
     console spying, so the table cannot rot again. */
  const volBefore = await page.inputValue('#volume');
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })));
  await page.waitForTimeout(200);
  const volAfter = await page.inputValue('#volume');
  if (Number(volAfter) > Number(volBefore)) {
    ok('the keyboard shortcuts are bound', `音量 ${volBefore} → ${volAfter} on ArrowUp`);
  } else {
    bad('the keyboard shortcuts are bound', `${volBefore} → ${volAfter}`);
  }
}

module.exports = model;
