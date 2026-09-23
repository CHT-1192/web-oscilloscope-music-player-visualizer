#!/usr/bin/env node
'use strict';

/* ============================================================================
    test/sections/http.js — the HTTP layer.

    The routes, the byte-range support a 270 MB FLAC needs in order to seek, and
    the two refusals that matter: path traversal and a POST. It also builds the
    fixture files (ffmpeg) and compares every header parse against ffprobe, so a
    parser that regresses shows up here rather than as a wrong number in the
    playlist.
   ========================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const h = require('../harness.js');
const { ok, bad, section, get, externalProbe, ROOT } = h;

async function httpTests() {
  const BASE = h.base;
  section('HTTP layer');

  /* Fixtures for every container whose header we parse, so each one is covered
     every run instead of only when the author happens to own that format. Made
     in the project root because that is what the server scans, and removed
     again at the end. `vorbis` is absent from some ffmpeg builds, hence opus. */
  const FIXTURES = [
    { name: 'probe-fixture.m4a', ext: 'm4a', codec: 'aac', rate: 44100, codecName: 'AAC' },
    { name: 'probe-fixture.aiff', ext: 'aiff', codec: 'pcm_s16be', rate: 44100, codecName: 'PCM', bits: 16 },
    { name: 'probe-fixture.aifc', ext: 'aifc', codec: 'pcm_s16le', rate: 44100, codecName: 'PCM', bits: 16 },
    { name: 'probe-fixture.caf', ext: 'caf', codec: 'pcm_s16be', rate: 44100, codecName: 'PCM', bits: 16 },
    { name: 'probe-fixture.mp3', ext: 'mp3', codec: 'libmp3lame', rate: 44100, codecName: 'MP3' },
    { name: 'probe-fixture.ogg', ext: 'ogg', codec: 'libopus', rate: 48000, codecName: 'Opus' },
  ];
  const made = [];
  for (const f of FIXTURES) {
    try {
      execSync('ffmpeg -v error -y -f lavfi -i "sine=frequency=440:duration=1:sample_rate=44100" '
        + `-ac 2 -c:a ${f.codec} "${path.join(ROOT, f.name)}"`, { stdio: 'ignore' });
      made.push(f);
    } catch { /* encoder missing in this ffmpeg build — its check reports skipped */ }
  }
  const madeFixture = made.length > 0;

  const tracks = JSON.parse((await get(`${BASE}/api/tracks`)).body.toString());
  const names = tracks.tracks.map((t) => t.name);
  if (tracks.tracks.length >= 1) ok('GET /api/tracks', `${names.join(', ')}`);
  else bad('GET /api/tracks', `no audio found in the project root`);

  /* Cross-check the server's header parser against an INDEPENDENT decoder
     rather than against hard-coded filenames. This keeps working when the
     test audio is swapped out (it was: a .wav became a .flac) and it is a
     stronger check, because it compares two implementations. */
  const truth = externalProbe(tracks.tracks.map((t) => t.name));
  if (!truth) {
    ok('header parse cross-check', 'skipped — no ffprobe/afinfo available');
  } else {
    for (const t of tracks.tracks) {
      const ref = truth[t.name];
      if (!ref) { bad(`header parse: ${t.name}`, 'independent probe failed'); continue; }
      const problems = [];
      if (t.sampleRate !== ref.sampleRate) problems.push(`rate ${t.sampleRate} vs ${ref.sampleRate}`);
      if (t.channels !== ref.channels) problems.push(`channels ${t.channels} vs ${ref.channels}`);
      if (ref.bits && t.bits !== ref.bits) problems.push(`bits ${t.bits} vs ${ref.bits}`);
      /* MP3 duration would need a full frame count or a Xing header; the probe
         deliberately reports none, so comparing it here would be a false alarm. */
      const noDuration = new Set(['MP3']);
      if (ref.duration && !noDuration.has(t.format) && (!t.duration || Math.abs(t.duration - ref.duration) > 0.5)) {
        const got = t.duration == null ? 'null' : t.duration.toFixed(2);
        problems.push(`duration ${got} vs ${ref.duration.toFixed(2)}`);
      }
      if (problems.length) bad(`header parse: ${t.name}`, problems.join(', '));
      else {
        ok(`header parse: ${t.name}`,
          `${t.sampleRate} Hz · ${t.bits}-bit · ${t.channels}ch · ${t.durationText}  (matches ${ref.tool})`);
      }
    }
  }

  // A lossless-format check: a FLAC must report sane values, whatever it is.
  const flacs = tracks.tracks.filter((t) => t.format === 'FLAC');
  if (flacs.length && flacs.every((t) => t.sampleRate > 0 && t.channels > 0 && t.duration > 0)) {
    ok('all FLACs report a usable rate/channels/duration');
  } else if (flacs.length) {
    bad('all FLACs report a usable rate/channels/duration', JSON.stringify(flacs.map((t) => t.name)));
  }

  /* Every container is probed for its own native rate. Without that the engine
     falls back to the device rate and the analysis path resamples — the one
     thing this project is built not to do — and it fails SILENTLY. */
  for (const f of FIXTURES) {
    const label = `header probe: ${f.ext}`;
    if (!made.some((m) => m.name === f.name)) { ok(label, 'skipped — ffmpeg lacks that encoder'); continue; }
    const got = tracks.tracks.find((x) => x.name === f.name);
    const problems = [];
    if (!got) problems.push('not listed');
    else {
      if (got.sampleRate !== f.rate) problems.push(`rate ${got.sampleRate} vs ${f.rate}`);
      if (got.channels !== 2) problems.push(`channels ${got.channels}`);
      if (got.codec !== f.codecName) problems.push(`codec ${got.codec} vs ${f.codecName}`);
      if (f.bits && got.bits !== f.bits) problems.push(`bits ${got.bits} vs ${f.bits}`);
      if (!f.bits && got.bits) problems.push(`claimed ${got.bits}-bit for a lossy codec`);
      if (f.codecName !== 'MP3' && !(got.duration > 0.5)) problems.push(`duration ${got.duration}`);
    }
    if (problems.length) bad(label, problems.join(', '));
    else ok(label, `${got.sampleRate} Hz · ${got.channels}ch · ${got.codec} · ${got.durationText || 'no duration parsed'}`);
  }

  const page = await get(`${BASE}/`);
  if (page.status === 200 && /示波器|OSCILLOSCOPE/i.test(page.body.toString())) ok('GET / serves the app');
  else bad('GET / serves the app', `status ${page.status}`);

  const standalone = await get(`${BASE}/standalone`);
  const sBody = standalone.body.toString();
  if (standalone.status === 200 && sBody.includes('<style>') && sBody.includes('NO RETRACE LINES')
      && !/src="app\.js"|href="styles\.css"/.test(sBody)) {
    ok('GET /standalone is fully self-contained', `${(sBody.length / 1024).toFixed(1)} KB inlined`);
  } else bad('GET /standalone is fully self-contained');

  const fileStandalone = path.join(ROOT, 'oscilloscope-standalone.html');
  if (fs.existsSync(fileStandalone)) ok('oscilloscope-standalone.html exists on disk');
  else bad('oscilloscope-standalone.html exists on disk');

  /* The app is ES modules now, so the MIME type is load-bearing: browsers
     refuse a module served as anything but a JavaScript type, and the failure
     looks like an empty page rather than an error in this file. */
  for (const [p, type] of [['/styles.css', 'text/css'], ['/js/main.js', 'text/javascript'], ['/js/core.js', 'text/javascript']]) {
    const r = await get(BASE + p);
    if (r.status === 200 && (r.headers['content-type'] || '').startsWith(type)) ok(`GET ${p}`, r.headers['content-type']);
    else bad(`GET ${p}`, `status ${r.status} type ${r.headers['content-type']}`);
  }

  const index = (await get(BASE + '/')).body.toString();
  if (index.includes('<script type="module" src="js/main.js"></script>')) {
    ok('the page loads the module entry, not a classic script');
  } else {
    bad('the page loads the module entry, not a classic script', 'script tag not found');
  }

  // range requests — exercised against the LARGEST file, since that is the one
  // that actually needs seeking
  const media = tracks.tracks.slice().sort((a, b) => b.size - a.size)[0];
  if (media) {
    const full = await get(`${BASE}${media.url}`);
    ok('media full GET', `${full.status} ${full.headers['content-type']} ${full.body.length} B`);

    const u = `${BASE}${media.url}`;
    const r1 = await get(u, { headers: { Range: 'bytes=0-99' } });
    if (r1.status === 206 && r1.body.length === 100 && r1.headers['content-range'] === `bytes 0-99/${media.size}`) {
      ok('range bytes=0-99', '206 + Content-Range');
    } else bad('range bytes=0-99', `${r1.status} ${r1.headers['content-range']} ${r1.body.length}B`);

    const r2 = await get(u, { headers: { Range: 'bytes=-50' } });
    if (r2.status === 206 && r2.body.length === 50) ok('suffix range bytes=-50', '206 + 50 B');
    else bad('suffix range bytes=-50', `${r2.status} ${r2.body.length}B`);

    const r3 = await get(u, { headers: { Range: `bytes=${media.size - 10}-` } });
    if (r3.status === 206 && r3.body.length === 10) ok('open-ended range', '206 + 10 B');
    else bad('open-ended range', `${r3.status} ${r3.body.length}B`);

    const r4 = await get(u, { headers: { Range: `bytes=${media.size + 10}-` } });
    if (r4.status === 416) ok('unsatisfiable range rejected', '416');
    else bad('unsatisfiable range rejected', String(r4.status));

    const head = await get(u, { method: 'HEAD' });
    if (head.status === 200 && head.body.length === 0 && head.headers['content-length'] === String(media.size)) {
      ok('HEAD returns headers only');
    } else bad('HEAD returns headers only', `${head.status} ${head.body.length}B`);
  }

  // security
  const trav = await get(`${BASE}/..%2f..%2fetc%2fpasswd`);
  if (trav.status === 403 || trav.status === 404) ok('static path traversal blocked', String(trav.status));
  else bad('static path traversal blocked', String(trav.status));

  const mediaTrav = await get(`${BASE}/media/${encodeURIComponent('../../etc/passwd')}`);
  if (mediaTrav.status === 404) ok('media traversal blocked', '404');
  else bad('media traversal blocked', String(mediaTrav.status));

  const missing = await get(`${BASE}/media/definitely-not-here.wav`);
  if (missing.status === 404) ok('missing media -> 404');
  else bad('missing media -> 404', String(missing.status));

  const post = await get(`${BASE}/`, { method: 'POST' });
  if (post.status === 405) ok('POST rejected', '405');
  else bad('POST rejected', String(post.status));

  // leave the project root as it was found
  for (const f of made) {
    try { fs.unlinkSync(path.join(ROOT, f.name)); } catch { /* already gone */ }
  }
}

module.exports = { httpTests };
