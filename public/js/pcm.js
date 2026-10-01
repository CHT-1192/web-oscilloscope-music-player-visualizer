import * as core from './core.js';

/* ============================================================================
    pcm.js — the file's own samples, decoded by the browser but never played
    through the <audio> element.

    Why this exists. MediaElementAudioSourceNode's output IS the element's audio
    with the element's effective volume already applied: Web Audio 1.22 requires
    that "pausing, seeking, volume ... MUST behave as they normally would" after
    the node is created, and Gecko implements that by applying the element's
    effective volume in the node's own input track (bug 2010427, Firefox 149).
    So 音量 0, element .muted, and the browser's tab-mute button all silence the
    ANALYSIS as well, and nothing inside the element can be tapped before that
    multiply. The way to read the signal before it is to stop using the element
    as the sample source: decodeAudioData hands back the file's samples, and an
    AudioBuffer has no volume to apply.

    What it costs. The whole file lives in RAM as float32 and there is no
    streaming, so files over the caps below keep using the element tap. Nothing
    here plays audio: the element still does that, so seek, speed and streaming
    are unchanged, and only the analysis reads these samples.

    Measured on this project's fixtures (Chromium): decodeAudioData of a 15 MB /
    146 s FLAC at its own 44.1 kHz takes 84 ms into 51.5 MB, and the samples agree
    with an independent ffmpeg decode to within 1 LSB of the source format — 0 for
    24- and 32-bit PCM, 0.73 LSB (2.2e-5, -93 dBFS) for 16-bit, most of which is
    the int->float scale itself (32767 here, 32768 in ffmpeg). No resampling: the
    decode runs in an OfflineAudioContext built at the file's OWN rate, and a
    decoder that hands back a different rate is refused rather than trusted.
   ========================================================================== */

const MAX_FILE = 128 * 1024 * 1024;        // bytes we are willing to download again
const MAX_DECODED = 256 * 1024 * 1024;     // float32 bytes we are willing to hold
const ASSUMED_CHANNELS = 2;
/* Nothing told us how long the file is: 128 kbps is a low bitrate for music, so
   this OVER-estimates the duration and the memory cap stays a bound. */
const SLOWEST_BITS_PER_SECOND = 128000;

let chL = null, chR = null;      // the decoded channels (chR null on a mono file)
let frames = 0;                  // frames decoded
let rate = 0;                    // their sample rate
let held = 0;                    // float32 bytes held
let pos = 0;                     // "now", in frames — where the window ends
let lastClock = 0;               // AudioContext.currentTime at the last advance
let lastMedia = 0;               // element playhead at the last advance
let token = 0;                   // the load that is still allowed to land
const IDLE = { active: false, reason: '未载入' };
let state = IDLE;

/** How much memory decoding this track would take, or Infinity when a number we
    cannot do without is missing. An unknown rate cannot be guessed at all: it is
    the one thing decodeAudioData needs to be given to avoid resampling. */
function decodedBytes(track) {
  const r = Number(track.sampleRate) || 0;
  if (!r) return Infinity;
  const ch = Number(track.channels) || ASSUMED_CHANNELS;
  let dur = Number(track.duration) || 0;
  if (!dur && track.size) dur = (track.size * 8) / SLOWEST_BITS_PER_SECOND;
  if (!dur) return Infinity;
  return dur * r * ch * 4;
}

/** Why this track cannot use the path, or '' when it can. */
function refuse(track) {
  if (!track || !track.url) return '没有音频';
  if (!Number(track.sampleRate)) return '未知采样率';
  if (Number(track.size) > MAX_FILE) return '文件太大';
  if (decodedBytes(track) > MAX_DECODED) return '解码后太大';
  return '';
}

async function bytes(track) {
  /* A dropped file is already in memory as a File: no request, and it also works
     on file:// where fetching a blob URL is not always allowed. */
  if (track.file && typeof track.file.arrayBuffer === 'function') return track.file.arrayBuffer();
  const res = await fetch(track.url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const len = Number(res.headers.get('content-length')) || 0;
  if (len > MAX_FILE) throw new Error('too big');
  return res.arrayBuffer();
}

/** Decode `track` at its own sample rate. Replaces whatever was decoded before,
    and a later call always wins: a slow decode of a track you have already
    switched away from must not land on top of the new one. */
async function load(track) {
  const my = ++token;
  chL = chR = null; frames = 0; rate = 0; held = 0; pos = 0; lastClock = 0; lastMedia = 0;

  const why = refuse(track);
  if (why) { state = { active: false, reason: why }; return state; }

  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const native = Number(track.sampleRate);
  if (!OAC) { state = { active: false, reason: '不支持离线解码' }; return state; }

  state = { active: false, reason: '解码中' };
  try {
    const raw = await bytes(track);
    if (my !== token) return state;
    /* One frame of context is all decodeAudioData needs, but the context rate is
       the rate it decodes INTO — which is the whole point here. */
    const dec = new OAC(1, 1, native);
    const audio = await dec.decodeAudioData(raw);
    if (my !== token) return state;
    if (audio.sampleRate !== native) { state = { active: false, reason: '解码器改了采样率' }; return state; }
    chL = audio.getChannelData(0);
    chR = audio.numberOfChannels > 1 ? audio.getChannelData(1) : null;
    frames = audio.length;
    rate = audio.sampleRate;
    held = frames * (chR ? 2 : 1) * 4;
    state = { active: true, reason: '' };
  } catch (err) {
    if (my !== token) return state;
    chL = chR = null; frames = 0; rate = 0; held = 0;
    state = { active: false, reason: '解码失败' };
  }
  return state;
}

function clear() {
  token++;
  chL = chR = null; frames = 0; rate = 0; held = 0; pos = 0; lastClock = 0; lastMedia = 0;
  state = IDLE;
}

/** Move the read position to "now".
    `ctxTime` is the audio clock, `mediaTime` the element's playhead. The audio
    clock drives the read position, because that is the clock the playback is
    actually rendered on and it advances smoothly; the element's playhead is what
    the position is CORRECTED against, not what it follows. (A browser only has to
    keep the playhead fresh to within a few hundred ms, so following it directly
    would make the figure jump.) A seek, a pause, a backwards step of the playhead
    (a loop restart), or a drift past one second resyncs from the element instead.
    A jump past 0.4 s also resyncs: that is longer than any playhead update step,
    and shorter than a seek the listener would notice. */
function advance(ctxTime, mediaTime, playing, seeking) {
  if (!frames) return;
  const elPos = mediaTime * rate;
  const d = ctxTime - lastClock;
  const stepped = mediaTime < lastMedia - 0.001 || mediaTime - lastMedia > 0.4;
  if (playing && !seeking && !stepped && d > 0 && d < 0.5) pos += d * rate;
  else pos = elPos;
  if (Math.abs(pos - elPos) > rate) pos = elPos;
  lastClock = ctxTime;
  lastMedia = mediaTime;
  pos = core.clamp(pos, 0, frames);
}

/** The most recent `n` frames, ending at "now", into `outL`/`outR`.
    Same contract as the analyser read: always exactly n samples, silence before
    the start of the file, so the renderer cannot tell the two apart. */
function fill(outL, outR, n) {
  if (!frames) return false;
  const end = Math.round(pos);
  const start = end - n;
  const src = Math.max(0, start);
  const pad = src - start;                       // silence before the file starts
  const k = Math.max(0, Math.min(n - pad, frames - src));
  if (pad) { outL.fill(0, 0, pad); outR.fill(0, 0, pad); }
  if (k > 0) {
    outL.set(chL.subarray(src, src + k), pad);
    if (chR) outR.set(chR.subarray(src, src + k), pad);
    else outR.fill(0, pad, pad + k);
  }
  if (pad + k < n) { outL.fill(0, pad + k, n); outR.fill(0, pad + k, n); }
  return true;
}

/** Raw frames at an absolute offset — the seam the tests read to compare this
    against an independent decode. Not used by the renderer. */
function slice(start, n) {
  if (!frames) return null;
  const a = core.clamp(Math.round(start) || 0, 0, Math.max(0, frames - 1));
  const k = Math.max(0, Math.min(Math.round(n) || 0, frames - a));
  return {
    start: a,
    n: k,
    rate,
    L: Array.from(chL.subarray(a, a + k)),
    R: chR ? Array.from(chR.subarray(a, a + k)) : null,
  };
}

/** Everything the status line, the debug seam and the tests need. */
const status = () => ({
  active: !!frames,
  reason: state.reason,
  rate,
  frames,
  bytes: held,
  pos: Math.round(pos),
});

export {
  MAX_DECODED,
  MAX_FILE,
  advance,
  clear,
  decodedBytes,
  fill,
  load,
  refuse,
  slice,
  status,
};
