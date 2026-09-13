#!/usr/bin/env node
'use strict';

/* ============================================================================
 *  test/bench.js — where does the time actually go?
 *
 *  Three complementary numbers, because each one alone is misleading:
 *
 *    main%   CDP Performance.getMetrics TaskDuration — the renderer main thread.
 *            This is where the JS and canvas work lands.
 *    total%  Cumulative CPU of the WHOLE browser process tree (ps -o time).
 *            This catches the audio decode / resample threads, the GPU process
 *            and compositing — everything the main-thread metric misses. It is
 *            the number that predicts whether a slow machine copes.
 *    work ms The app's own measured render-loop time (fade + trace), which is
 *            far less noisy than any process-level sampling.
 *
 *  Every config is sandwiched between two baseline measurements inside ONE
 *  browser session: launching a fresh browser per config added more noise than
 *  most of the effects being measured.
 *
 *    node test/bench.js
 * ========================================================================== */

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { spawn, execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 8300 + (process.pid % 500);
const BASE = `http://127.0.0.1:${PORT}`;
const SAMPLE_S = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadPlaywright() {
  for (const t of ['playwright', 'playwright-core']) {
    try { return require(t); } catch { /* next */ }
  }
  const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
  for (const t of ['playwright', 'playwright-core']) {
    try { return require(path.join(root, t)); } catch { /* next */ }
  }
  return null;
}
const findChromium = () => [
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => fs.existsSync(p));

async function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(PORT)],
    { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    try {
      await new Promise((res, rej) => {
        http.get(`${BASE}/api/health`, (r) => { r.resume(); res(r.statusCode); }).on('error', rej);
      });
      return child;
    } catch { /* not up */ }
  }
  throw new Error('server did not start');
}

/** Cumulative CPU seconds of a process and all its descendants.
 *  NOTE: `ps` is blocked in some sandboxes, so we fall back to system-wide
 *  CPU deltas from os.cpus(), which needs no special permission. */
let cpuProbeMode = 'ps';

function osCpuTimes() {
  let busy = 0, total = 0;
  for (const c of require('node:os').cpus()) {
    const t = c.times;
    const all = t.user + t.nice + t.sys + t.idle + t.irq;
    busy += t.user + t.nice + t.sys + t.irq;
    total += all;
  }
  return { busy, total };
}

function treeCpu(rootPid) {
  if (cpuProbeMode === 'none') return null;
  try {
    const out = execSync('ps -Ao pid=,ppid=,time=', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const procs = new Map();
    const kids = new Map();
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d:.]+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      procs.set(pid, parseCpuTime(m[3]));
      if (!kids.has(Number(m[2]))) kids.set(Number(m[2]), []);
      kids.get(Number(m[2])).push(pid);
    }
    let total = 0;
    const stack = [rootPid];
    const seen = new Set();
    while (stack.length) {
      const pid = stack.pop();
      if (seen.has(pid)) continue;
      seen.add(pid);
      if (procs.has(pid)) total += procs.get(pid);
      for (const c of kids.get(pid) || []) stack.push(c);
    }
    return total;
  } catch (err) {
    cpuProbeMode = 'none';
    return null;
  }
}

function parseCpuTime(s) {
  const p = s.split(':').map(Number);
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 60 + p[1];
  return p[0] || 0;
}

const FRAME_COUNTER = `
  window.__frames = 0;
  const _raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => _raf((t) => { window.__frames++; return cb(t); });
`;

const CONFIGS = [
  { label: 'control (no change)', control: true },
  { label: 'win 32768 (max)', windowIdx: 6 },
  { label: 'win 8192', windowIdx: 4 },
  { label: 'win 1024', windowIdx: 1 },
  { label: 'renderScale 50%', renderScale: '0.5' },
  { label: 'renderScale 75%', renderScale: '0.75' },
  { label: 'persistence 0%', persistence: 0 },
  { label: 'grid OFF', grid: false },
  { label: 'blanking OFF', blanking: false },
  { label: 'engine 48 kHz (resampled)', rateMode: 'device' },
  { label: 'burn-in 100% (permanent)', burnIn: 100 },
  { label: 'burn-in 60% (decaying)', burnIn: 60 },
];

/** Shorter list for the under-load run, which is mostly a methodology check. */
const CONFIGS_QUICK = [
  { label: 'win 32768 (max)', windowIdx: 6 },
  { label: 'win 1024', windowIdx: 1 },
  { label: 'engine 48 kHz (resampled)', rateMode: 'device' },
  { label: 'burn-in 100% (permanent)', burnIn: 100 },
  { label: 'burn-in 60% (decaying)', burnIn: 60 },
];

/** Background CPU burners, to emulate "I'm running a compile". */
function startLoad(n) {
  if (!n) return { stop: () => {} };
  const script = 'let x = 1; const t = Date.now(); while (Date.now() - t < 600000) { x += Math.sqrt(x % 97); }';
  const kids = [];
  for (let i = 0; i < n; i++) {
    kids.push(spawn(process.execPath, ['-e', script], { stdio: 'ignore' }));
  }
  return { stop: () => kids.forEach((k) => k.kill('SIGKILL')) };
}

async function main() {
  const args = process.argv.slice(2);
  const loadN = Number((args.find((a) => a.startsWith('--load=')) || '').split('=')[1]) || 0;
  const only = (args.find((a) => a.startsWith('--only=')) || '').split('=')[1] || '';
  const configs = (loadN ? CONFIGS_QUICK : CONFIGS).filter((c) => !only || c.label.includes(only));
  const sampleSeconds = loadN ? 6 : SAMPLE_S;

  const pw = loadPlaywright();
  if (!pw) { console.error('Playwright not found'); process.exit(1); }
  const server = await startServer();
  const load = startLoad(loadN);
  if (loadN) console.log(`\n\x1b[33m+ ${loadN} background CPU burners running for the whole run\x1b[0m`);

  const browserServer = await pw.chromium.launchServer({
    executablePath: findChromium(),
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-sandbox'],
  });
  const browserPid = browserServer.process().pid;
  const browser = await pw.chromium.connect(browserServer.wsEndpoint());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await page.addInitScript(FRAME_COUNTER);
  const client = await page.context().newCDPSession(page);
  await client.send('Performance.enable');

  await page.goto(`${BASE}/?track=1`, { waitUntil: 'load' });
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const a = document.getElementById('audio');
    a.currentTime = 10;
    if (a.paused) document.getElementById('btnPlay').click();
  });
  await page.waitForTimeout(2500);

  const resetTo = (cfg) => page.evaluate((c) => {
    document.getElementById('btnReset').click();
    if (c.rateMode) window.__scope.setRateMode(c.rateMode);
    const set = (k, v) => {
      const el = document.querySelector(`[data-set="${k}"]`);
      if (el) { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }
    };
    if (c.windowIdx != null) set('windowIdx', c.windowIdx);
    if (c.persistence != null) set('persistence', c.persistence);
    if (c.lineWidth != null) set('lineWidth', c.lineWidth);
    if (c.burnIn != null) set('burnIn', c.burnIn);
    if (c.renderScale) {
      const s = document.getElementById('renderScale');
      s.value = c.renderScale;
      s.dispatchEvent(new Event('change', { bubbles: true }));
    }
    for (const t of ['blanking', 'grid', 'beamDot']) {
      if (c[t] == null) continue;
      const b = document.querySelector(`[data-toggle="${t}"]`);
      if (b && (b.getAttribute('aria-pressed') === 'true') !== c[t]) b.click();
    }
  }, cfg);

  const sample = async () => {
    // Rewind to a fixed position first: render cost depends on how dense the
    // music is, so measuring different sections of the track made the baseline
    // drift by 2x across a run. Every sample now covers the same audio.
    await page.evaluate(() => {
      const a = document.getElementById('audio');
      try { a.currentTime = 10; } catch (e) { /* ignore */ }
    });
    await sleep(900);
    // Drop stale frames from before this config so the window describes only
    // the configuration being measured.
    await page.evaluate(() => window.__scope.resetWorkStats());
    const m0 = await client.send('Performance.getMetrics');
    const ps0 = treeCpu(browserPid);
    const os0 = osCpuTimes();
    const t0 = Date.now();
    await page.waitForTimeout(sampleSeconds * 1000);
    const wall = (Date.now() - t0) / 1000;
    const m1 = await client.send('Performance.getMetrics');
    const ps1 = treeCpu(browserPid);
    const os1 = osCpuTimes();
    const st = await page.evaluate(() => window.__scope.state);
    const get = (m, k) => (m.metrics.find((x) => x.name === k) || {}).value || 0;
    const sys = ((os1.busy - os0.busy) / (os1.total - os0.total)) * 100;
    return {
      main: ((get(m1, 'TaskDuration') - get(m0, 'TaskDuration')) / wall) * 100,
      total: (ps1 != null && ps0 != null) ? ((ps1 - ps0) / wall) * 100 : sys,
      sys,
      workMs: st.workMs,
      work: st.work,
      canvas: `${st.canvas.w}x${st.canvas.h}`,
      analyser: st.analyserSize,
    };
  };

  console.log(`\n\x1b[1mbenchmark\x1b[0m  ${sampleSeconds}s per sample, baseline interleaved, one browser session\n`);
  console.log('  work* = the app\'s OWN render-loop time. Chrome quantises its clock to 100 us,');
  console.log('  \x1b[2mso no single frame is meaningful; "trim25" is the mean of the fastest quarter\x1b[0m');
  console.log('  \x1b[2mof a 240-frame window — sub-quantum accurate AND immune to a right tail, which\x1b[0m');
  console.log('  \x1b[2mis the only shape background load can add. sys% is a contamination guard.\x1b[0m\n');
  console.log('  config                         main%  trim25  trim50   p95    sys%   base sys%');
  console.log('  ' + '-'.repeat(80));

  const line = (tag, r, extra) => console.log(
    `  ${tag.padEnd(30)} ${r.main.toFixed(1).padStart(6)} ${r.work.trimmed.toFixed(3).padStart(7)} ${r.work.trimmed50.toFixed(3).padStart(7)} ${r.work.p95.toFixed(2).padStart(6)} ${r.sys.toFixed(1).padStart(7)}${extra || ''}`
  );

  const base = async (tag) => {
    await resetTo({});
    await sleep(1500);
    const r = await sample();
    line(tag, r);
    return r;
  };

  const rows = [];
  try {
    await base('BASELINE #0');
    for (const cfg of configs) {
      await resetTo(cfg);
      await sleep(1500);
      const r = await sample();
      const b = await base(`base around "${cfg.label}"`.slice(0, 30));
      const dm = ((r.main - b.main) / b.main) * 100;
      const dp50 = ((r.work.trimmed50 - b.work.trimmed50) / b.work.trimmed50) * 100;
      const dmin = ((r.work.trimmed - b.work.trimmed) / b.work.trimmed) * 100;
      const dsys = r.sys - b.sys;
      rows.push({ cfg, dm, dp50, dmin, dsys, r, b });
      line(cfg.label, r, ` ${b.sys.toFixed(1).padStart(9)}   \x1b[2mtrim25 ${dmin >= 0 ? '+' : ''}${dmin.toFixed(0)}%\x1b[0m${Math.abs(dsys) > 5 ? ' \x1b[33m<bg load moved>\x1b[0m' : ''}`);
    }
    await base('BASELINE #end');
  } finally {
    await browser.close();
    await browserServer.close();
    server.kill('SIGKILL');
    load.stop();
  }

  console.log('\n  summary — ranked by trim25 (mean of fastest quarter), the load-proof metric:');
  for (const { cfg, dm, dp50, dmin, dsys, r } of rows.slice().sort((a, b) => a.dmin - b.dmin)) {
    console.log(`    ${cfg.label.padEnd(30)} trim25 ${dmin >= 0 ? '+' : ''}${dmin.toFixed(0).padStart(4)}%   trim50 ${dp50 >= 0 ? '+' : ''}${dp50.toFixed(0).padStart(4)}%   main ${dm >= 0 ? '+' : ''}${dm.toFixed(0).padStart(4)}%   \x1b[2m(abs: ${r.work.trimmed.toFixed(3)} ms)\x1b[0m${Math.abs(dsys) > 5 ? ' \x1b[33m(bg load moved ' + dsys.toFixed(1) + 'pp)\x1b[0m' : ''}`);
  }
  console.log();
}

main().catch((e) => { console.error(e); process.exit(1); });
