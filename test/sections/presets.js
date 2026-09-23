#!/usr/bin/env node
'use strict';

/* ============================================================================
    test/sections/presets.js — presets and per-track memory.

    The built-in recipes, the custom ones, export/import (including a hostile
    import that must be clamped to what the controls can express), the two modes,
    and the rule that a preset never carries the machine's own settings with it.
   ========================================================================== */

const path = require('node:path');
const h = require('../harness.js');
const { ok, bad, section, SHOTS, findChromium } = h;

async function presetTests(pw) {
  const BASE = h.base;
  section('Presets');

  const browser = await pw.chromium.launch({
    executablePath: findChromium(),
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const openPanel = () => page.evaluate(() => {
    if (!document.getElementById('panelSettings').classList.contains('open')) {
      document.getElementById('btnSettings').click();
    }
  });
  const chips = () => page.evaluate(() => [...document.querySelectorAll('#presetChips .chip')]
    .map((c) => c.dataset.preset + (c.classList.contains('active') ? '*' : '')));
  const clickChip = (name) => page.evaluate((n) => {
    const b = document.querySelector(`#presetChips .chip[data-preset="${n}"]`);
    if (b) b.click();
    return !!b;
  }, name);
  const status = () => page.evaluate(() => document.getElementById('presetStatus').textContent);
  const ctl = (k) => page.evaluate((key) => document.querySelector(`[data-set="${key}"]`).value, k);
  const out = (k) => page.evaluate((key) => {
    const el = document.querySelector(`[data-out="${key}"]`);
    return el ? el.textContent : null;
  }, k);
  const setCtl = (k, v) => page.evaluate((c) => {
    const el = document.querySelector(`[data-set="${c.k}"]`);
    el.value = String(c.v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, { k, v });
  const stored = () => page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('scope.presets.v1') || 'null'); } catch (e) { return null; }
  });
  const mode = () => page.evaluate(() => [...document.querySelectorAll('#presetMode button')]
    .filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.dataset.mode)[0] || null);

  await page.goto(`${BASE}/?track=0`);
  await page.waitForTimeout(900);
  await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* blocked */ } });
  await page.reload();
  await page.waitForTimeout(1300);
  await openPanel();
  await page.waitForTimeout(200);

  const names = await chips();
  if (['默认', '描边', '填充'].every((n) => names.includes(n))) ok('built-in presets are offered', names.join(' '));
  else bad('built-in presets are offered', names.join(' '));

  if (await mode() === 'auto') ok('presets default to per-track memory', 'auto');
  else bad('presets default to per-track memory', String(await mode()));

  /* ---- applying one must drive the CONTROLS, not just the numbers -------- */
  await clickChip('描边');
  await page.waitForTimeout(500);
  const stroke = {
    winIdx: await ctl('windowIdx'),
    size: await page.evaluate(() => window.__scope.state.windowSize),
    pers: await out('persistence'),
    chip: (await chips()).find((c) => c.endsWith('*')),
  };
  if (stroke.winIdx === '1' && stroke.size === 1024 && stroke.pers === '16 %' && stroke.chip === '描边*') {
    ok('applying a preset moves the controls and the analyser', `窗口 ${stroke.size} · 余辉 ${stroke.pers}`);
  } else {
    bad('applying a preset moves the controls and the analyser', JSON.stringify(stroke));
  }

  /* ---- a preset must not carry machine settings to another machine ------
     Exported presets get shared. rateMode and renderScale describe the host,
     so a preset that flipped them could send someone's engine to 192 kHz. */
  await page.evaluate(() => {
    const rm = document.getElementById('rateMode');
    rm.value = '48000';
    rm.dispatchEvent(new Event('change', { bubbles: true }));
    const rs = document.getElementById('renderScale');
    rs.value = '0.75';
    rs.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(400);
  await clickChip('填充');
  await page.waitForTimeout(500);
  const kept = await page.evaluate(() => {
    const s = window.__scope.state;
    return { rateMode: s.rateMode, renderScale: s.renderScale, engineRate: s.engineRate };
  });
  if (kept.rateMode === '48000' && kept.renderScale === '0.75' && kept.engineRate === 48000) {
    ok('a preset leaves device settings alone', `rateMode ${kept.rateMode}, renderScale ${kept.renderScale}`);
  } else {
    bad('a preset leaves device settings alone', JSON.stringify(kept));
  }
  await page.evaluate(() => document.getElementById('btnReset').click());
  await page.waitForTimeout(500);
  await openPanel();

  /* ---- tweaking leaves the preset ---------------------------------------- */
  await clickChip('描边');
  await page.waitForTimeout(400);
  await setCtl('lineWidth', 2.75);
  await page.waitForTimeout(300);
  const tweaked = { chips: await chips(), status: await status() };
  if (!tweaked.chips.some((c) => c.endsWith('*')) && /已微调/.test(tweaked.status)) {
    ok('a tweak stops the chip claiming to be active', tweaked.status);
  } else {
    bad('a tweak stops the chip claiming to be active', JSON.stringify(tweaked));
  }

  /* ---- save / reload / apply --------------------------------------------- */
  await page.evaluate(() => document.getElementById('btnPresetSave').click());
  await page.fill('#presetName', '我的描边');
  await page.click('#btnPresetCommit');
  await page.waitForTimeout(700);
  const saved = { chips: await chips(), disk: await stored() };
  const onDisk = saved.disk && (saved.disk.custom || []).find((p) => p.name === '我的描边');
  if (saved.chips.includes('我的描边*') && onDisk && onDisk.settings.lineWidth === 2.75) {
    ok('a custom preset is saved with the current settings', `lineWidth ${onDisk.settings.lineWidth}`);
  } else {
    bad('a custom preset is saved with the current settings', JSON.stringify(saved.chips));
  }

  await page.reload();
  await page.waitForTimeout(1300);
  await openPanel();
  await page.waitForTimeout(200);
  const afterReload = await chips();
  await clickChip('默认');
  await page.waitForTimeout(400);
  const defaulted = await out('lineWidth');
  await clickChip('我的描边');
  await page.waitForTimeout(400);
  const restored = await out('lineWidth');
  /* Compare against whatever the app's own default is, rather than a number
     copied out of DEFAULTS — that copy silently stopped being true the moment
     the defaults moved, and the failure looked like a preset bug. */
  if (afterReload.some((c) => c.startsWith('我的描边')) && defaulted !== '2.75 px' && restored === '2.75 px') {
    ok('a custom preset survives a reload and restores exactly', `${defaulted} → ${restored}`);
  } else {
    bad('a custom preset survives a reload and restores exactly', `${afterReload.join(' ')} | ${defaulted} → ${restored}`);
  }

  /* ---- export / import round trip ---------------------------------------- */
  await page.evaluate(() => document.getElementById('btnPresetExport').click());
  await page.waitForTimeout(300);
  const text = await page.inputValue('#presetText');
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
  const secondLine = (text.split('\n')[1] || '');
  if (/^ {2}\S/.test(secondLine)) ok('the exported JSON is indented in twos', JSON.stringify(secondLine.trim().slice(0, 30)));
  else bad('the exported JSON is indented in twos', JSON.stringify(secondLine));

  if (parsed && parsed.kind === 'oscilloscope-presets' && parsed.presets.length === 1 && parsed.presets[0].name === '我的描边') {
    ok('export produces portable text', `${text.length} bytes, kind ${parsed.kind}`);
  } else {
    bad('export produces portable text', text.slice(0, 80));
  }

  /* the box shows itself on demand, so put text in it the way the UI does:
     reveal first, then fill (revealing clears it) */
  const putText = (t) => page.evaluate((v) => {
    const el = document.getElementById('presetText');
    el.hidden = false;
    el.value = v;
  }, t);

  const junkBefore = await chips();
  await putText('{"presets": "nope"}');
  await page.click('#btnPresetImport');
  await page.waitForTimeout(300);
  const junkAfter = await chips();
  if (junkAfter.join() === junkBefore.join()) ok('an unusable import changes nothing', `still ${junkAfter.length} presets`);
  else bad('an unusable import changes nothing', `${junkBefore.join()} → ${junkAfter.join()}`);

  /* the imported copy must land under a free name, not silently replace one */
  await putText(text);
  await page.click('#btnPresetImport');
  await page.waitForTimeout(400);
  const duped = await chips();
  if (duped.includes('我的描边 2')) ok('a colliding import name gets a free one', duped.join(' '));
  else bad('a colliding import name gets a free one', duped.join(' '));

  /* ---- an import cannot push a value the UI cannot express ---------------
     A preset with blankRatio 999 would leave the slider at 15 while the
     renderer used 999 — the readout would lie. It has to be clamped to the
     control's own range on the way in. */
  const hostile = JSON.stringify({
    kind: 'oscilloscope-presets',
    v: 1,
    presets: [{
      name: '越界',
      settings: { blankRatio: 999, windowIdx: 99, persistence: -5, intensity: 'NaN', color: 'javascript:alert(1)', gainX: 3.4567 },
    }],
  });
  await putText(hostile);
  await page.click('#btnPresetImport');
  await page.waitForTimeout(500);
  await clickChip('越界');
  await page.waitForTimeout(300);
  const clamped = {
    ratio: await ctl('blankRatio'),
    ratioOut: await out('blankRatio'),
    winIdx: await ctl('windowIdx'),
    persOut: await out('persistence'),
    colour: await ctl('color'),
    gainX: await ctl('gainX'),
  };
  /* The real test is that the *label* and the *control* agree: 15 and "15×". */
  if (clamped.ratio === '15' && clamped.ratioOut === '15×'
    && clamped.winIdx === '6' && clamped.persOut === '0 %'
    && clamped.colour === '#3dff9c' && clamped.gainX === '3.46') {
    ok('imported values are clamped and snapped to the controls',
      `blankRatio 999→${clamped.ratio} (label ${clamped.ratioOut}), windowIdx 99→${clamped.winIdx}, colour dropped`);
  } else {
    bad('imported values are clamped and snapped to the controls', JSON.stringify(clamped));
  }

  /* ---- delete takes two clicks ------------------------------------------- */
  await page.evaluate(() => {
    const b = document.querySelector('#presetChips .chip[data-preset="我的描边 2"] .x');
    b.click();
  });
  await page.waitForTimeout(200);
  const armed = await chips();
  await page.evaluate(() => {
    const b = document.querySelector('#presetChips .chip[data-preset="我的描边 2"] .x');
    b.click();
  });
  await page.waitForTimeout(300);
  const gone = await chips();
  if (armed.includes('我的描边 2') && !gone.includes('我的描边 2')) {
    ok('deleting a custom preset takes two clicks', 'armed, then removed');
  } else {
    bad('deleting a custom preset takes two clicks', `${armed.join()} → ${gone.join()}`);
  }

  /* ---- the two modes are independent (and both keep their own promise) --- */
  const trackCount = await page.evaluate(() => document.querySelectorAll('.track').length);
  const goTrack = (i) => page.evaluate((n) => document.querySelectorAll('.track')[n].click(), i);
  if (trackCount >= 2) {
    await page.evaluate(() => { try { localStorage.clear(); } catch (e) { /* blocked */ } });
    await page.reload();
    await page.waitForTimeout(1300);
    await openPanel();

    await setCtl('persistence', 33);
    await page.waitForTimeout(700);          // clear the 400 ms record debounce
    await goTrack(1);
    await page.waitForTimeout(900);
    await goTrack(0);
    await page.waitForTimeout(900);
    const backAuto = await out('persistence');
    if (backAuto === '33 %') ok('auto mode restores a track\'s own settings', `persistence ${backAuto} came back`);
    else bad('auto mode restores a track\'s own settings', `persistence ${backAuto}`);

    await page.evaluate(() => document.querySelector('#presetMode button[data-mode="manual"]').click());
    await page.waitForTimeout(400);
    await setCtl('persistence', 77);
    await page.waitForTimeout(700);
    await goTrack(1);
    await page.waitForTimeout(900);
    const manualOther = await out('persistence');
    await goTrack(0);
    await page.waitForTimeout(900);
    const manualBack = await out('persistence');
    if (manualOther === '77 %' && manualBack === '77 %') {
      ok('manual mode leaves settings alone across tracks', `${manualOther} / ${manualBack}`);
    } else {
      bad('manual mode leaves settings alone across tracks', `${manualOther} / ${manualBack}`);
    }

    await page.evaluate(() => document.querySelector('#presetMode button[data-mode="auto"]').click());
    await page.waitForTimeout(600);
    if (await mode() === 'auto') ok('the mode switch moves both ways');
    else bad('the mode switch moves both ways', String(await mode()));
  } else {
    ok('auto/manual mode checks', `skipped — needs 2 tracks, found ${trackCount}`);
  }

  /* leave the origin clean for whatever runs next */
  await page.evaluate(() => {
    try { localStorage.clear(); } catch (e) { /* blocked */ }
    document.querySelector('#presetMode button[data-mode="auto"]').click();
    document.getElementById('btnReset').click();
  });
  await page.waitForTimeout(500);

  if (errors.length === 0) ok('no runtime errors while using presets');
  else bad('no runtime errors while using presets', errors.slice(0, 3).join(' | '));

  await page.screenshot({ path: path.join(SHOTS, 'presets.png') });
  await browser.close();
}

module.exports = { presetTests };
