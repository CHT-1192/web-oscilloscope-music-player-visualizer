#!/usr/bin/env node
'use strict';

/* ============================================================================
    test/harness.js — everything the sections share.

    Assertions and their counters, the tiny HTTP client, the server launcher and
    the Playwright / Chromium discovery. The checks themselves live in
    test/sections/ and are sequenced by test/verify.js, which also allocates the
    port before any of them runs.

    PORT and BASE are exposed as getters rather than as values: they are set
    after this module is loaded, so a copy taken at require time would still be
    0/''. A section reads them into a local where it needs them:

        async function someTests() { const BASE = h.base; ... }
   ========================================================================== */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(__dirname, 'shots');

/* Allocated, not guessed. `8000 + pid % 900` could collide with a server left
   behind by an earlier run, and the failure was nasty: the harness then talked
   to that STALE server, which answered /api/health happily and reported the
   previous build's parses — so a real regression looked like a flaky value. */

const state = { port: 0, base: '', pass: 0, fail: 0, failures: [] };

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

/* ------------------------------------------------------------- assertions */

function ok(name, detail) {
  state.pass++;
  console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
}
function bad(name, detail) {
  state.fail++;
  state.failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
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
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(state.port)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });

  for (let i = 0; i < 60; i++) {
    await sleep(100);
    try {
      const r = await get(`${state.base}/api/health`);
      if (r.status === 200) return { child, log: () => out };
    } catch { /* not up yet */ }
  }
  child.kill();
  throw new Error('server did not start:\n' + out);
}

module.exports = {
  ROOT, SHOTS, state, pickPort, ok, bad, section, sleep, get, externalProbe,
  loadPlaywright, findChromium, startServer,
  get port() { return state.port; },
  get base() { return state.base; },
};
