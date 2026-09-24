#!/usr/bin/env node
'use strict';

/* ============================================================================
    test/sections/playlist.js — the list itself.

    The project root has two audio files, so the server hands the list two rows:
    enough to filter, sort, remove, clear, loop and remember against without
    inventing fixtures. The checks are written against the DOM the listener
    actually touches, because every one of these features is a claim about what
    the panel and the transport say.
   ========================================================================== */

const path = require('node:path');
const h = require('../harness.js');
const { ok, bad, section, SHOTS, findChromium } = h;

const STORE = 'scope.playlist.v1';

/** Clicks through evaluate rather than through Playwright's actionability
    checks: the panel is closed (display: none) for most of this, and a row that
    is not visible is still a row the keyboard and the code can reach. */
const clickJs = (page, selector, nth = 0) => page.evaluate(([sel, n]) => {
  const el = document.querySelectorAll(sel)[n];
  if (el) el.click();
  return !!el;
}, [selector, nth]);

async function playlistTests(pw) {
  const BASE = h.base;
  section('Playlist');

  const browser = await pw.chromium.launch({
    executablePath: findChromium(),
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  const realErrors = () => errors.filter((e) => !/favicon/i.test(e));

  const rows = () => page.evaluate(() => [...document.querySelectorAll('#trackList .track')].map((li) => ({
    n: li.querySelector('.n').textContent,
    name: li.querySelector('.name').textContent,
    meta: li.querySelector('.meta').textContent,
    active: li.classList.contains('active'),
  })));
  const count = () => page.evaluate(() => document.getElementById('listCount').textContent);
  const title = () => page.evaluate(() => document.getElementById('trackTitle').textContent);
  const mode = () => page.evaluate(() => document.getElementById('btnMode').dataset.mode);
  const setMode = async (want) => {
    for (let i = 0; i < 4 && (await mode()) !== want; i++) await clickJs(page, '#btnMode');
    return mode();
  };
  const setSort = (key) => page.evaluate((k) => {
    const el = document.getElementById('trackSort');
    el.value = k;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, key);
  const setFilter = (text) => page.evaluate((v) => {
    const el = document.getElementById('trackFilter');
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);

  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  /* ---- the list comes from the server, sorted, with usable metadata ------ */
  const listed = await rows();
  const names = listed.map((r) => r.name);
  if (listed.length >= 2) {
    ok('the server playlist fills the list', `${listed.length} rows: ${names.join(', ')}`);
  } else {
    bad('the server playlist fills the list', JSON.stringify(listed));
  }
  const asc = names.slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (names.join('|') === asc.join('|')) {
    ok('the default order is by name', names.join(' < '));
  } else {
    bad('the default order is by name', names.join(', '));
  }
  if (listed.every((r) => /FLAC/.test(r.meta) && /\d/.test(r.meta))) {
    ok('each row carries the metadata the sort uses', listed[0].meta);
  } else {
    bad('each row carries the metadata the sort uses', JSON.stringify(listed.map((r) => r.meta)));
  }

  /* ---- filter: by name, by format, and the empty answer is a message ----- */
  const first = names[0];
  const stem = first.slice(0, 4).toLowerCase();
  await setFilter(stem);
  const filtered = await rows();
  if (filtered.length < listed.length && filtered.every((r) => r.name.toLowerCase().includes(stem))) {
    ok('the filter narrows the list by name', `"${stem}" → ${filtered.map((r) => r.name).join(', ')} (${await count()})`);
  } else {
    bad('the filter narrows the list by name', JSON.stringify(filtered));
  }
  await setFilter('flac');
  const byFormat = await rows();
  if (byFormat.length === listed.length) {
    ok('the filter also matches format and metadata', `"flac" → ${byFormat.length} rows`);
  } else {
    bad('the filter also matches format and metadata', `${byFormat.length} of ${listed.length}`);
  }
  await setFilter('zzz-nothing-matches');
  const none = await page.evaluate(() => {
    const note = document.querySelector('#trackList .empty-note');
    return { rows: document.querySelectorAll('#trackList .track').length, note: note ? note.textContent : null };
  });
  if (none.rows === 0 && /没有匹配/.test(none.note || '')) {
    ok('a filter that matches nothing says so', none.note);
  } else {
    bad('a filter that matches nothing says so', JSON.stringify(none));
  }
  await setFilter('');
  if ((await rows()).length === listed.length) ok('clearing the filter brings the list back', `${listed.length} rows`);
  else bad('clearing the filter brings the list back');

  /* ---- sort: duration desc puts the long track first, and says so -------- */
  await setSort('duration');
  const durDir = await page.evaluate(() => ({
    text: document.getElementById('btnSortDir').textContent,
    pressed: document.getElementById('btnSortDir').getAttribute('aria-pressed'),
    title: document.getElementById('btnSortDir').title,
  }));
  if (durDir.text === '↑' && durDir.pressed === 'false' && /时长/.test(durDir.title)) {
    ok('the direction button states which way it will sort', durDir.title);
  } else {
    bad('the direction button states which way it will sort', JSON.stringify(durDir));
  }
  await clickJs(page, '#btnSortDir');
  const desc = await rows();
  if (desc[0].name === names[names.length - 1] && desc[desc.length - 1].name === names[0]) {
    ok('sorting by duration descending reverses the list', desc.map((r) => r.name).join(' > '));
  } else {
    bad('sorting by duration descending reverses the list', desc.map((r) => r.name).join(', '));
  }
  await page.evaluate(() => {
    const el = document.getElementById('btnSortDir');
    if (el.textContent === '↓') el.click();
  });
  await setSort('name');

  /* ---- the mode button cycles, and the icon follows the state ------------ */
  const seen = [];
  for (let i = 0; i < 3; i++) {
    await clickJs(page, '#btnMode');
    seen.push(await page.evaluate(() => ({
      mode: document.getElementById('btnMode').dataset.mode,
      title: document.getElementById('btnMode').title,
    })));
  }
  const modes = seen.map((s) => s.mode);
  if (modes.join(',') === 'one,shuffle,sequence' && /单曲循环/.test(seen[0].title) && /随机/.test(seen[1].title)) {
    ok('the mode button cycles 顺序 → 单曲循环 → 随机', `${modes.join(' → ')} · ${seen[0].title}`);
  } else {
    bad('the mode button cycles 顺序 → 单曲循环 → 随机', JSON.stringify(seen));
  }

  /* ---- what "ended" does, per mode --------------------------------------- */
  await page.evaluate(() => document.getElementById('btnList').click());   // panel open for the shot
  await clickJs(page, '#trackList .track', 0);
  await page.waitForTimeout(900);
  await page.evaluate(() => document.getElementById('audio').pause());
  const activeBefore = (await rows()).findIndex((r) => r.active);
  await setMode('one');
  await page.evaluate(() => document.getElementById('audio').dispatchEvent(new Event('ended')));
  await page.waitForTimeout(900);
  const activeOne = (await rows()).findIndex((r) => r.active);
  if (activeOne === activeBefore) {
    ok('单曲循环 repeats the same track when it ends', `row ${activeOne + 1} still active`);
  } else {
    bad('单曲循环 repeats the same track when it ends', `${activeBefore} → ${activeOne}`);
  }
  await setMode('sequence');
  await page.evaluate(() => document.getElementById('audio').dispatchEvent(new Event('ended')));
  await page.waitForTimeout(1200);
  const activeNext = (await rows()).findIndex((r) => r.active);
  if (activeNext === (activeBefore + 1) % listed.length) {
    ok('顺序 advances to the next track when it ends', `row ${activeBefore + 1} → row ${activeNext + 1}`);
  } else {
    bad('顺序 advances to the next track when it ends', `${activeBefore} → ${activeNext}`);
  }
  await page.screenshot({ path: path.join(SHOTS, 'playlist-tools.png') });

  /* ---- removing rows, and what happens to the one playing ---------------- */
  await clickJs(page, '#trackList .track', 0);
  await page.waitForTimeout(800);
  const playing = await title();
  await clickJs(page, '#trackList .track .rm', 0);
  await page.waitForTimeout(400);
  const afterRemove = await rows();
  const stopped = await page.evaluate(() => ({
    title: document.getElementById('trackTitle').textContent,
    src: !!document.getElementById('audio').getAttribute('src'),
  }));
  if (afterRemove.length === listed.length - 1 && stopped.title === '未加载音频' && !stopped.src) {
    ok('removing the track that is playing stops and unloads it', `${playing} removed, title reset`);
  } else {
    bad('removing the track that is playing stops and unloads it', JSON.stringify({ afterRemove: afterRemove.length, stopped }));
  }
  await clickJs(page, '#trackList .track .rm', 0);
  await page.waitForTimeout(300);
  const empty = await page.evaluate(() => ({
    rows: document.querySelectorAll('#trackList .track').length,
    note: (document.querySelector('#trackList .empty-note') || {}).textContent || '',
    clearDisabled: document.getElementById('btnClear').disabled,
  }));
  if (empty.rows === 0 && /没有找到音频文件/.test(empty.note) && empty.clearDisabled) {
    ok('the list can be emptied down to the empty note', `${JSON.stringify(empty.note.slice(0, 12))}, 清空 now disabled`);
  } else {
    bad('the list can be emptied down to the empty note', JSON.stringify(empty));
  }

  /* ---- 清空 needs two clicks, and the second one really clears ----------- */
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1500);
  await clickJs(page, '#btnClear');
  const armed = await page.evaluate(() => ({
    text: document.getElementById('btnClear').textContent,
    armed: document.getElementById('btnClear').classList.contains('armed'),
    rows: document.querySelectorAll('#trackList .track').length,
  }));
  if (armed.armed && /确认/.test(armed.text) && armed.rows === listed.length) {
    ok('清空 arms first and changes nothing yet', armed.text);
  } else {
    bad('清空 arms first and changes nothing yet', JSON.stringify(armed));
  }
  await clickJs(page, '#btnClear');
  await page.waitForTimeout(400);
  const cleared = await page.evaluate(() => ({
    rows: document.querySelectorAll('#trackList .track').length,
    note: (document.querySelector('#trackList .empty-note') || {}).textContent || '',
  }));
  if (cleared.rows === 0 && /没有找到音频文件/.test(cleared.note)) {
    ok('the second click clears the list', 'empty note shown');
  } else {
    bad('the second click clears the list', JSON.stringify(cleared));
  }

  /* ---- where the listener was, and the mode, survive a reload ------------ */
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1500);
  await setMode('shuffle');
  const target = (await rows()).length - 1;
  await clickJs(page, '#trackList .track', target);
  await page.waitForTimeout(1200);
  await page.evaluate(() => { document.getElementById('audio').currentTime = 30; });
  await page.waitForTimeout(600);
  await page.evaluate(() => document.getElementById('audio').pause());     // flush the playhead
  await page.waitForTimeout(400);
  const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '{}'), STORE);
  const wantName = (await rows())[target].name;
  if (stored.last && stored.last.name === wantName && stored.last.at > 25) {
    ok('the playhead is written down with the track', `${stored.last.name} @ ${stored.last.at.toFixed(1)}s`);
  } else {
    bad('the playhead is written down with the track', JSON.stringify(stored));
  }
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(2500);
  const back = await page.evaluate(() => ({
    title: document.getElementById('trackTitle').textContent,
    paused: document.getElementById('audio').paused,
    t: document.getElementById('audio').currentTime,
    mode: document.getElementById('btnMode').dataset.mode,
  }));
  if (back.title === wantName && back.paused && back.t > 25) {
    ok('a reload comes back to the same track and place, paused', `${back.title} @ ${back.t.toFixed(1)}s`);
  } else {
    bad('a reload comes back to the same track and place, paused', JSON.stringify(back));
  }
  if (back.mode === 'shuffle') ok('the play mode survives a reload', back.mode);
  else bad('the play mode survives a reload', back.mode);

  /* ---- an explicit ?track= still wins over the remembered playhead ------- */
  await page.goto(`${BASE}/?track=0`, { waitUntil: 'load' });
  await page.waitForTimeout(2200);
  const explicit = await page.evaluate(() => ({
    title: document.getElementById('trackTitle').textContent,
    t: document.getElementById('audio').currentTime,
  }));
  if (explicit.t < 5) {
    ok('?track= overrides the remembered playhead', `${explicit.title} @ ${explicit.t.toFixed(1)}s`);
  } else {
    bad('?track= overrides the remembered playhead', JSON.stringify(explicit));
  }

  if (realErrors().length === 0) ok('no runtime errors while using the list');
  else bad('no runtime errors while using the list', realErrors().slice(0, 3).join(' | '));

  await browser.close();
}

module.exports = { playlistTests };
