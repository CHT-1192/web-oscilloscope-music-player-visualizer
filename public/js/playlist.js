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
function renderPlaylist() {
  const ul = dom.trackList;
  ul.textContent = '';
  if (!tracks.length) {
    const li = document.createElement('li');
    li.className = 'empty-note';
    li.textContent = location.protocol === 'file:'
      ? '单文件版无法自动读取本地目录。\n把音频文件拖进窗口，或点下方按钮选择。'
      : '项目目录里没有找到音频文件。\n拖入文件，或用下方按钮添加。';
    li.style.whiteSpace = 'pre-line';
    ul.appendChild(li);
    dom.listCount.textContent = '';
    return;
  }
  tracks.forEach((t, i) => {
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
    li.append(n, name, meta);
    li.addEventListener('click', () => loadTrack(i, true));
    ul.appendChild(li);
  });
  dom.listCount.textContent = `(${tracks.length})`;
}
async function loadServerTracks() {
  if (location.protocol === 'file:') return false;
  try {
    const res = await fetch('/api/tracks', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!Array.isArray(data.tracks) || !data.tracks.length) return false;
    const listed = data.tracks.map((t) => ({
      name: t.name,
      url: t.url,
      blob: false,
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
    renderPlaylist();
    return true;
  } catch (err) {
    return false;   // standalone / file:// — the file picker takes over
  }
}
/** The track currently loaded, for anything that needs to describe it. */
const currentTrack = () => tracks[curIndex] || null;
const AUDIO_RE = /\.(wav|wave|flac|mp3|m4a|aac|ogg|oga|opus|weba|webm|aif|aiff|caf)$/i;
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
      return { format: 'MP3', rate: table[srIdx], channels: ((head[i + 3] >> 6) & 3) === 3 ? 1 : 2, bits: 16 };
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
  const first = tracks.length;
  for (const f of list) {
    const info = await probeNativeRate(f);
    tracks.push({
      name: f.name,
      url: URL.createObjectURL(f),
      blob: true,
      sampleRate: info && info.rate ? info.rate : 0,
      codec: (info && info.codec) || null,
      meta: describeAudio(info, f.size),
    });
  }
  renderPlaylist();
  loadTrack(first, true);
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
  currentTrack,
  addLocalFiles,
  describeAudio,
  loadServerTracks,
  loadTrack,
  nextTrack,
  play,
  probeNativeRate,
  reloadCurrentSource,
  renderPlaylist,
  restoreTitle,
  seekBy,
  setDemo,
  togglePlay,
  tracks,
};
