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

  /* Whose keyboard is it when something has focus? A slider keeps focus after
     you drag it, and the guard used to treat any `input` as a text field, so
     after touching 音量 or the seek bar EVERY shortcut was swallowed — space did
     nothing until you clicked elsewhere. A reported bug, so it gets checks. */
  const paused = () => page.evaluate(() => document.getElementById('audio').paused);
  const leaveDemo = () => page.evaluate(() => {
    if (window.__scope.state.source === 'demo') document.getElementById('btnDemo').click();
    document.getElementById('audio').pause();
    document.getElementById('volume').focus();
  });
  const backToDemo = () => page.evaluate(() => {
    if (window.__scope.state.source === 'media') document.getElementById('btnDemo').click();
  });

  await leaveDemo();
  await page.waitForTimeout(300);
  const v0 = Number(await page.inputValue('#volume'));
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(250);
  const v1 = Number(await page.inputValue('#volume'));
  if (Math.abs(v1 - v0 - 0.05) < 1e-6) {
    ok('a focused slider no longer swallows the keys', `音量 ${v0} → ${v1} on ArrowUp with 音量 focused`);
  } else {
    bad('a focused slider no longer swallows the keys', `音量 ${v0} → ${v1} (wanted +0.05)`);
  }

  const wasPaused = await paused();
  await page.keyboard.press(' ');
  await page.waitForTimeout(500);
  const nowPaused = await paused();
  await page.keyboard.press(' ');                       // put the transport back
  await page.waitForTimeout(400);
  if (wasPaused === true && nowPaused === false) {
    ok('space plays with a transport slider focused', '音量 focused → playing');
  } else {
    bad('space plays with a transport slider focused', `paused ${wasPaused} → ${nowPaused}`);
  }

  /* Text entry keeps the keyboard: the playlist filter is typed in, and a space
     there is a space. */
  await page.evaluate(() => { if (!document.getElementById('panelList').classList.contains('open')) document.getElementById('btnList').click(); });
  await page.evaluate(() => { const el = document.getElementById('trackFilter'); el.value = ''; el.focus(); });
  await page.waitForTimeout(250);
  const pausedBeforeType = await paused();
  await page.keyboard.type('a b');
  await page.waitForTimeout(300);
  const typed = await page.evaluate(() => document.getElementById('trackFilter').value);
  if (typed === 'a b' && (await paused()) === pausedBeforeType) {
    ok('a space while typing stays a space', `filter "${typed}", transport untouched`);
  } else {
    bad('a space while typing stays a space', `filter "${typed}", paused ${pausedBeforeType} → ${await paused()}`);
  }
  await page.evaluate(() => {
    const el = document.getElementById('trackFilter');
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.blur();
    if (document.getElementById('panelList').classList.contains('open')) document.getElementById('btnList').click();
  });
  await backToDemo();
  await page.waitForTimeout(300);

  /* A composing IME owns the keyboard — for a Pinyin user that space commits a
     candidate — while an IME that is merely ENABLED reports the space as
     'Process' and it is still a space. */
  const strike = async (label, init, want) => {
    await leaveDemo();
    await page.waitForTimeout(250);
    const before = await paused();
    await page.evaluate((i) => {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, i)));
    }, init);
    await page.waitForTimeout(400);
    const after = await paused();
    if (before !== after) await page.evaluate(() => document.getElementById('audio').pause());
    await backToDemo();
    if ((before !== after) === want) ok(label, `paused ${before} → ${after}`);
    else bad(label, `paused ${before} → ${after}, wanted ${want ? 'a toggle' : 'none'}`);
  };
  await strike('space with an enabled IME still plays', { key: 'Process', code: 'Space' }, true);
  await strike('a composing space is left to the IME', { key: ' ', code: 'Space', isComposing: true }, false);
  await strike('keyCode 229 is left to the IME', { key: ' ', code: 'Space', keyCode: 229 }, false);
}

module.exports = model;
