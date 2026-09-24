import * as core from './core.js';
import * as audio from './audio.js';
import * as render from './render.js';
import * as presets from './presets.js';

/* What is loaded: the track list, the file picker, the demo switch and basic
   transport. Reading files and knowing their native sample rate lives here;
   the graph itself belongs to audio.js. */

const {
  $,
  PRESET_KEYS,
  clamp,
  dom,
  flags,
  fmtBytes,
  fmtHz,
  setHint,
  toast,
} = core;

const {
  ensureEngineRate,
  rateText,
  resumeContext,
} = audio;



const {
  restoreTrackSettings,
} = presets;

/** Stable identity: this array is exported, so it is never reassigned. */
const tracks = [];
let curIndex = -1;

/* -------------------------------------------------- list state, remembered */
/* Sort order, play mode, and where the listener was. Persisted, because a list
   that forgets how you sorted it is a list you sort again every visit. The audio
   position is only restored for a file the server can hand out again: a dropped
   file's blob: URL dies with the tab. */
const STORE = 'scope.playlist.v1';
const MODES = ['sequence', 'one', 'shuffle'];
const MODE_LABEL = { sequence: '顺序', one: '单曲循环', shuffle: '随机' };
const SORT_LABEL = { name: '名称', duration: '时长', rate: '采样率', size: '大小' };
const prefs = { mode: 'sequence', sortKey: 'name', sortAsc: true, last: null };
let filter = '';
/* -Infinity, not 0: the throttle is "now minus the last write", and a page that
   has been alive for less than five seconds would otherwise swallow its own first
   write — including the flush on pause, which is the one that matters most. */
let playheadSavedAt = -Infinity;

function readPrefs() {
  try {
    const raw = window.localStorage.getItem(STORE);
    if (raw) Object.assign(prefs, JSON.parse(raw));
  } catch (err) { /* private mode, file://, or a hand-edited value */ }
  if (!MODES.includes(prefs.mode)) prefs.mode = 'sequence';
  if (!SORT_LABEL[prefs.sortKey]) prefs.sortKey = 'name';
  prefs.sortAsc = prefs.sortAsc !== false;
}
function savePrefs() {
  try { window.localStorage.setItem(STORE, JSON.stringify(prefs)); } catch (err) { /* ignore */ }
}
/** Name, format, codec and the meta line, so "44.1" finds the CD-rate files and
    "flac" finds the FLACs without a second syntax to learn. */
const searchable = (t) => `${t.name} ${t.format || ''} ${t.codec || ''} ${t.meta || ''}`.toLowerCase();

/** Compare two tracks for the current sort key. A value nobody knows (a dropped
    file whose metadata has not loaded yet) sorts last in either direction, rather
    than pretending to be zero seconds. */
function compareTracks(a, b) {
  const unknown = (v) => !v;
  if (prefs.sortKey === 'duration' || prefs.sortKey === 'rate' || prefs.sortKey === 'size') {
    const key = prefs.sortKey === 'rate' ? 'sampleRate' : prefs.sortKey;
    const av = a[key], bv = b[key];
    if (unknown(av) !== unknown(bv)) return unknown(av) ? 1 : -1;
    if ((av || 0) !== (bv || 0)) return (av || 0) - (bv || 0);
  }
  return a.name.localeCompare(b.name, undefined, { numeric: true });
}
/** Reorder in place, so every index stays meaningful. curIndex is remapped by
    identity, not by arithmetic — that is the part that breaks when the list is
    re-sorted under a playing track. */
function sortTracks() {
  const cur = tracks[curIndex];
  const dir = prefs.sortAsc ? 1 : -1;
  tracks.sort((a, b) => (dir * compareTracks(a, b))
    || a.name.localeCompare(b.name, undefined, { numeric: true }));
  curIndex = cur ? tracks.indexOf(cur) : -1;
}
function setSort(key) {
  if (!SORT_LABEL[key] || key === prefs.sortKey) return;
  prefs.sortKey = key;
  savePrefs();
  sortTracks();
  renderPlaylist();
}
function toggleSortDir() {
  prefs.sortAsc = !prefs.sortAsc;
  savePrefs();
  sortTracks();
  renderPlaylist();
}
function setFilter(text) {
  filter = String(text == null ? '' : text);
  renderPlaylist();
}
function setMode(m) {
  if (!MODES.includes(m)) return;
  prefs.mode = m;
  savePrefs();
  renderListTools();
}
function cycleMode() {
  setMode(MODES[(MODES.indexOf(prefs.mode) + 1) % MODES.length]);
  toast(`播放模式：${MODE_LABEL[prefs.mode]}`);
}
/** What "the track ended" means, per mode. ui.js calls this from its <audio>
    listeners, because the element is rebuilt whenever the engine changes. */
function advance() {
  if (audio.isDemo()) return;
  if (prefs.mode === 'one') { dom.audio.currentTime = 0; play(); return; }
  if (prefs.mode === 'shuffle' && tracks.length > 1) {
    let i = curIndex;
    while (i === curIndex) i = Math.floor(Math.random() * tracks.length);
    loadTrack(i, true);
    return;
  }
  if (tracks.length > 1) nextTrack(1);   // 顺序 with one track stops, by design
}
/** Remember the playhead for the next visit. Called on timeupdate, so it is
    throttled: a write per frame would be a write per frame. */
function notePlayhead() {
  const t = tracks[curIndex];
  if (!t || t.blob || audio.isDemo()) return;
  const now = performance.now();
  if (now - playheadSavedAt < 5000) return;
  playheadSavedAt = now;
  const at = dom.audio.currentTime;
  if (!Number.isFinite(at) || at < 1) return;
  prefs.last = { name: t.name, size: t.size || 0, at };
  savePrefs();
}
/** The same thing without the throttle, for pause and for leaving the page. */
function flushPlayhead() {
  playheadSavedAt = -Infinity;
  notePlayhead();
}
function noteDuration() {
  const t = tracks[curIndex];
  if (!t || t.duration) return;
  const d = dom.audio.duration;
  if (!Number.isFinite(d) || d <= 0) return;
  t.duration = d;
  if (prefs.sortKey === 'duration') { sortTracks(); renderPlaylist(); }
}
/** Same track, same place, but not playing: a page that starts making noise by
    itself is a page people close. `?play=1` and ▶ start it from there. */
function restoreLastPlayed() {
  const last = prefs.last;
  if (!last || !last.name) return false;
  const i = tracks.findIndex((t) => t.name === last.name && (!last.size || !t.size || t.size === last.size));
  if (i < 0) return false;
  loadTrack(i, false);
  if (last.at > 1) {
    const seek = () => {
      dom.audio.removeEventListener('loadedmetadata', seek);
      try { dom.audio.currentTime = last.at; } catch (err) { /* ignore */ }
      flags.redraw = true;
    };
    dom.audio.addEventListener('loadedmetadata', seek);
  }
  return true;
}
/** Stop and unload, without touching the list — used when the row you removed
    was the one playing. */
function stopSource() {
  dom.audio.pause();
  dom.audio.removeAttribute('src');
  dom.audio.load();
  curIndex = -1;
  presets.setTrackKey(null, null);
  render.resetTraceState();
  restoreTitle();
}
function removeTrack(i) {
  const t = tracks[i];
  if (!t) return;
  const wasCurrent = i === curIndex;
  if (t.blob && t.url) { try { URL.revokeObjectURL(t.url); } catch (err) { /* already gone */ } }
  tracks.splice(i, 1);
  if (wasCurrent) stopSource();
  else if (i < curIndex) curIndex--;
  if (prefs.last && prefs.last.name === t.name) { prefs.last = null; savePrefs(); }
  renderPlaylist();
}
function clearTracks() {
  for (const t of tracks) {
    if (t.blob && t.url) { try { URL.revokeObjectURL(t.url); } catch (err) { /* already gone */ } }
  }
  tracks.length = 0;
  prefs.last = null;
  savePrefs();
  stopSource();
  renderPlaylist();
}
/** The tools row has to say what will happen next (ascending or descending, which
    mode), not just what the value is. */
function renderListTools() {
  if (dom.trackFilter && dom.trackFilter.value !== filter) dom.trackFilter.value = filter;
  if (dom.trackSort) dom.trackSort.value = prefs.sortKey;
  if (dom.btnSortDir) {
    dom.btnSortDir.textContent = prefs.sortAsc ? '↑' : '↓';
    dom.btnSortDir.setAttribute('aria-pressed', prefs.sortAsc ? 'false' : 'true');
    dom.btnSortDir.title = `按${SORT_LABEL[prefs.sortKey]}${prefs.sortAsc ? '升序' : '降序'}（点一下切${prefs.sortAsc ? '降' : '升'}序）`;
  }
  if (dom.btnMode) {
    dom.btnMode.dataset.mode = prefs.mode;
    dom.btnMode.title = `播放模式：${MODE_LABEL[prefs.mode]}（M 或点我切换）`;
    dom.btnMode.setAttribute('aria-label', `播放模式：${MODE_LABEL[prefs.mode]}`);
  }
  if (dom.btnClear) dom.btnClear.disabled = !tracks.length;
}
function initPlaylist() {
  readPrefs();
  renderListTools();
}
function renderPlaylist() {
  const ul = dom.trackList;
  ul.textContent = '';
  const q = filter.trim().toLowerCase();
  if (!tracks.length) {
    const li = document.createElement('li');
    li.className = 'empty-note';
    li.textContent = location.protocol === 'file:'
      ? '单文件版无法自动读取本地目录。\n把音频文件拖进窗口，或点下方按钮选择。'
      : '项目目录里没有找到音频文件。\n拖入文件，或用下方按钮添加。';
    li.style.whiteSpace = 'pre-line';
    ul.appendChild(li);
    dom.listCount.textContent = '';
    renderListTools();
    return;
  }
  const rows = [];
  tracks.forEach((t, i) => { if (!q || searchable(t).includes(q)) rows.push(i); });
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'empty-note';
    li.textContent = `没有匹配「${filter.trim()}」的曲目`;
    ul.appendChild(li);
  }
  for (const i of rows) {
    const t = tracks[i];
    const li = document.createElement('li');
    li.className = 'track' + (i === curIndex ? ' active' : '');
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = String(i + 1).padStart(2, '0');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = t.name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = t.meta || '';
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'rm';
    rm.textContent = '✕';
    rm.title = t.blob
      ? '从列表里移除'
      : '从列表里移除（刷新后会重新扫到磁盘上的文件）';
    rm.setAttribute('aria-label', `移除 ${t.name}`);
    rm.addEventListener('click', (e) => { e.stopPropagation(); removeTrack(i); });
    li.append(n, name, meta, rm);
    li.addEventListener('click', () => loadTrack(i, true));
    ul.appendChild(li);
  }
  dom.listCount.textContent = q ? `(${rows.length}/${tracks.length})` : `(${tracks.length})`;
  renderListTools();
}
async function loadServerTracks() {
  if (location.protocol === 'file:') return false;
  try {
    /* Relative, not '/api/tracks': under GitHub Pages this app is served from a
       subpath (/<repo>/), and a leading slash asks the domain root instead — which
       is where the 404 came from on the deployed copy. */
    const res = await fetch('api/tracks', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!Array.isArray(data.tracks) || !data.tracks.length) return false;
    const listed = data.tracks.map((t) => ({
      name: t.name,
      url: t.url,
      blob: false,
      size: t.size || 0,
      duration: t.duration || 0,
      format: t.format || null,
      sampleRate: t.sampleRate || 0,
      codec: t.codec || null,
      meta: [
        t.format,
        t.codec,
        t.sampleRate ? `${fmtHz(t.sampleRate)}` : null,
        t.bits ? `${t.bits}-bit` : null,
        t.channels === 2 ? '立体声' : t.channels ? `${t.channels}ch` : null,
        t.durationText,
        t.sizeText,
      ].filter(Boolean).join(' · '),
    }));
    tracks.length = 0;
    tracks.push(...listed);
    sortTracks();
    renderPlaylist();
    return true;
  } catch (err) {
    return false;   // standalone / file:// — the file picker takes over
  }
}
/** The track currently loaded, for anything that needs to describe it. */
const currentTrack = () => tracks[curIndex] || null;
const AUDIO_RE = /\.(wav|wave|flac|mp3|m4a|aac|ogg|oga|opus|weba|webm|aif|aiff|aifc|caf)$/i;
/* Read the native sample rate straight out of the file header (a small
   leading slice — nothing is decoded). Needed so a local file can get an
   engine at its own rate instead of being resampled into the device rate.
   Same logic as server.js uses for the playlist. */
async function probeNativeRate(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 262144).arrayBuffer());
    const dv = new DataView(head.buffer);
    const tag = (o) => String.fromCharCode(head[o] || 0, head[o + 1] || 0, head[o + 2] || 0, head[o + 3] || 0);
    // ---- WAV / RIFF
    if (tag(0) === 'RIFF' && tag(8) === 'WAVE') {
      let off = 12;
      while (off + 24 <= head.length) {
        const id = tag(off);
        const size = dv.getUint32(off + 4, true);
        if (id === 'fmt ') {
          return {
            format: 'WAV',
            rate: dv.getUint32(off + 12, true),
            channels: dv.getUint16(off + 10, true),
            bits: dv.getUint16(off + 22, true),
          };
        }
        if (id === 'data') break;
        off += 8 + size + (size % 2);
      }
    }
    // ---- FLAC / STREAMINFO
    if (tag(0) === 'fLaC' && head.length >= 42) {
      const b = head.subarray(8, 42);
      const bits = (bitOff, count) => {
        let v = 0;
        for (let i = 0; i < count; i++) { const p = bitOff + i; v = v * 2 + ((b[p >> 3] >> (7 - (p & 7))) & 1); }
        return v;
      };
      return { format: 'FLAC', rate: bits(80, 20), channels: bits(100, 3) + 1, bits: bits(103, 5) + 1 };
    }
    // ---- MP4 family (m4a/mp4: AAC, ALAC). Checked BEFORE the MP3 scan: an
    // mdat full of compressed audio looks exactly like a run of frame headers,
    // and scanning it first produced bogus rates for m4a files.
    if (tag(4) === 'ftyp') {
      const u16 = (buf, o) => (buf[o] << 8 | buf[o + 1]) >>> 0;
      const u32 = (buf, o) => ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0;
      const findIn = (buf, s) => {
        const c = [s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)];
        for (let i = 0; i + 4 <= buf.length; i++) {
          if (buf[i] === c[0] && buf[i + 1] === c[1] && buf[i + 2] === c[2] && buf[i + 3] === c[3]) return i;
        }
        return -1;
      };
      /* moov is usually at the far end (written mdat-first), and that is where
         the sample entry and mvhd live, so pull a tail slice when the head has
         no moov. Nothing is decoded — this is a byte scan. */
      const chunks = [head];
      if (findIn(head, 'moov') < 0 && file.size > head.length) {
        const tailLen = Math.min(file.size - head.length, 1048576);
        chunks.push(new Uint8Array(await file.slice(file.size - tailLen).arrayBuffer()));
      }
      let rate = 0;
      let channels = 0;
      let bits = 0;
      let codec = null;
      for (const buf of chunks) {
        for (let i = findIn(buf, 'alac'); i >= 4 && i + 32 <= buf.length; i = findIn(buf.subarray(i + 1), 'alac') + i + 1) {
          if (u32(buf, i - 4) !== 36) continue;      // the 36-byte ALACSpecificConfig
          codec = 'ALAC';
          bits = buf[i + 13];
          channels = buf[i + 17];
          rate = u32(buf, i + 28);
          break;
        }
        if (!rate) {
          for (const cc of ['mp4a', 'alac']) {
            for (let i = findIn(buf, cc); i >= 4 && i + 32 <= buf.length; i = findIn(buf.subarray(i + 1), cc) + i + 1) {
              const clean = u32(buf, i + 4) === 0 && u16(buf, i + 8) === 0;
              const r = u32(buf, i + 28) >>> 16;
              const ch = u16(buf, i + 20);
              if (!clean || r < 8000 || r > 384000 || ch < 1 || ch > 8) continue;
              codec = cc === 'mp4a' ? 'AAC' : 'ALAC';
              rate = r;
              channels = ch;
              if (cc === 'alac') bits = bits || u16(buf, i + 22);
              break;
            }
            if (rate) break;
          }
        }
        if (rate) break;
      }
      if (rate) return { format: 'M4A', codec, rate, channels: channels || 2, bits };
    }
    // ---- AIFF / AIFF-C. The rate is an 80-bit IEEE extended float, never a
    // fixed-width integer: 1 sign bit, 15 exponent bits, 64-bit mantissa with
    // an explicit integer bit.
    if (tag(0) === 'FORM' && (tag(8) === 'AIFF' || tag(8) === 'AIFC')) {
      const extended = (o) => {
        const exp = ((head[o] & 0x7f) << 8) | head[o + 1];
        if (!exp) return 0;
        let mant = 0;
        for (let i = 2; i < 10; i++) mant = mant * 256 + head[o + i];
        return Math.round(mant * Math.pow(2, exp - 16383 - 63));
      };
      const isC = tag(8) === 'AIFC';
      let off = 12;
      while (off + 8 <= head.length) {
        const id = tag(off);
        const size = dv.getUint32(off + 4, false);
        if (id === 'COMM' && off + 26 <= head.length) {
          const channels = dv.getUint16(off + 8, false);
          const frames = dv.getUint32(off + 10, false);
          const bits = dv.getUint16(off + 14, false);
          const rate = extended(off + 16);
          if (rate && channels) {
            const ctag = isC && off + 30 <= head.length ? tag(off + 26) : 'PCM';
            return {
              format: isC ? 'AIFC' : 'AIFF',
              codec: ['NONE', 'twos', 'sowt'].includes(ctag) ? 'PCM' : ctag,
              rate,
              channels,
              bits,
              duration: frames > 0 ? frames / rate : null,
            };
          }
          break;
        }
        off += 8 + size + (size % 2);        // chunks are word aligned
      }
    }
    // ---- CAF: one desc chunk, big-endian, behind a 64-bit chunk size
    if (tag(0) === 'caff') {
      let off = 8;
      let desc = null;
      let dataSize = null;
      while (off + 12 <= head.length) {
        const id = tag(off);
        const size = dv.getUint32(off + 4, false) * 4294967296 + dv.getUint32(off + 8, false);
        if (id === 'desc' && off + 44 <= head.length) {
          desc = {
            rate: Math.round(dv.getFloat64(off + 12, false)),
            fmt: tag(off + 20),
            bytesPerPacket: dv.getUint32(off + 28, false),
            channels: dv.getUint32(off + 36, false),
            bits: dv.getUint32(off + 40, false),
          };
        } else if (id === 'data') {
          dataSize = size;
          break;
        }
        off += 12 + size;
      }
      if (desc && desc.rate && desc.channels) {
        const pcm = desc.fmt === 'lpcm';
        return {
          format: 'CAF',
          codec: pcm ? 'PCM' : desc.fmt,
          rate: desc.rate,
          channels: desc.channels,
          bits: pcm ? desc.bits : 0,
          duration: dataSize != null && desc.bytesPerPacket > 0
            ? dataSize / desc.bytesPerPacket / desc.rate : null,
        };
      }
    }
    // ---- Ogg: the first page payload names the codec. Opus always decodes at
    // 48 kHz whatever the source was, and that is what the analyser sees. The
    // duration is the granule position of the LAST page, so this one needs the
    // tail even though the codec is announced in the first bytes.
    if (tag(0) === 'OggS' && head.length > 40) {
      const body = 27 + head[26];
      if (body + 16 <= head.length) {
        let rate = 0;
        let channels = 0;
        let codec = null;
        if (tag(body + 1) === 'vorb') { rate = dv.getUint32(body + 12, true); channels = head[body + 11]; codec = 'Vorbis'; }
        else if (tag(body) === 'Opus') { rate = 48000; channels = head[body + 9]; codec = 'Opus'; }
        if (rate && channels) {
          let duration = null;
          try {
            const tail = file.size > head.length
              ? new Uint8Array(await file.slice(Math.max(0, file.size - 65536)).arrayBuffer())
              : head;
            let at = -1;
            for (let i = tail.length - 4; i >= 0; i--) {
              if (tail[i] === 0x4f && tail[i + 1] === 0x67 && tail[i + 2] === 0x67 && tail[i + 3] === 0x53) { at = i; break; }
            }
            if (at >= 0 && at + 14 <= tail.length) {
              let granule = 0;
              for (let i = 7; i >= 0; i--) granule = granule * 256 + tail[at + 6 + i];   // little endian
              if (granule > 0) duration = granule / rate;
            }
          } catch (e) { /* tail unreadable — the rate is what matters */ }
          return { format: codec === 'Opus' ? 'OPUS' : 'OGG', codec, rate, channels, bits: 0, duration };
        }
      }
    }
    // ---- MP3 (first MPEG frame header)
    const scan = Math.min(head.length - 4, 65536);
    for (let i = 0; i < scan; i++) {
      if (head[i] !== 0xff || (head[i + 1] & 0xe0) !== 0xe0) continue;
      const ver = (head[i + 1] >> 3) & 3;
      const srIdx = (head[i + 2] >> 2) & 3;
      if (ver === 1 || srIdx === 3) continue;
      const table = ver === 3 ? [44100, 48000, 32000]
        : ver === 2 ? [22050, 24000, 16000]
          : [11025, 12000, 8000];
      return { format: 'MP3', codec: 'MP3', rate: table[srIdx], channels: ((head[i + 3] >> 6) & 3) === 3 ? 1 : 2, bits: 0 };
    }
  } catch (err) { /* unreadable header — fall back to the device rate */ }
  return null;
}
function describeAudio(info, size) {
  if (!info) return fmtBytes(size);
  return [
    info.format,
    info.codec,                 // ALAC / AAC, when the container hides the codec
    info.rate ? rateText(info.rate) : null,
    info.bits ? `${info.bits}-bit` : null,
    info.channels === 2 ? '立体声' : info.channels ? `${info.channels}ch` : null,
    fmtBytes(size),
  ].filter(Boolean).join(' · ');
}
async function addLocalFiles(files) {
  const list = Array.from(files).filter((f) => /^audio\//.test(f.type) || AUDIO_RE.test(f.name));
  if (!list.length) { toast('没有识别到音频文件'); return; }
  setDemo(false);
  for (const f of list) {
    const info = await probeNativeRate(f);
    tracks.push({
      name: f.name,
      url: URL.createObjectURL(f),
      blob: true,
      size: f.size || 0,
      duration: 0,             // filled in when the element reports loadedmetadata
      format: (info && info.format) || null,
      sampleRate: info && info.rate ? info.rate : 0,
      codec: (info && info.codec) || null,
      meta: describeAudio(info, f.size),
    });
  }
  sortTracks();
  renderPlaylist();
  /* The sort may have moved the files just added, so find the one to play by
     identity rather than by the index it would have had unsorted. */
  loadTrack(tracks.findIndex((t) => t.blob && t.name === list[0].name), true);
}
/** Rebuild the <audio> element around the engine change and restore where the
    listener was. audio.js drives this because it owns the graph; knowing which
    file that is, is this layer's job. */
function reloadCurrentSource({ wasDemo, time, playing }) {
  if (wasDemo) { setDemo(true); return; }
  const t = tracks[curIndex];
  if (!t) return;
  dom.audio.src = t.url;
  if (time > 0.05) {
    const onMeta = () => {
      dom.audio.removeEventListener('loadedmetadata', onMeta);
      try { dom.audio.currentTime = time; } catch (e) { /* ignore */ }
      if (playing) play();
    };
    dom.audio.addEventListener('loadedmetadata', onMeta);
  } else if (playing) {
    play();
  }
}
function loadTrack(i, autoplay) {
  const t = tracks[i];
  if (!t) return;
  const same = i === curIndex && !audio.isDemo();
  if (audio.isDemo()) setDemo(false);
  curIndex = i;
    presets.setTrackKey(t.name, t.name);
  // Build/rebuild the engine at this file's own rate *before* loading, so the
  // media is never resampled into the device rate on the analysis path.
  audio.setSourceRate(t.sampleRate);
  ensureEngineRate();
  dom.audio.src = t.url;
  dom.audio.load();
  dom.trackTitle.textContent = t.name;
  dom.trackSub.textContent = t.meta || '';
  document.title = `${t.name} · 示波器音乐播放器`;
  setHint(false);
  renderPlaylist();
  // Re-selecting the same row must not undo tweaks the user has not saved yet.
  if (!same) restoreTrackSettings();
  render.resetTraceState();
  if (autoplay) play();
}
async function play() {
  resumeContext();
  if (audio.isDemo()) {
    if (!dom.audio.src) return;   // nothing to switch to — stay on the demo
    setDemo(false);              // playing a track leaves demo mode
  }
  if (!dom.audio.src) {
    if (tracks.length) { loadTrack(curIndex >= 0 ? curIndex : 0, true); return; }
    setHint(true);
    toast('先载入一个音频文件');
    return;
  }
  try {
    await dom.audio.play();
  } catch (err) {
    if (err && err.name === 'NotAllowedError') toast('被浏览器拦截，请再点一次 ▶');
    else toast('无法播放：' + (err && err.message ? err.message : err));
  }
}
function togglePlay() {
  if (dom.audio.paused || dom.audio.ended) play();
  else dom.audio.pause();
}
function nextTrack(step) {
  if (!tracks.length) return;
  const i = (curIndex + step + tracks.length) % tracks.length;
  loadTrack(i, true);
}
function seekBy(delta) {
  const d = dom.audio.duration;
  if (!Number.isFinite(d)) return;
  dom.audio.currentTime = clamp(dom.audio.currentTime + delta, 0, d);
  flags.redraw = true;
}

function setDemo(on) {
  if (!audio.setDemoSource(on)) return;
  if (on) {
    presets.setTrackKey('@demo', '演示信号');
    dom.audio.pause();
    dom.btnDemo.classList.add('on');
    dom.trackTitle.textContent = '演示信号 · Demo';
    dom.trackSub.textContent = '内置合成器 · 3:2 利萨如曲线';
    document.title = '演示信号 · 示波器音乐播放器';
    setHint(false);
    flags.redraw = true;
    render.resetRefSpeed();
    restoreTrackSettings();   // the demo is remembered like any other "track"
  } else {
    dom.btnDemo.classList.remove('on');
    restoreTitle();
  }
}
function restoreTitle() {
  const t = tracks[curIndex];
  if (t) {
    dom.trackTitle.textContent = t.name;
    dom.trackSub.textContent = t.meta || '';
    document.title = `${t.name} · 示波器音乐播放器`;
  } else {
    dom.trackTitle.textContent = '未加载音频';
    dom.trackSub.textContent = '拖入文件，或打开播放列表';
    document.title = '示波器音乐播放器 · Oscilloscope Music Player';
  }
}


export {
  AUDIO_RE,
  advance,
  currentTrack,
  addLocalFiles,
  clearTracks,
  cycleMode,
  describeAudio,
  flushPlayhead,
  initPlaylist,
  loadServerTracks,
  loadTrack,
  nextTrack,
  noteDuration,
  notePlayhead,
  play,
  probeNativeRate,
  reloadCurrentSource,
  removeTrack,
  renderListTools,
  renderPlaylist,
  restoreLastPlayed,
  restoreTitle,
  seekBy,
  setDemo,
  setFilter,
  setMode,
  setSort,
  togglePlay,
  toggleSortDir,
  tracks,
};
