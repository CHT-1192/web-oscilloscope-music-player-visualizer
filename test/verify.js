#!/usr/bin/env node
'use strict';

/* ============================================================================
    test/verify.js

    End-to-end verification. Runs with zero required dependencies:

      1. HTTP layer   — spawns server.js and exercises the routes, including
                        byte-range requests (needed for seeking a 270 MB FLAC)
                        and path-traversal rejection.
      2. Render layer — drives a real Chromium via Playwright (skipped with a
                        notice when Playwright is unavailable) and asserts the
                        two hard visual requirements:

                          NO GLOW           : shadowBlur is never written and
                                              globalCompositeOperation is never
                                              set to 'lighter'.
                          NO RETRACE LINES  : the analyser is stubbed with a
                                              synthetic XY path that traces a
                                              square slowly and then makes a
                                              fast diagonal retrace across its
                                              middle. Whatever crosses the
                                              centre of the screen can only be
                                              that retrace, so the pixels there
                                              are measured directly.

    Screenshots land in test/shots/ for eyeballing.

      node test/verify.js
   ========================================================================== */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(__dirname, 'shots');
/* Allocated, not guessed. `8000 + pid % 900` could collide with a server left
   behind by an earlier run, and the failure was nasty: the harness then talked
   to that STALE server, which answered /api/health happily and reported the
   previous build's parses — so a real regression looked like a flaky value. */
let PORT = 0;
let BASE = '';
async function pickPort() {
  const net = require('node:net');
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

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
    duration. Used to check the server's own header parser, and to survive the
    test audio being swapped out for different formats. */
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

/* ------------------------------------------------------------ default port */

/** The listen port is not a cosmetic choice: it decides whether `node server.js`
    just works. These checks keep the constant, the help text and the boot path
    from drifting apart, and pin the one property we actually care about — the
    default must not be the number every other dev server already took. */
function defaultPortTests() {
  section('default port');

  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

  const m = src.match(/const DEFAULT_PORT = (\d+);/);
  if (!m) { bad('DEFAULT_PORT is a named constant'); return; }
  const declared = Number(m[1]);
  ok('DEFAULT_PORT is a named constant', String(declared));

  if (declared === 8080) bad('default port is not 8080');
  else ok('default port is not 8080');

  /* Must be bindable without root (>1023) and outside the ephemeral band the
     kernel hands to outgoing sockets (usually 49152+), or a busy machine will
     intermittently "steal" the port from us. */
  if (declared > 1023 && declared < 49152) ok('default port is in the registered range', `${declared} ∈ (1023, 49152)`);
  else bad('default port is in the registered range', String(declared));

  if (/port: Number\(process\.env\.PORT\) \|\| DEFAULT_PORT/.test(src)) ok('boot default comes from the constant');
  else bad('boot default comes from the constant', 'parseArgs does not reference DEFAULT_PORT');

  let help = '';
  try {
    help = execSync(`"${process.execPath}" server.js --help`, { cwd: ROOT }).toString();
  } catch (err) {
    bad('--help advertises the same port', String(err.message).slice(0, 60));
    return;
  }
  if (help.includes(`(default ${declared};`)) ok('--help advertises the same port');
  else bad('--help advertises the same port', help.split('\n').find((l) => l.includes('--port')) || 'no --port line');

  if (/\bPORT\b/.test(help)) ok('--help mentions the PORT env override');
  else bad('--help mentions the PORT env override');
}

/** EADDRINUSE must walk forward instead of dying — and the walk starts from
    whatever base was requested, which is now a 5-digit number. */
async function portRetryTest() {
  const base = PORT + 50;
  const spawnServer = (port) => spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(port)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const healthy = async (port) => {
    for (let i = 0; i < 40; i++) {
      try {
        const r = await get(`http://127.0.0.1:${port}/api/health`);
        if (r.status === 200) return true;
      } catch { /* not up yet */ }
      await sleep(100);
    }
    return false;
  };

  let first = null;
  let second = null;
  try {
    /* Spawn the squatter FIRST and wait until it owns the port. Spawning both
       at once races: whoever wins the bind is arbitrary, and the loser's
       "port in use" line would be written to the pipe nobody is reading. */
    first = spawnServer(base);
    if (await healthy(base)) ok('first server owns the requested port', String(base));
    else bad('first server owns the requested port', String(base));

    second = spawnServer(base);
    let secondOut = '';
    second.stdout.on('data', (d) => { secondOut += d.toString(); });
    second.stderr.on('data', (d) => { secondOut += d.toString(); });

    const bumped = await healthy(base + 1);
    if (bumped && /in use, trying/.test(secondOut)) ok('a taken port walks forward instead of dying', `${base} → ${base + 1}`);
    else bad('a taken port walks forward instead of dying', `bumped=${bumped} log=${JSON.stringify(secondOut.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 120))}`);
  } finally {
    if (first) first.kill('SIGKILL');
    if (second) second.kill('SIGKILL');
  }
}

/* -------------------------------------------------------------- http tests */

async function httpTests() {
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

/* ------------------------------------------------------------ render tests */

const SYNTH = `
  // A square traced slowly, then a fast diagonal retrace through its centre.
  // __synthF = share of the period spent on the retrace. With no hold phase the
  // retrace / mean-beam-speed ratio is exactly 1.98 / (f * 7.58): perimeter 5.6
  // plus diagonal 1.98 units per period.
  window.__synthF = 0.005;
  window.__synthPoint = function (t) {
    const f = window.__synthF;
    if (t < 1 - f) {                       // slow stroke: square perimeter
      const u = t / (1 - f);
      const k = Math.min(3.999, u * 4);
      const side = Math.floor(k), g = k - side;
      const a = -0.7 + 1.4 * g;
      if (side === 0) return [a, -0.7];
      if (side === 1) return [0.7, a];
      if (side === 2) return [-a, 0.7];
      return [-0.7, -a];
    }
    const u = (t - (1 - f)) / f;           // fast diagonal retrace through the centre
    return [-0.7 + 1.4 * u, -0.7 + 1.4 * u];
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
      /* The renderer draws the FIRST winSize() samples of an analyser buffer
         that is 2 x winSize long, so one period has to fit in half the array.
         Hard-coding 4096 here quietly made the whole synthetic suite depend on
         the default window: at a 2048-sample window the retrace (the last 0.5 %
         of the period) fell outside the drawn half and every measurement went
         to zero. Tie the period to the buffer instead. */
      const P = arr.length / 2;
      for (let i = 0; i < arr.length; i++) {
        const p = window.__synthPoint((i % P) / P);
        arr[i] = ch === 0 ? p[0] : p[1];
      }
    };
  })();

  window.__measure = function (cx, cy, halfW, halfH) {
    const c = window.__scope.state.canvas;
    const size = window.__scope.state.canvas;
    const x = Math.max(0, Math.round(cx - halfW));
    const y = Math.max(0, Math.round(cy - halfH));
    const w = Math.min(size.w - x, Math.round(halfW * 2));
    const h = Math.min(size.h - y, Math.round(halfH * 2));
    if (w <= 0 || h <= 0) return { max: -1, mean: -1 };
    const d = window.__scope.readTrace(x, y, w, h);
    let max = 0, sum = 0, n = 0;
    for (let i = 3; i < d.length; i += 4) { if (d[i] > max) max = d[i]; sum += d[i]; n++; }
    return { max, mean: n ? sum / n : 0 };
  };

  window.__plotCenter = function () {
    const c = window.__scope.state.canvas;
    const W = c.w, H = c.h;
    const PLOT = Math.min(W, H) * 0.9;
    const cx = (W - PLOT) / 2 + PLOT / 2;
    const cy = (H - PLOT) / 2 + PLOT / 2;
    return { W, H, PLOT, cx, cy };
  };
`;

/** `rq` is the renderer query string: '' runs whatever the app picks (WebGL when
 *  available), '?renderer=2d' forces the Canvas fallback so the two paths are
 *  held to the same checks. */
async function renderTests(pw, rq = '') {
  /* One query string, not two: `${rq}${rest}` produced '?renderer=2d?demo=1',
     which silently dropped demo=1 — and the synthetic phase then measured an
     empty screen while every other check passed. */
  const nav = (rest) => `${BASE}/${rq}${rq ? rest.replace('?', '&') : rest}`;
  section(`Render layer (Chromium) — ${rq ? 'forced Canvas-2D' : 'default (WebGL when available)'}`);

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
  await page.goto(nav('?demo=1'), { waitUntil: 'load' });
  await page.waitForTimeout(1200);

  if (!realErrors().length) ok('app boots with no console/page errors');
  else bad('app boots with no console/page errors', realErrors().slice(0, 3).join(' | '));

  // The AudioContext must actually be running for the analysers to produce data.
  const running = await page.evaluate(() => {
    const c = window.__scope.state.canvas;
    return !!c && c.w > 0 && c.h > 0;
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

  /* The control: with velocity blanking off the retrace has to get THROUGH. How
     bright it is differs by model and the check is stated so both are honest
     about it — the 8-bit path strokes everything at one alpha when blanking is
     off, while the energy path keeps the 1/v law (a fast beam deposits very
     little) and only stops DROPPING it. So: brighter than with blanking on, and
     not zero. */
  if (offMid.max > 0 && offMid.max > onMid.max) {
    ok('control: blanking off lets the retrace through', `centre ${offMid.max} off vs ${onMid.max} on`);
  } else {
    bad('control: blanking off lets the retrace through', `centre ${offMid.max} off vs ${onMid.max} on — nothing is reaching the renderer`);
  }

  /* ---- the blanking threshold is exact, and adjustable ---------------- */
  const centreAlpha = () => page.evaluate(() => {
    const st = window.__scope.state;
    const c = window.__scope.state.canvas;
    const size = window.__scope.state.canvas;
    const x = Math.round(st.plot.x + st.plot.size / 2);
    const y = Math.round(st.plot.y + st.plot.size / 2);
    const d = window.__scope.readTrace(x - 5, y - 5, 11, 11);
    let max = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > max) max = d[i];
    return max;
  });
  const runAt = async (ratio, threshold) => {
    await page.evaluate((c) => {
      window.__synthF = 0.2612 / c.ratio;      // 1.98 / (f * 7.58)
      const el = document.querySelector('[data-set="blankRatio"]');
      el.value = String(c.threshold);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, { ratio, threshold });
    await page.waitForTimeout(1700);
    return centreAlpha();
  };

  const thrKept = await runAt(8, 12);          // 8x, threshold 12x -> drawn
  const thrDropped = await runAt(8, 5);        // 8x, threshold  5x -> blanked
  if (thrKept > 12 && thrDropped === 0) {
    ok('blanking threshold is the number the slider says',
      `8x kept at a 12x threshold (alpha ${thrKept}), dropped at 5x`);
  } else {
    bad('blanking threshold is the number the slider says', `12x -> ${thrKept}, 5x -> ${thrDropped}`);
  }

  /* The useful range is bounded by where the material's segment speeds live:
     they cluster (slow stroke, fast retrace) with a gap in between, so past the
     top of the gap the slider does nothing at all. Hence 1x-15x, not 1x-30x. */
  const thrEdge = await runAt(12, 15);         // 12x, threshold 15x -> drawn
  if (thrEdge > 12) ok('15x is wide enough to readmit a 12x retrace', `alpha ${thrEdge}`);
  else bad('15x is wide enough to readmit a 12x retrace', `alpha ${thrEdge}`);

  const slider = await page.evaluate(() => {
    const el = document.querySelector('[data-set="blankRatio"]');
    const out = document.querySelector('[data-out="blankRatio"]');
    const read = (v) => {
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return out.textContent;
    };
    const labels = [1, 7.5, 10, 15].map(read);
    el.value = '10';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { min: el.min, max: el.max, step: el.step, labels };
  });
  if (slider.min === '1' && slider.max === '15' && slider.step === '0.5') {
    ok('blanking slider spans 1x-15x in half steps', `${slider.min}-${slider.max} step ${slider.step}, labels ${slider.labels.join(' ')}`);
  } else {
    bad('blanking slider spans 1x-15x in half steps', JSON.stringify(slider));
  }
  if (slider.labels[1] === '7.5×' && slider.labels[3] === '15×') {
    ok('fractional thresholds keep their half', slider.labels.join(' '));
  } else {
    bad('fractional thresholds keep their half', slider.labels.join(' '));
  }

  /* The bottom of the range is aggressive (half the segments can go) but must
     never erase the picture: at 1x the slow stroke is all that is left. */
  await runAt(8, 1);
  const edgeAtOne = await page.evaluate(
    (c) => window.__measure(c.cx + c.PLOT * 0.35, c.cy, 6, c.PLOT * 0.2).max, center);
  if (edgeAtOne > 40) ok('1x is aggressive but does not wipe the stroke', `edge alpha ${edgeAtOne}`);
  else bad('1x is aggressive but does not wipe the stroke', `edge alpha ${edgeAtOne}`);
  await runAt(8, 12);

  await page.evaluate(() => {
    const el = document.querySelector('[data-set="blankRatio"]');
    el.value = '10';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(400);

  /* ---- the halo (光晕): a spot that grows with the dose ------------------
     The reference is a photo of a real analog scope: a thin trace with a big
     round flare exactly where the beam slowed down. So these assert the SHAPE of
     that law rather than "a slider exists":

       · the DOSE decides, not the slider — a constant-speed figure barely swells
         while a stationary beam reaches the cap;
       · the halo is still the spot: nothing appears beyond 3σ of the widest one,
         which is what keeps this a bigger beam and not a bloom pass;
       · and the row is honest about which renderer implements it. */
  const setSynth = (mode) => page.evaluate((m) => {
    window.__synthMode = m;
    window.__synthPoint = function (t) {
      const k = window.__synthMode;
      if (k === 'uniform') {                     // constant pixel speed: no dwell
        return [0.7 * Math.cos(t * Math.PI * 2), 0.7 * Math.sin(t * Math.PI * 2)];
      }
      if (k === 'stationary') return [0, 0];     // a beam that never moves
      if (t < 0.5) return [-0.6 + 1.2 * (t / 0.5), -0.5];        // a slow line
      return [-0.02 + 0.04 * ((t - 0.5) / 0.5), -0.5];           // ...then a creep
    };
  }, mode);
  const spotOf = () => page.evaluate(() => {
    const s = window.__scope.state;
    return { spot: s.spotMax, dose: s.doseMax };
  });
  const setCtl = (key, v) => page.evaluate(([k, val]) => {
    const el = document.querySelector(`[data-set="${k}"]`);
    el.value = String(val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, [key, v]);

  const isGL = (await page.evaluate(() => window.__scope.state.renderer)) === 'webgl2';
  const haloRow = await page.evaluate(() => {
    const el = document.querySelector('[data-set="halo"]');
    return {
      min: el.min, max: el.max, step: el.step, def: el.value,
      disabled: el.disabled, title: el.title,
      out: document.querySelector('[data-out="halo"]').textContent,
      residueOff: document.querySelector('[data-set="residue"]').disabled,
    };
  });
  if (haloRow.min === '0' && haloRow.max === '100' && haloRow.def === '0' && haloRow.out === '关') {
    ok('the halo control exists, defaults to off', `${haloRow.min}-${haloRow.max}, label 关`);
  } else {
    bad('the halo control exists, defaults to off', JSON.stringify(haloRow));
  }
  if (haloRow.disabled === !isGL) {
    ok('the halo row is enabled exactly where it works', `${isGL ? 'webgl2' : 'canvas2d'} → disabled=${haloRow.disabled}`);
  } else {
    bad('the halo row is enabled exactly where it works', JSON.stringify({ isGL, disabled: haloRow.disabled }));
  }
  /* The mirror image: 残留 scrubs an 8-bit floor the energy path does not have,
     so leaving THAT one live under WebGL is the same lie in reverse. */
  if (haloRow.residueOff === isGL) {
    ok('the residue row is enabled exactly where it works', `disabled=${haloRow.residueOff}`);
  } else {
    bad('the residue row is enabled exactly where it works', JSON.stringify({ isGL, disabled: haloRow.residueOff }));
  }

  /* The trigger is what makes the drawn window deterministic here: findTrigger
     shifts the start index, and a dwell that slid out of the drawn half of the
     buffer would silently turn these measurements into "nothing happened". */
  await page.evaluate(() => {
    const b = document.querySelector('[data-toggle="trigger"]');
    if (b && b.getAttribute('aria-pressed') === 'true') b.click();
  });

  await setCtl('halo', 0);
  await setSynth('uniform');
  await page.waitForTimeout(1500);
  const uni0 = await spotOf();
  await setSynth('stationary');
  await page.waitForTimeout(1500);
  const flat0 = await spotOf();

  await setCtl('halo', 100);
  await setSynth('uniform');
  await page.waitForTimeout(1500);
  const uni100 = await spotOf();
  await setSynth('stationary');
  await page.waitForTimeout(1500);
  const flat100 = await spotOf();
  const spotUniform0 = uni0.spot, spotFlat0 = flat0.spot;
  const spotUniform100 = uni100.spot, spotFlat100 = flat100.spot;

  /* The DOSES are where the dashes come from, so assert them directly: a beam
     that never moves must deposit orders of magnitude more per unit length than
     one sweeping at the mean speed. A display-sized floor in the denominator
     (PLOT x 0.0015 ≈ 1.7x the mean step of a 600 px plot, which is what this
     used to be) flattens that to ~2x, and the trace then renders as a uniformly
     bright web whose contrast comes only from self-overlap. */
  if (flat0.dose > 8 && uni0.dose > 0.5 && uni0.dose < 3) {
    ok('the 1/v dose is unbounded above the mean',
      `stationary x${flat0.dose.toFixed(0)} vs sweeping x${uni0.dose.toFixed(2)}`);
  } else {
    bad('the 1/v dose is unbounded above the mean',
      JSON.stringify({ stationary: flat0.dose, uniform: uni0.dose }));
  }
  if (Math.abs(flat100.dose - flat0.dose) < 1e-6) {
    ok('the dose does not depend on the halo slider', `x${flat100.dose.toFixed(0)}`);
  } else {
    bad('the dose does not depend on the halo slider', `${flat0.dose} vs ${flat100.dose}`);
  }

  if (isGL) {
    if (spotUniform0 === 1 && spotFlat0 === 1) {
      ok('光晕 0: the spot is exactly the line width', `uniform ${spotUniform0}, stationary ${spotFlat0}`);
    } else {
      bad('光晕 0: the spot is exactly the line width', `${spotUniform0} / ${spotFlat0}`);
    }
    if (spotFlat100 >= 11 && spotFlat100 > spotUniform100 * 3) {
      ok('光晕 follows the dose, not the slider',
        `stationary beam swells to x${spotFlat100} vs x${spotUniform100.toFixed(2)} at constant speed`);
    } else {
      bad('光晕 follows the dose, not the slider', `stationary ${spotFlat100}, uniform ${spotUniform100}`);
    }
    if (spotUniform100 > 1.1 && spotUniform100 < 2.5) {
      ok('an ordinary segment only softens a little', `x${spotUniform100.toFixed(2)} at 光晕 100`);
    } else {
      bad('an ordinary segment only softens a little', `x${spotUniform100}`);
    }
  } else {
    if (spotUniform100 === 1 && spotFlat100 === 1) {
      ok('Canvas path: the spot stays the line width (why the row is disabled)', 'x1 at 光晕 100');
    } else {
      bad('Canvas path: the spot stays the line width', `${spotUniform100} / ${spotFlat100}`);
    }
  }

  /* The halo must still be a spot: ink 10 px off the beam appears only with 光晕
     on, and 80 px off (past 3σ of the widest allowed swell) is black even at
     100 %. 3σ of sigma x12 at this device pixel ratio is ~31 px, so 80 px is a
     real bound rather than a number that happens to pass. */
  const inkAbove = (dy) => page.evaluate(([d, cx, cy, size]) => {
    const y = Math.round(cy + 0.25 * size - d);      // the line sits at cy + PLOT/4
    const x = Math.round(cx);
    const px = window.__scope.readTrace(x - 6, y - 6, 13, 13);
    let max = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > max) max = px[i];
    return max;
  }, [dy, center.cx, center.cy, center.PLOT]);

  await setSynth('line');
  await page.waitForTimeout(1800);
  const nearOn = await inkAbove(10);
  const farOn = await inkAbove(80);
  await setCtl('halo', 0);
  await page.waitForTimeout(1800);
  const nearOff = await inkAbove(10);

  if (isGL) {
    if (nearOn > 20 && nearOff === 0) {
      ok('the halo really is drawn around a dwelling beam', `10 px off the beam: ${nearOff} → ${nearOn}`);
    } else {
      bad('the halo really is drawn around a dwelling beam', `10 px: ${nearOff} off, ${nearOn} at 100`);
    }
    if (farOn === 0) {
      ok('the halo is still the spot, not a tail', '80 px off the beam: 0 even at 光晕 100');
    } else {
      bad('the halo is still the spot, not a tail', `80 px off the beam: ${farOn}`);
    }
  } else if (nearOn === 0 && farOn === 0) {
    ok('Canvas path: no halo at all, as the disabled row says', '10 px and 80 px off the beam: 0');
  } else {
    bad('Canvas path: no halo at all', `${nearOn} / ${farOn}`);
  }

  await page.evaluate(() => {
    const b = document.querySelector('[data-toggle="trigger"]');
    if (b && b.getAttribute('aria-pressed') === 'false') b.click();
  });

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

  /* ---- the accumulation layer survives a relayout ----------------------
     Assigning canvas.width clears the bitmap, so resizeKeeping has to carry the
     layer across or a window resize silently eats the picture. Paused, with a
     long afterglow and no hard scrub: otherwise this measures the music instead
     of the carry-over. */
  await page.evaluate(() => {
    const set = (k, v) => {
      const el = document.querySelector(`[data-set="${k}"]`);
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    document.getElementById('audio').pause();
    set('persistence', 100);
    set('residue', 40);          // keep the periodic scrub gentle between samples
  });
  await page.waitForTimeout(2500);
  /* Box-average the frame onto a fixed grid, through the seam: the viewport
     changes size between the two samples, so the grids have to match. */
  const sigOf = () => page.evaluate(() => {
    const c = window.__scope.state.canvas;
    const d = window.__scope.readTrace(0, 0, c.w, c.h);
    const TW = 256, TH = 160;
    const out = [];
    for (let ty = 0; ty < TH; ty++) {
      for (let tx = 0; tx < TW; tx++) {
        const x0 = Math.floor(tx * c.w / TW);
        const x1 = Math.max(x0 + 1, Math.floor((tx + 1) * c.w / TW));
        const y0 = Math.floor(ty * c.h / TH);
        const y1 = Math.max(y0 + 1, Math.floor((ty + 1) * c.h / TH));
        let sum = 0, n = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) { sum += d[(y * c.w + x) * 4 + 1]; n++; }
        }
        out.push(n ? sum / n : 0);
      }
    }
    return out;
  });

  const sigBefore = await sigOf();
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.waitForTimeout(1400);
  const sigAfter = await sigOf();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(1400);
  let sigSum = 0;
  for (let i = 0; i < sigBefore.length; i++) sigSum += Math.abs(sigBefore[i] - sigAfter[i]);
  const sigMean = sigSum / sigBefore.length;
  /* 8 rather than the 4 this used when it probed the burn-in ghost: the probe is
     now the live afterglow layer, which keeps converging towards saturation
     while paused. A layer actually eaten by the relayout is a delta of tens. */
  if (sigMean < 8) ok('layers survive a window resize', `mean pixel delta ${sigMean.toFixed(2)} / 255`);
  else bad('layers survive a window resize', `mean pixel delta ${sigMean.toFixed(2)} — the layer was eaten`);

  /* ---- residue: the 8-bit quantisation floor --------------------------- */
  /* destination-out multiplies alpha, so with round-to-nearest every value
     n <= 1/(2a) is a fixed point. A slow fade (high 余辉) therefore leaves a
     BRIGHTER permanent ghost, not a longer one. The 残留 slider scrubs it. */
  const ghostBand = () => page.evaluate(() => {
    const c = window.__scope.state.canvas;
    const d = window.__scope.readTrace(0, 0, c.w, c.h);
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8 && d[i] <= 64) n++;
    return +((n * 100) / (c.w * c.h)).toFixed(3);
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
  /* The floor is a property of an 8-bit backing store: `destination-out` rounds,
     so everything at or below 1/(2a) is a fixed point and never fades. The float
     accumulation buffer has no such value, which is the whole reason the energy
     path exists — so on that path the check is stated as its absence, and the
     residue slider is not asked to do anything. */
  const renderer = await page.evaluate(() => window.__scope.state.renderer);
  if (renderer === 'webgl2') {
    /* No floor to scrub. A float buffer decays as exp(-dt/τ) with no smallest
       representable value, so the 残留 slider changes nothing — and that is what
       gets asserted, by measuring the same run at 100 % and at 0 % and requiring
       them to agree. (An earlier version of this check looked for ink in the
       alpha 9-64 band and failed: that band is just legitimately dim afterglow,
       and while paused the frozen frame keeps being painted, so ink never
       disappears — the floor is not what that metric can see.) */
    if (Math.abs(ghostOn - ghostOff) < 1) {
      ok('the residue slider does nothing on the float path',
        `${ghostOn}% vs ${ghostOff}% with the slider at 100 % and 0 %`);
    } else {
      bad('the residue slider does nothing on the float path', `${ghostOn}% vs ${ghostOff}%`);
    }
  } else {
    if (ghostOn > 5) ok('residue 100% leaves a permanent ghost', `${ghostOn}% of the canvas at alpha 9-64`);
    else bad('residue 100% leaves a permanent ghost', `${ghostOn}%`);
    if (ghostOff < ghostOn / 10) {
      ok('residue off (default) wipes the quantisation floor', `${ghostOff}% vs ${ghostOn}%`);
    } else {
      bad('residue off (default) wipes the quantisation floor', `${ghostOff}% vs ${ghostOn}%`);
    }
  }
  await page.evaluate(() => document.getElementById('btnReset').click());
  await page.waitForTimeout(600);

  /* ---- the plot must sit dead centre --------------------------------
     A stray `grid-column: 2` on the toast conjured a second implicit grid
     column, which squeezed the stage and shoved the plot 74px left — visible
     to the eye but invisible to every other assertion here. */
  const centreOffset = () => page.evaluate(() => {
    const st = document.getElementById('stage').getBoundingClientRect();
    const s = window.__scope.state;
    const d = s.effectiveDpr;
    const cx = st.left + (s.plot.x + s.plot.size / 2) / d;
    const cy = st.top + (s.plot.y + s.plot.size / 2) / d;
    return {
      dx: +Math.abs(cx - innerWidth / 2).toFixed(1),
      dy: +Math.abs(cy - (st.top + st.height / 2)).toFixed(1),
      size: Math.round(s.plot.size / d),
    };
  });

  const centreClosed = await centreOffset();
  await page.evaluate(() => document.getElementById('btnSettings').click());
  await page.waitForTimeout(500);
  const centreOpen = await centreOffset();
  await page.evaluate(() => document.getElementById('btnSettings').click());
  await page.waitForTimeout(500);

  if (centreClosed.dx <= 1 && centreClosed.dy <= 1) {
    ok('plot is centred in the window', `off by ${centreClosed.dx}, ${centreClosed.dy} px`);
  } else {
    bad('plot is centred in the window', JSON.stringify(centreClosed));
  }
  if (centreOpen.dx <= 1 && centreOpen.dy <= 1) {
    ok('opening a panel does not move the plot', `off by ${centreOpen.dx} px, size ${centreOpen.size}px`);
  } else {
    bad('opening a panel does not move the plot', JSON.stringify(centreOpen));
  }

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

  /* ---- the theme colour must reach every translucent accent -----------
     `--accent` is swapped at runtime, so anything tinted by it has to be
     DERIVED from it. `.track.active` was not: its border read var(--accent)
     while its fill was a literal rgba() of the DEFAULT green, so picking a
     different colour left a green wash under a red outline. Same bug in the
     pressed toggles. Probe the computed paint, not the stylesheet text. */
  const accentPaint = () => page.evaluate(() => {
    /* Chrome serialises a color-mix() result as `color(srgb 1 0.41 0.54 / 0.07)`
       rather than rgba(), so both forms have to be understood — a parser that
       only knew rgb() would report "0 tinted elements" and quietly turn this
       check into a no-op. */
    const parse = (s) => {
      const str = String(s);
      const srgb = str.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+))?\)$/);
      if (srgb) {
        return {
          r: Math.round(parseFloat(srgb[1]) * 255),
          g: Math.round(parseFloat(srgb[2]) * 255),
          b: Math.round(parseFloat(srgb[3]) * 255),
          a: srgb[4] === undefined ? 1 : parseFloat(srgb[4]),
        };
      }
      const m = str.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    /* Resolve the custom property through a real property: getPropertyValue on
       a custom property hands back the raw token, '#7ef9ff', not channels. */
    const probe = document.createElement('span');
    probe.style.color = 'var(--accent)';
    document.body.appendChild(probe);
    const accent = parse(getComputedStyle(probe).color);
    probe.remove();

    const sample = (sel, prop) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      const paint = prop === 'border' ? cs.borderBottomColor : cs.backgroundColor;
      return { sel, ...(parse(paint) || { r: -1, g: -1, b: -1, a: 0 }) };
    };

    /* Every target is required: a selector that stops matching would otherwise
       shrink the sample silently instead of failing. */
    const wanted = [
      ['.track.active', 'background'],
      ['.pills [aria-pressed="true"]', 'background'],
      ['.link', 'border'],
    ];
    const parts = [];
    const missing = [];
    for (const [sel, prop] of wanted) {
      const s = sample(sel, prop);
      if (s && s.a > 0) parts.push(s);
      else missing.push(sel);
    }
    return { accent, parts, missing };
  });

  const offColour = async (hex) => {
    await page.evaluate((c) => {
      const el = document.querySelector('[data-set="color"]');
      el.value = c;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, hex);
    await page.waitForTimeout(250);
    return accentPaint();
  };

  const themeRed = await offColour('#ff6b8a');
  const themeGreen = await offColour('#3dff9c');
  await page.evaluate(() => document.getElementById('btnReset').click());
  await page.waitForTimeout(300);

  const mismatched = (probe) => probe.parts.filter((p) => (
    Math.abs(p.r - probe.accent.r) > 1
    || Math.abs(p.g - probe.accent.g) > 1
    || Math.abs(p.b - probe.accent.b) > 1
  ));

  const themeLabel = 'selected track / toggle fills follow the theme colour';
  if (themeRed.missing.length === 0) {
    const wrong = mismatched(themeRed);
    if (wrong.length === 0) {
      ok(themeLabel, `${themeRed.parts.length} fills tinted rgb(${themeRed.accent.r},${themeRed.accent.g},${themeRed.accent.b}) — ${themeRed.parts.map((p) => p.sel).join(', ')}`);
    } else {
      bad(themeLabel,
        wrong.map((p) => `${p.sel} stayed rgb(${p.r},${p.g},${p.b}) while the accent is rgb(${themeRed.accent.r},${themeRed.accent.g},${themeRed.accent.b})`).join(' | '));
    }
  } else {
    bad(themeLabel, `no tinted paint found on ${themeRed.missing.join(', ')}`);
  }

  /* Control: with the default green the fill and the accent must still agree,
     so the check above is not passing merely because nothing is painted. */
  const controlLabel = 'control: same fills still track the default green';
  if (themeGreen.missing.length === 0 && mismatched(themeGreen).length === 0) {
    ok(controlLabel, `${themeGreen.parts.length} fills`);
  } else {
    bad('control: same fills still track the default green', JSON.stringify(themeGreen.parts));
  }

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


/* -------------------------------------------------- no-WebGL fallback test */

/** A machine with WebGL switched off must still get a working scope, not an
 *  empty graticule. Chromium can be told to refuse it, which is the one case the
 *  rest of the suite cannot reach — everywhere else the renderer is chosen
 *  because the hardware said yes. */
async function webglAbsentTest(pw) {
  section('Render layer — WebGL unavailable');

  const browser = await pw.chromium.launch({
    executablePath: findChromium(),
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-sandbox', '--disable-webgl'],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message.split('\n')[0]));

  await page.goto(`${BASE}/?track=0`);
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const a = document.getElementById('audio');
    a.currentTime = 20;
    if (a.paused) document.getElementById('btnPlay').click();
  });
  await page.waitForTimeout(6000);

  const r = await page.evaluate(() => {
    const s = window.__scope.state;
    const c = s.canvas;
    const d = window.__scope.readTrace(0, 0, c.w, c.h);
    let lit = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 24) lit++;
    const probe = document.createElement('canvas').getContext('webgl2');
    return { renderer: s.renderer, lit, webgl2: !!probe };
  });

  if (r.webgl2) {
    ok('WebGL is actually absent in this browser', 'skipped — --disable-webgl had no effect here');
  } else if (r.renderer === 'canvas2d') {
    ok('falls back to Canvas-2D when WebGL is unavailable', 'no WebGL2 context offered');
  } else {
    bad('falls back to Canvas-2D when WebGL is unavailable', `renderer=${r.renderer}`);
  }
  if (r.lit > 200) ok('the fallback still draws a trace', `${r.lit} lit pixels`);
  else bad('the fallback still draws a trace', `${r.lit} lit pixels`);
  if (errors.length === 0) ok('no runtime errors without WebGL');
  else bad('no runtime errors without WebGL', errors.slice(0, 2).join(' | '));

  await browser.close();
}

/* ------------------------------------------------------------ presets test */

/* Presets are the one feature whose state outlives the tab, so the checks that
   matter are the ones a unit test cannot see: that applying one moves the real
   controls (not just the numbers behind them), that it survives a reload, that
   an imported value the slider cannot express gets clamped instead of making
   the readout lie, and that the two modes do what they say. */
async function presetTests(pw) {
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

/* `--only=presets` runs just the sections whose key matches, so iterating on
   one feature costs seconds instead of a full pass. Section keys: port, http,
   render, presets, resample, standalone. A filtered run says so in the summary
   — a partial result must never be able to pass itself off as a full one. */
const ONLY = (() => {
  const eq = process.argv.find((a) => a.startsWith('--only='));
  const i = process.argv.indexOf('--only');
  const raw = eq ? eq.slice('--only='.length) : (i >= 0 ? process.argv[i + 1] : '');
  return String(raw || '').trim().toLowerCase();
})();
const wants = (key) => !ONLY || key.includes(ONLY) || ONLY.includes(key);

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  console.log(`\n\x1b[1m◉ oscilloscope music player — verification\x1b[0m  \x1b[2m(node ${process.version})\x1b[0m`);

  PORT = await pickPort();
  BASE = `http://127.0.0.1:${PORT}`;

  const server = await startServer();
  try {
    if (wants('port')) {
      defaultPortTests();
      await portRetryTest();
    }
    if (wants('http')) await httpTests();

    const browser = ['render', 'presets', 'resample', 'standalone'].filter(wants);
    const pw = browser.length ? loadPlaywright() : null;
    if (browser.length && !pw) {
      section('Render layer');
      console.log('  \x1b[33m•\x1b[0m Playwright not found — skipping browser checks.');
      console.log('    \x1b[2minstall with: npm i -g playwright\x1b[0m');
    } else if (pw) {
      if (wants('render')) {
        await renderTests(pw);
        await renderTests(pw, '?renderer=2d');
        await webglAbsentTest(pw);
      }
      if (wants('presets')) await presetTests(pw);
      if (wants('resample')) await resampleTests(pw);
      if (wants('standalone')) await standaloneTests(pw);
    }
  } finally {
    server.child.kill('SIGKILL');
  }

  console.log(`\n\x1b[1mresult\x1b[0m  \x1b[32m${pass} passed\x1b[0m` + (fail ? `, \x1b[31m${fail} failed\x1b[0m` : '')
    + (ONLY ? `  \x1b[33m(filtered: --only=${ONLY} — this is NOT a full-suite result)\x1b[0m` : ''));
  if (fail) {
    console.log('\n' + failures.map((f) => '  \x1b[31m✗\x1b[0m ' + f).join('\n'));
  }
  console.log(`  \x1b[2mscreenshots: ${path.relative(process.cwd(), SHOTS)}/\x1b[0m\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('\n\x1b[31mverification crashed:\x1b[0m', err);
  process.exit(2);
});
