#!/usr/bin/env node
'use strict';

/* ============================================================================
    Web Oscilloscope Music Player / Visualizer  —  Node.js server

    Zero dependencies. Pure `node:http` + `node:fs`.

      node server.js                 # http://127.0.0.1:10240
      node server.js --port 3000
      node server.js --open          # open the browser automatically
      node server.js --host 0.0.0.0  # expose on the LAN

    Routes
      GET /                 -> public/index.html  (the app)
      GET /standalone       -> oscilloscope-standalone.html (single-file build)
      GET /api/tracks       -> JSON playlist of audio files found in the project
      GET|HEAD /media/<name> -> audio stream with HTTP Range support (seeking)

    Range support matters here: the bundled FLAC is 283 MB, so the browser must
    be able to seek without downloading the whole thing.
   ========================================================================== */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { exec } = require('node:child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');

/**
   Default listen port.

   Deliberately NOT 8080: that one is claimed by half the dev servers, proxies
   and appliances in existence, so "the default" and "the port already in use"
   were the same number far too often. 10240 sits in the registered range, well
   clear of the 49152+ ephemeral band the OS hands out to outgoing sockets, and
   it happens to be 10 × 1024 — this project's signature sample window.
   Override with `--port <n>` or the PORT environment variable.
*/
const DEFAULT_PORT = 10240;

/** Directories scanned for playable audio (project root + ./media if present). */
const MEDIA_DIRS = [ROOT, path.join(ROOT, 'media')];

const AUDIO_EXT = new Set([
  '.wav', '.wave', '.flac', '.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus',
  '.weba', '.webm', '.aif', '.aiff', '.caf',
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.wav': 'audio/wav',
  '.wave': 'audio/wav',
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.webm': 'audio/webm',
  '.weba': 'audio/webm',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.caf': 'audio/x-caf',
};

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

/* ------------------------------------------------------------------ helpers */

function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function send(res, status, headers, body) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  if (body === undefined) res.end();
  else res.end(body);
}

function sendJSON(res, status, obj) {
  send(res, status, { 'Content-Type': MIME['.json'] }, JSON.stringify(obj));
}

/** Human readable byte size. */
function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return null;
  const t = Math.round(sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/* ------------------------------------------------- audio header inspection */
/* Enough parsing to show duration / sample rate / channels in the playlist
   without decoding a single audio frame: WAV, FLAC and the MP4 family (m4a —
   AAC or ALAC). Others report nothing, and the app then runs at the device
   rate, which means resampling.

   Why bother for a container whose codec the browser may refuse anyway: the
   sample rate is what decides whether the ANALYSIS path resamples, and that is
   this project's whole premise. A browser that cannot decode ALAC still cannot,
   but a browser that can (Safari) then gets it at its native rate. */

function readBitsBE(buf, bitOffset, bitCount) {
  let out = 0n;
  for (let i = 0; i < bitCount; i++) {
    const bit = bitOffset + i;
    const byte = buf[bit >> 3];
    if (byte === undefined) return null;
    out = (out << 1n) | BigInt((byte >> (7 - (bit & 7))) & 1);
  }
  return out;
}

function probeWav(buf) {
  if (buf.length < 44) return null;
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return null;
  let off = 12;
  let fmt = null;
  let dataSize = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataSize = size;
      break;
    }
    off = body + size + (size % 2); // chunks are word aligned
  }
  if (!fmt || !fmt.sampleRate || !fmt.channels) return null;
  const bytesPerSec = fmt.sampleRate * fmt.channels * (fmt.bits / 8);
  const duration = dataSize != null && bytesPerSec > 0 ? dataSize / bytesPerSec : null;
  return { ...fmt, duration };
}

function probeFlac(buf) {
  if (buf.length < 42) return null;
  if (buf.toString('latin1', 0, 4) !== 'fLaC') return null;
  // first metadata block must be STREAMINFO (type 0), 34 bytes, at offset 8
  const blockType = buf[4] & 0x7f;
  const blockLen = buf.readUIntBE(5, 3);
  if (blockType !== 0 || blockLen < 34 || buf.length < 8 + 34) return null;
  const si = buf.subarray(8, 42);
  const sampleRate = readBitsBE(si, 80, 20);
  const channels = readBitsBE(si, 100, 3);
  const bps = readBitsBE(si, 103, 5);
  const totalSamples = readBitsBE(si, 108, 36);
  if (sampleRate === null) return null;
  return {
    sampleRate: Number(sampleRate),
    channels: Number(channels) + 1,
    bits: Number(bps) + 1,
    duration: Number(sampleRate) > 0 ? Number(totalSamples) / Number(sampleRate) : null,
  };
}

/** mp4 / m4a / mov. The rate, channel count and bit depth live in the audio
 *  sample entry inside moov > trak > mdia > minf > stbl > stsd, and the duration
 *  in mvhd. Unlike WAV and FLAC there is no fixed header: moov is often at the
 *  END of the file (anything written mdat-first, which is ffmpeg's default), so
 *  the caller hands us a tail slice as well when the head does not contain it.
 *
 *  For ALAC the generic sample-entry fields are not enough — the rate there is
 *  16.16 fixed point (nothing above 65535 Hz fits) and the depth field is only a
 *  hint. The codec's own 36-byte config box carries the truth, so it wins. */
function probeMp4(head, tail) {
  if (head.length < 12 || head.toString('latin1', 4, 8) !== 'ftyp') return null;
  const chunks = tail && tail.length ? [head, tail] : [head];
  const out = { sampleRate: 0, channels: 0, bits: 0, codec: null, duration: null };

  for (const buf of chunks) {
    const find = (s, from) => buf.indexOf(s, from || 0, 'latin1');

    // ALAC codec-specific config:
    // [size=36]['alac'][ver/flags][frameLength][compatibleVersion][bitDepth]
    // [pb][mb][kb][numChannels][maxRun][maxFrameBytes][avgBitRate][sampleRate]
    for (let i = find('alac'); i >= 4 && i + 32 <= buf.length; i = find('alac', i + 1)) {
      if (buf.readUInt32BE(i - 4) !== 36) continue;
      out.codec = 'ALAC';
      out.bits = buf[i + 13];
      out.channels = buf[i + 17];
      out.sampleRate = buf.readUInt32BE(i + 28);
      break;
    }

    // Generic audio sample entry:
    // [size][4cc][reserved 6][dataRefIdx 2][version 2][revision 2][vendor 4]
    // [channels 2][sampleSize 2][compressionId 2][packetSize 2][rate 16.16]
    if (!out.sampleRate) {
      for (const cc of ['mp4a', 'alac']) {
        for (let i = find(cc); i >= 4 && i + 32 <= buf.length; i = find(cc, i + 1)) {
          const clean = buf.readUInt32BE(i + 4) === 0 && buf.readUInt16BE(i + 8) === 0;
          const rate = buf.readUInt32BE(i + 28) >>> 16;
          const ch = buf.readUInt16BE(i + 20);
          if (!clean || rate < 8000 || rate > 384000 || ch < 1 || ch > 8) continue;
          out.codec = cc === 'mp4a' ? 'AAC' : 'ALAC';
          out.sampleRate = rate;
          out.channels = ch;
          // "bit depth" is only meaningful for the lossless one; reporting 16
          // for AAC would imply the source was 16-bit, which nothing says.
          if (cc === 'alac') out.bits = out.bits || buf.readUInt16BE(i + 22);
          break;
        }
        if (out.sampleRate) break;
      }
    }

    // mvhd: [ver/flags][created][modified][timescale][duration] — version 1
    // widens the last four to 64 bits
    const mi = find('mvhd');
    if (out.duration == null && mi >= 0) {
      const v = buf[mi + 4];
      const ts = v === 1 ? buf.readUInt32BE(mi + 24) : buf.readUInt32BE(mi + 16);
      const dur = v === 1 ? Number(buf.readBigUInt64BE(mi + 28)) : buf.readUInt32BE(mi + 20);
      if (ts > 0 && dur > 0) out.duration = dur / ts;
    }

    if (out.sampleRate && out.duration != null) break;
  }

  if (!out.sampleRate) return null;
  if (!out.channels) out.channels = 2;
  return out;
}

async function probeAudio(absPath, size) {
  let fh = null;
  try {
    fh = await fsp.open(absPath, 'r');
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, 0);
    const head = buf.subarray(0, bytesRead);
    const direct = probeWav(head) || probeFlac(head);
    if (direct) return direct;

    if (head.length >= 12 && head.toString('latin1', 4, 8) === 'ftyp') {
      let tail = null;
      if (head.indexOf('moov', 0, 'latin1') < 0 && size > head.length) {
        const tailLen = Math.min(size - head.length, 1024 * 1024);
        const tb = Buffer.alloc(tailLen);
        const { bytesRead: got } = await fh.read(tb, 0, tailLen, size - tailLen);
        tail = tb.subarray(0, got);
      }
      return probeMp4(head, tail);
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/* ---------------------------------------------------------------- playlist */

/** Scan the media directories for playable audio. Not recursive by design. */
async function scanTracks() {
  const seen = new Set();
  const out = [];

  for (const dir of MEDIA_DIRS) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // ./media does not exist — fine
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (e.name.startsWith('.')) continue;
      if (!AUDIO_EXT.has(path.extname(e.name).toLowerCase())) continue;
      if (seen.has(e.name)) continue;
      seen.add(e.name);

      const abs = path.join(dir, e.name);
      let st;
      try { st = await fsp.stat(abs); } catch { continue; }

      const info = await probeAudio(abs, st.size);
      out.push({
        name: e.name,
        url: `/media/${encodeURIComponent(e.name)}`,
        size: st.size,
        sizeText: fmtBytes(st.size),
        mtime: st.mtimeMs,
        format: path.extname(e.name).slice(1).toUpperCase(),
        codec: info?.codec ?? null,
        sampleRate: info?.sampleRate ?? null,
        channels: info?.channels ?? null,
        bits: info?.bits || null,   // 0 means "not applicable", not "zero bits"
        duration: info?.duration ?? null,
        durationText: fmtTime(info?.duration),
      });
    }
  }

  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return out;
}

/** Resolve `<name>` against the scanned playlist only — no path traversal. */
async function resolveMedia(name) {
  const wanted = path.basename(name); // strips any directory component
  for (const dir of MEDIA_DIRS) {
    const abs = path.join(dir, wanted);
    try {
      const st = await fsp.stat(abs);
      if (st.isFile()) return { abs, size: st.size };
    } catch { /* keep looking */ }
  }
  return null;
}

/* ------------------------------------------------------------ file serving */

function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;

  let start;
  let end;
  if (a === '') {
    const suffix = Number(b);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Number(b);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return { unsatisfiable: true };
  return { start, end: Math.min(end, size - 1) };
}

function streamFile(req, res, abs, { contentType, cache = 'no-store', download = false } = {}) {
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');
  }
  if (st.isDirectory()) {
    return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');
  }

  const size = st.size;
  const type = contentType || mimeFor(abs);
  const base = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': cache,
    'Last-Modified': st.mtime.toUTCString(),
  };
  if (download) base['Content-Disposition'] = `attachment; filename="${path.basename(abs)}"`;

  // HEAD and zero-length files
  if (req.method === 'HEAD') {
    return send(res, 200, { ...base, 'Content-Length': String(size) });
  }
  if (size === 0) {
    return send(res, 200, { ...base, 'Content-Length': '0' });
  }

  const range = parseRange(req.headers.range, size);
  if (range && range.unsatisfiable) {
    return send(res, 416, { ...base, 'Content-Range': `bytes */${size}` });
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const length = end - start + 1;

  const headers = { ...base, 'Content-Length': String(length) };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;

  res.writeHead(range ? 206 : 200, headers);

  const stream = fs.createReadStream(abs, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

/** Serve a path from public/ with traversal protection. */
function serveStatic(req, res, urlPath, fallback) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Bad request');
  }
  rel = rel.replace(/^\/+/, '');
  const abs = path.resolve(PUBLIC_DIR, rel || fallback || 'index.html');
  if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + path.sep)) {
    return send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Forbidden');
  }

  let st;
  try { st = fs.statSync(abs); } catch { return false; }

  if (st.isDirectory()) {
    return serveStatic(req, res, path.posix.join('/', rel, 'index.html'), fallback);
  }
  streamFile(req, res, abs, { cache: 'no-cache' });
  return true;
}

/* -------------------------------------------------------------------- app */

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' }, 'Method Not Allowed');
  }

  // ---- API ---------------------------------------------------------------
  if (pathname === '/api/tracks') {
    const tracks = await scanTracks();
    return sendJSON(res, 200, { tracks, root: ROOT });
  }

  if (pathname === '/api/health') {
    return sendJSON(res, 200, { ok: true, uptime: process.uptime() });
  }

  // ---- media -------------------------------------------------------------
  if (pathname.startsWith('/media/')) {
    const raw = pathname.slice('/media/'.length);
    let name;
    try { name = decodeURIComponent(raw); } catch { name = raw; }
    const found = await resolveMedia(name);
    if (!found) {
      return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Audio not found');
    }
    return streamFile(req, res, found.abs, { cache: 'public, max-age=3600' });
  }

  // ---- single-file build -------------------------------------------------
  if (pathname === '/standalone' || pathname === '/standalone.html') {
    return streamFile(req, res, path.join(ROOT, 'oscilloscope-standalone.html'), {
      contentType: MIME['.html'],
      cache: 'no-cache',
    });
  }

  // ---- static ------------------------------------------------------------
  if (pathname === '/') {
    return serveStatic(req, res, '/index.html', 'index.html');
  }
  const served = serveStatic(req, res, pathname);
  if (served === false) {
    return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');
  }
  return undefined;
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(C.red(`  ✗ ${req.method} ${req.url} — ${err && err.message}`));
    if (!res.headersSent) {
      send(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Internal Server Error');
    } else {
      res.destroy();
    }
  });
});

/* ------------------------------------------------------------------- boot */

function parseArgs(argv) {
  const opts = { port: Number(process.env.PORT) || DEFAULT_PORT, host: '127.0.0.1', open: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') opts.port = Number(argv[++i]) || opts.port;
    else if (a.startsWith('--port=')) opts.port = Number(a.slice(7)) || opts.port;
    else if (a === '--host' || a === '-H') opts.host = argv[++i] || opts.host;
    else if (a.startsWith('--host=')) opts.host = a.slice(7) || opts.host;
    else if (a === '--open' || a === '-o') opts.open = true;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? `open "${url}"`
    : process.platform === 'win32' ? `start "" "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

function banner(port, host, tracks) {
  const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`;
  const lines = [
    '',
    `  ${C.bold('◉ WEB OSCILLOSCOPE MUSIC PLAYER')}  ${C.dim('— Node.js server')}`,
    '',
    `  ${C.dim('app       ')} ${C.cyan(url)}`,
    `  ${C.dim('standalone')} ${C.cyan(url + 'standalone')}  ${C.dim('(single self-contained HTML)')}`,
    `  ${C.dim('playlist  ')} ${C.green(String(tracks.length) + ' track(s)')}`,
  ];
  for (const t of tracks.slice(0, 8)) {
    const meta = [
      t.format,
      t.sampleRate ? `${(t.sampleRate / 1000).toFixed(t.sampleRate % 1000 ? 1 : 0)} kHz` : null,
      t.bits ? `${t.bits}-bit` : null,
      t.channels === 2 ? 'stereo' : t.channels ? `${t.channels}ch` : null,
      t.durationText,
      t.sizeText,
    ].filter(Boolean).join(' · ');
    lines.push(`              ${C.dim('·')} ${t.name} ${C.dim(meta)}`);
  }
  if (tracks.length > 8) lines.push(`              ${C.dim(`… and ${tracks.length - 8} more`)}`);
  if (!tracks.length) {
    lines.push(`              ${C.yellow('no audio found — drop files into the project folder')}`);
  }
  if (host === '0.0.0.0') {
    for (const ip of localAddresses()) lines.push(`  ${C.dim('LAN       ')} ${C.cyan(`http://${ip}:${port}/`)}`);
  }
  lines.push('', `  ${C.dim('Ctrl+C to stop')}`, '');
  console.log(lines.join('\n'));
}

function listen(opts, attempt = 0) {
  const port = opts.port + attempt;
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 10) {
      console.log(C.yellow(`  port ${port} in use, trying ${port + 1}…`));
      setTimeout(() => listen(opts, attempt + 1), 30);
    } else {
      console.error(C.red(`  failed to start: ${err.message}`));
      process.exit(1);
    }
  });

  server.listen(port, opts.host, async () => {
    const tracks = await scanTracks();
    banner(port, opts.host, tracks);
    if (opts.open) openBrowser(`http://${opts.host === '0.0.0.0' ? '127.0.0.1' : opts.host}:${port}/`);
  });
}

const opts = parseArgs(process.argv);
if (opts.help) {
  console.log(`
  Usage: node server.js [options]

    -p, --port <n>   port to listen on            (default ${DEFAULT_PORT}; env PORT)
    -H, --host <ip>  interface to bind            (default 127.0.0.1)
    -o, --open       open the browser on startup
    -h, --help       show this help
`);
  process.exit(0);
}

process.on('SIGINT', () => {
  console.log('\n  bye.\n');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 300);
});

listen(opts);
