#!/usr/bin/env node
'use strict';

/* ============================================================================
 *  test/verify.js
 *
 *  End-to-end verification. Runs with zero required dependencies:
 *
 *    1. HTTP layer   — spawns server.js and exercises the routes, including
 *                      byte-range requests (needed for seeking a 270 MB FLAC)
 *                      and path-traversal rejection.
 *    2. Render layer — drives a real Chromium via Playwright (skipped with a
 *                      notice when Playwright is unavailable) and asserts the
 *                      two hard visual requirements:
 *
 *                        NO GLOW           : shadowBlur is never written and
 *                                            globalCompositeOperation is never
 *                                            set to 'lighter'.
 *                        NO RETRACE LINES  : the analyser is stubbed with a
 *                                            synthetic XY path that traces a
 *                                            square slowly and then makes a
 *                                            fast diagonal retrace across its
 *                                            middle. Whatever crosses the
 *                                            centre of the screen can only be
 *                                            that retrace, so the pixels there
 *                                            are measured directly.
 *
 *  Screenshots land in test/shots/ for eyeballing.
 *
 *    node test/verify.js
 * ========================================================================== */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(__dirname, 'shots');
const PORT = 8000 + (process.pid % 900);
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, detail) {
  pass++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
}
function bad(name, detail) {
  fail++;
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
}
function section(t) {
  console.log(`\n\x1b[1m${t}\x1b[0m`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: opts.method || 'GET', headers: opts.headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Ask an INDEPENDENT decoder what each file really is: rate, channels, bits,
 *  duration. Used to check the server's own header parser, and to survive the
 *  test audio being swapped out for different formats. */
function externalProbe(fileNames) {
  const has = (bin) => {
    try { execSync(`command -v ${bin}`, { stdio: 'ignore' }); return true; } catch { return false; }
  };
  const useFfprobe = has('ffprobe');
  const useAfinfo = !useFfprobe && process.platform === 'darwin' && has('afinfo');
  if (!useFfprobe && !useAfinfo) return null;

  const out = {};
  for (const name of fileNames) {
    const abs = path.join(ROOT, name);
    if (!fs.existsSync(abs)) continue;
    try {
      if (useFfprobe) {
        const j = JSON.parse(execSync(
          `ffprobe -v quiet -print_format json -show_streams "${abs}"`,
          { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
        ));
        const s = (j.streams || []).find((x) => x.codec_type === 'audio');
        if (!s) continue;
        out[name] = {
          tool: 'ffprobe',
          sampleRate: Number(s.sample_rate),
          channels: Number(s.channels),
          bits: Number(s.bits_per_raw_sample || s.bits_per_sample) || null,
          duration: Number(s.duration) || null,
        };
      } else {
        const txt = execSync(`afinfo "${abs}"`, { encoding: 'utf8' });
        const fmt = /Data format:\s*(\d+) ch,\s*(\d+) Hz/.exec(txt);
        const bits = /from (\d+)-bit source/.exec(txt);
        const dur = /estimated duration:\s*([\d.]+)/.exec(txt);
        if (!fmt) continue;
        out[name] = {
          tool: 'afinfo',
          channels: Number(fmt[1]),
          sampleRate: Number(fmt[2]),
          bits: bits ? Number(bits[1]) : null,
          duration: dur ? Number(dur[1]) : null,
        };
      }
    } catch { /* unreadable — reported by the caller */ }
  }
  return Object.keys(out).length ? out : null;
}

function loadPlaywright() {
  const tries = ['playwright', 'playwright-core'];
  for (const t of tries) {
    try { return require(t); } catch { /* keep trying */ }
  }
  try {
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    for (const t of tries) {
      try { return require(path.join(root, t)); } catch { /* keep trying */ }
    }
  } catch { /* no npm */ }
  return null;
}

function findChromium() {
  const candidates = [
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return undefined;   // let Playwright pick its own bundle
}

/* ------------------------------------------------------------------ server */

async function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(PORT)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });

  for (let i = 0; i < 60; i++) {
    await sleep(100);
    try {
      const r = await get(`${BASE}/api/health`);
      if (r.status === 200) return { child, log: () => out };
    } catch { /* not up yet */ }
  }
  child.kill();
  throw new Error('server did not start:\n' + out);
}

/* -------------------------------------------------------------- http tests */

async function httpTests() {
  section('HTTP layer');

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
      if (ref.duration && Math.abs(t.duration - ref.duration) > 0.5) {
        problems.push(`duration ${t.duration.toFixed(2)} vs ${ref.duration.toFixed(2)}`);
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

  for (const [p, type] of [['/styles.css', 'text/css'], ['/app.js', 'text/javascript']]) {
    const r = await get(BASE + p);
    if (r.status === 200 && (r.headers['content-type'] || '').startsWith(type)) ok(`GET ${p}`, r.headers['content-type']);
    else bad(`GET ${p}`, `status ${r.status} type ${r.headers['content-type']}`);
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
}

/* ------------------------------------------------------------ render tests */

const SYNTH = `
  // A square traced slowly, then a fast diagonal retrace through its centre.
  window.__synthPoint = function (t) {
    if (t < 0.70) {                        // slow stroke: square perimeter
      const u = t / 0.70;
      const k = Math.min(3.999, u * 4);
      const side = Math.floor(k), f = k - side;
      const a = -0.7 + 1.4 * f;
      if (side === 0) return [a, -0.7];
      if (side === 1) return [0.7, a];
      if (side === 2) return [-a, 0.7];
      return [-0.7, -a];
    }
    if (t < 0.705) {                       // retrace: ~20 samples across the middle
      const u = (t - 0.70) / 0.005;
      return [-0.7 + 1.4 * u, -0.7 + 1.4 * u];
    }
    return [0.7, 0.7];                     // hold at the far corner
  };

  window.__glow = { shadowBlur: 0, shadowColor: 0, lighter: 0, filter: 0, closePathCalls: 0 };

  // Watch for anything that would produce a halo / bloom.
  (function () {
    const proto = CanvasRenderingContext2D.prototype;
    const watch = {
      shadowBlur: (v) => Number(v) > 0,
      shadowColor: (v) => !!v && v !== 'rgba(0, 0, 0, 0)' && v !== 'transparent',
      filter: (v) => !!v && v !== 'none',
    };
    for (const prop of Object.keys(watch)) {
      const d = Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.set) continue;
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: d.enumerable,
        get: d.get,
        set: function (v) {
          if (watch[prop](v)) window.__glow[prop]++;
          return d.set.call(this, v);
        },
      });
    }
    const gco = Object.getOwnPropertyDescriptor(proto, 'globalCompositeOperation');
    Object.defineProperty(proto, 'globalCompositeOperation', {
      configurable: true,
      enumerable: gco.enumerable,
      get: gco.get,
      set: function (v) {
        if (String(v).toLowerCase() === 'lighter') window.__glow.lighter++;
        return gco.set.call(this, v);
      },
    });
    // closePath on the beam path would create a return trace
    const cp = proto.closePath;
    proto.closePath = function () { window.__glow.closePathCalls++; return cp.apply(this, arguments); };
  })();

  // Tag the two splitter-fed analysers as X (output 0) and Y (output 1) so the
  // synthetic signal can be delivered through the app's real audio pipeline.
  (function () {
    const origConnect = ChannelSplitterNode.prototype.connect;
    ChannelSplitterNode.prototype.connect = function (dest, out, inp) {
      try {
        if (dest && typeof dest.getFloatTimeDomainData === 'function' && (out === 0 || out === 1)) dest.__ch = out;
      } catch (e) { /* ignore */ }
      return origConnect.call(this, dest, out, inp);
    };

    const origFloat = AnalyserNode.prototype.getFloatTimeDomainData;
    AnalyserNode.prototype.getFloatTimeDomainData = function (arr) {
      if (!window.__synthOn) return origFloat.call(this, arr);
      const ch = this.__ch === 1 ? 1 : 0;
      const P = 4096;
      for (let i = 0; i < arr.length; i++) {
        const p = window.__synthPoint((i % P) / P);
        arr[i] = ch === 0 ? p[0] : p[1];
      }
    };
  })();

  window.__measure = function (cx, cy, halfW, halfH) {
    const c = document.getElementById('trace');
    const g = c.getContext('2d');
    const x = Math.max(0, Math.round(cx - halfW));
    const y = Math.max(0, Math.round(cy - halfH));
    const w = Math.min(c.width - x, Math.round(halfW * 2));
    const h = Math.min(c.height - y, Math.round(halfH * 2));
    if (w <= 0 || h <= 0) return { max: -1, mean: -1 };
    const d = g.getImageData(x, y, w, h).data;
    let max = 0, sum = 0, n = 0;
    for (let i = 3; i < d.length; i += 4) { if (d[i] > max) max = d[i]; sum += d[i]; n++; }
    return { max, mean: n ? sum / n : 0 };
  };

  window.__plotCenter = function () {
    const c = document.getElementById('trace');
    const W = c.width, H = c.height;
    const PLOT = Math.min(W, H) * 0.86;
    const cx = (W - PLOT) / 2 + PLOT / 2;
    const cy = Math.max(H * 0.02, (H - PLOT) / 2 - Math.min(H * 0.035, 30)) + PLOT / 2;
    return { W, H, PLOT, cx, cy };
  };
`;

async function renderTests(pw) {
  section('Render layer (Chromium)');

  const browser = await pw.chromium.launch({
    executablePath: findChromium(),
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = m.location() && m.location().url ? m.location().url : '';
    errors.push(`console: ${m.text()}${url ? ` @ ${url}` : ''}`);
  });
  const realErrors = () => errors.filter((e) => !/favicon/i.test(e));

  await page.addInitScript(SYNTH);
  await page.goto(`${BASE}/?demo=1`, { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  if (!realErrors().length) ok('app boots with no console/page errors');
  else bad('app boots with no console/page errors', realErrors().slice(0, 3).join(' | '));

  // The AudioContext must actually be running for the analysers to produce data.
  const running = await page.evaluate(() => {
    const t = document.getElementById('trace');
    return !!t && t.width > 0 && t.height > 0;
  });
  if (running) ok('canvases sized for the viewport');
  else bad('canvases sized for the viewport');

  /* ---- synthetic retrace, blanking OFF -------------------------------- */
  await page.evaluate(() => { window.__synthOn = true; });
  const center = await page.evaluate(() => window.__plotCenter());

  // turn blanking off through the real UI control
  await page.evaluate(() => {
    const b = document.querySelector('[data-toggle="blanking"]');
    if (b && b.getAttribute('aria-pressed') === 'true') b.click();
  });
  await page.waitForTimeout(1400);
  const offMid = await page.evaluate((c) => window.__measure(c.cx, c.cy, c.PLOT * 0.12, c.PLOT * 0.12), center);
  const offEdge = await page.evaluate((c) => window.__measure(c.cx + c.PLOT * 0.35, c.cy, 6, c.PLOT * 0.2), center);
  await page.screenshot({ path: path.join(SHOTS, 'retrace-blanking-off.png') });

  if (offEdge.max > 40) ok('synthetic square stroke is rendered', `edge alpha ${offEdge.max}`);
  else bad('synthetic square stroke is rendered', `edge alpha ${offEdge.max}`);
  if (offMid.max > 40) ok('control: retrace IS visible with blanking off', `centre alpha ${offMid.max}`);
  else bad('control: retrace IS visible with blanking off', `centre alpha ${offMid.max} — test signal not reaching the renderer`);

  /* ---- synthetic retrace, blanking ON --------------------------------- */
  await page.evaluate(() => {
    const b = document.querySelector('[data-toggle="blanking"]');
    if (b && b.getAttribute('aria-pressed') === 'false') b.click();
  });
  await page.waitForTimeout(1600);
  const onMid = await page.evaluate((c) => window.__measure(c.cx, c.cy, c.PLOT * 0.12, c.PLOT * 0.12), center);
  const onEdge = await page.evaluate((c) => window.__measure(c.cx + c.PLOT * 0.35, c.cy, 6, c.PLOT * 0.2), center);
  await page.screenshot({ path: path.join(SHOTS, 'retrace-blanking-on.png') });

  if (onEdge.max > 40) ok('square stroke still rendered with blanking on', `edge alpha ${onEdge.max}`);
  else bad('square stroke still rendered with blanking on', `edge alpha ${onEdge.max}`);
  if (onMid.max <= 4) ok('NO RETRACE LINE through the centre', `centre alpha ${onMid.max} (was ${offMid.max})`);
  else bad('NO RETRACE LINE through the centre', `centre alpha ${onMid.max} — retrace still visible`);

  /* ---- glow instrumentation ------------------------------------------- */
  const glow = await page.evaluate(() => window.__glow);
  if (glow.shadowBlur === 0 && glow.lighter === 0 && glow.filter === 0) {
    ok('NO GLOW: no shadowBlur, no additive blending', JSON.stringify(glow));
  } else bad('NO GLOW: no shadowBlur, no additive blending', JSON.stringify(glow));

  if (glow.closePathCalls === 0) ok('trace path is never closed', 'closePath calls: 0');
  else bad('trace path is never closed', `${glow.closePathCalls} closePath call(s)`);

  /* ---- real audio ------------------------------------------------------ */
  await page.evaluate(() => { window.__synthOn = false; });
  await page.goto(`${BASE}/?track=0`, { waitUntil: 'load' });
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
    const c = document.getElementById('trace');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 24) lit++;
    return lit;
  });

  const live = await litPixels();
  if (live > 200) ok('live trace is drawn from the audio file', `${live} lit pixels`);
  else bad('live trace is drawn from the audio file', `${live} lit pixels`);

  await page.screenshot({ path: path.join(SHOTS, 'live-audio.png') });

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

  /* ---- burn-in layer --------------------------------------------------- */
  const layerInk = (id) => page.evaluate((id) => {
    const c = document.getElementById(id);
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let lit = 0, max = 0;
    for (let i = 3; i < d.length; i += 4) { if (d[i] > 8) lit++; if (d[i] > max) max = d[i]; }
    return { lit, max };
  }, id);
  const setBurn = (v) => page.evaluate((v) => {
    const el = document.querySelector('[data-set="burnIn"]');
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, v);

  await page.evaluate(() => {
    const a = document.getElementById('audio');
    if (a.paused) document.getElementById('btnPlay').click();
  });
  await page.waitForTimeout(600);

  const burnIdle = await layerInk('burnin');       // off by default
  await setBurn(100);                              // 100% = permanent
  await page.waitForTimeout(6000);
  const burnOn = await layerInk('burnin');
  if (burnIdle.lit === 0) ok('burn-in layer starts empty', 'off by default');
  else bad('burn-in layer starts empty', `${burnIdle.lit} px`);
  if (burnOn.lit > 500) ok('burn-in accumulates beam exposure', `${burnOn.lit} px, peak alpha ${burnOn.max}`);
  else bad('burn-in accumulates beam exposure', JSON.stringify(burnOn));

  await page.evaluate(() => document.getElementById('audio').pause());
  await page.waitForTimeout(2600);
  const burnPaused = await layerInk('burnin');
  const tracePaused = await layerInk('trace');
  if (burnPaused.lit >= burnOn.lit * 0.98) {
    ok('burn-in survives a pause', `${burnPaused.lit} px (was ${burnOn.lit})`);
  } else {
    bad('burn-in survives a pause', `${burnPaused.lit} vs ${burnOn.lit}`);
  }
  if (burnPaused.lit > tracePaused.lit * 2) {
    ok('the ghost lives on its own layer, not in the afterglow',
      `burn-in ${burnPaused.lit} px vs afterglow ${tracePaused.lit} px`);
  } else {
    bad('the ghost lives on its own layer, not in the afterglow',
      `burn-in ${burnPaused.lit} vs afterglow ${tracePaused.lit}`);
  }

  /* A relayout assigns canvas.width, which clears the bitmap. The accumulated
     layers have to be carried across or a window resize silently eats them. */
  const sigOf = (id) => page.evaluate((id) => {
    const c = document.getElementById(id);
    const o = document.createElement('canvas');
    o.width = 256; o.height = 160;
    const g = o.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, 256, 160);
    g.drawImage(c, 0, 0, c.width, c.height, 0, 0, 256, 160);
    const d = g.getImageData(0, 0, 256, 160).data;
    const out = [];
    for (let i = 1; i < d.length; i += 4) out.push(d[i]);
    return out;
  }, id);

  const sigBefore = await sigOf('burnin');
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.waitForTimeout(1400);
  const sigAfter = await sigOf('burnin');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(1400);
  let sigSum = 0;
  for (let i = 0; i < sigBefore.length; i++) sigSum += Math.abs(sigBefore[i] - sigAfter[i]);
  const sigMean = sigSum / sigBefore.length;
  if (sigMean < 4) ok('layers survive a window resize', `mean pixel delta ${sigMean.toFixed(2)} / 255`);
  else bad('layers survive a window resize', `mean pixel delta ${sigMean.toFixed(2)} — the ghost was eaten`);

  await setBurn(0);
  await page.waitForTimeout(400);
  const burnCleared = await layerInk('burnin');
  if (burnCleared.lit === 0) ok('turning burn-in off wipes the ghost');
  else bad('turning burn-in off wipes the ghost', `${burnCleared.lit} px`);

  /* ---- residue: the 8-bit quantisation floor --------------------------- */
  /* destination-out multiplies alpha, so with round-to-nearest every value
     n <= 1/(2a) is a fixed point. A slow fade (high 余辉) therefore leaves a
     BRIGHTER permanent ghost, not a longer one. The 残留 slider scrubs it. */
  const ghostBand = () => page.evaluate(() => {
    const c = document.getElementById('trace');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8 && d[i] <= 64) n++;
    return +((n * 100) / (c.width * c.height)).toFixed(3);
  });
  const setNum = (k, v) => page.evaluate((c) => {
    const el = document.querySelector(`[data-set="${c.k}"]`);
    el.value = String(c.v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, { k, v });

  const ghostAfterRun = async (residue) => {
    await setNum('persistence', 100);
    await setNum('residue', residue);
    await page.evaluate(() => {
      const a = document.getElementById('audio');
      a.currentTime = 60;
      if (a.paused) document.getElementById('btnPlay').click();
    });
    await page.waitForTimeout(9000);
    await page.evaluate(() => document.getElementById('audio').pause());
    await page.waitForTimeout(5000);
    return ghostBand();
  };

  const ghostOn = await ghostAfterRun(100);
  const ghostOff = await ghostAfterRun(0);
  if (ghostOn > 5) ok('residue 100% leaves a permanent ghost', `${ghostOn}% of the canvas at alpha 9-64`);
  else bad('residue 100% leaves a permanent ghost', `${ghostOn}%`);
  if (ghostOff < ghostOn / 10) {
    ok('residue off (default) wipes the quantisation floor', `${ghostOff}% vs ${ghostOn}%`);
  } else {
    bad('residue off (default) wipes the quantisation floor', `${ghostOff}% vs ${ghostOn}%`);
  }
  await page.evaluate(() => document.getElementById('btnReset').click());
  await page.waitForTimeout(600);

  await page.evaluate(() => document.querySelector('#btnList').click());
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, 'playlist.png') });
  await page.evaluate(() => {
    document.querySelector('#btnList').click();
    document.querySelector('#btnSettings').click();
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, 'settings.png') });

  const lateErrors = realErrors();
  if (lateErrors.length === 0) ok('no runtime errors during playback');
  else bad('no runtime errors during playback', lateErrors.slice(0, 3).join(' | '));

  await browser.close();
}

/* ------------------------------------------------- standalone (file://) test */

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
    const c = document.getElementById('trace');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 24) lit++;
    return { src: /^blob:/.test(a.src || ''), paused: a.paused, t: a.currentTime, lit };
  });

  if (state.src && !state.paused && state.t > 0.4) ok('picked file plays from a blob URL', `t=${state.t.toFixed(2)}s`);
  else bad('picked file plays from a blob URL', JSON.stringify(state));

  if (state.lit > 200) ok('trace renders in the single-file edition', `${state.lit} lit pixels`);
  else bad('trace renders in the single-file edition', `${state.lit} lit pixels`);

  await page.screenshot({ path: path.join(SHOTS, 'standalone-file-protocol.png') });
  await browser.close();
}

/* --------------------------------------------------- no-resampling test */

/* Band energy via FFT + Hann window. Comparing band *energies* (not Goertzel
   magnitudes) keeps the number honest whether the band is tonal or noise-like,
   and a band above Nyquist correctly comes out as exactly zero energy. */
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
 *  PSD (not total band energy) so a wide band isn't flattered by bin count. */
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

/* -------------------------------------------------------------------- main */

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log(`\n\x1b[1m◉ oscilloscope music player — verification\x1b[0m  \x1b[2m(node ${process.version})\x1b[0m`);

  const server = await startServer();
  try {
    await httpTests();

    const pw = loadPlaywright();
    if (!pw) {
      section('Render layer');
      console.log('  \x1b[33m•\x1b[0m Playwright not found — skipping browser checks.');
      console.log('    \x1b[2minstall with: npm i -g playwright\x1b[0m');
    } else {
      await renderTests(pw);
      await resampleTests(pw);
      await standaloneTests(pw);
    }
  } finally {
    server.child.kill('SIGKILL');
  }

  console.log(`\n\x1b[1mresult\x1b[0m  \x1b[32m${pass} passed\x1b[0m` + (fail ? `, \x1b[31m${fail} failed\x1b[0m` : ''));
  if (fail) {
    console.log('\n' + failures.map((f) => '  \x1b[31m✗\x1b[0m ' + f).join('\n'));
  }
  console.log(`  \x1b[2mscreenshots: ${path.relative(process.cwd(), SHOTS)}/\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\n\x1b[31mverification crashed:\x1b[0m', err);
  process.exit(2);
});
