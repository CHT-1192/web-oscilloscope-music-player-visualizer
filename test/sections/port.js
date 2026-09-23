#!/usr/bin/env node
'use strict';

/* ============================================================================
    test/sections/port.js — the listen port.

    The port is not a cosmetic choice: it decides whether `node server.js` just
    works. These checks keep the constant, the help text and the boot path from
    drifting apart, pin the one property that matters (the default must not be
    the number every other dev server already took), and prove that a taken port
    walks forward instead of dying.
   ========================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');
const h = require('../harness.js');
const { ok, bad, section, sleep, get, ROOT } = h;

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
  const PORT = h.state.port;
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


module.exports = { defaultPortTests, portRetryTest };
