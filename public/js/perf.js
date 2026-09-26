/* ============================================================================
 *  perf.js — what the renderer measures about itself
 *
 *    · WORK_*  how long the render call takes — the quality governor's input;
 *    · FL_*    frame INTERVALS, each with the context that produced it, because
 *              a median hides a hitch and the 1 % / 0.1 % low does not;
 *    · a watchdog for audio dropouts, which fire no DOM event at all.
 *
 *  Nothing here draws, and nothing here is on the hot path: recording a frame is
 *  a few array writes, and the percentiles are only computed when asked for.
 * ========================================================================== */

import * as audio from './audio.js';
import * as core from './core.js';

const {
  dom,
} = core;

/* Rolling window of per-frame render times.

    performance.now() is quantised to 100 us in Chrome, which is coarser than
    the differences worth measuring, so no single sample is useful. Two
    properties make the window work anyway:
      - averaging many quantised samples recovers sub-quantum resolution;
      - background load (another app, a compile) can only ever ADD slow
        frames, so it shows up purely as a right tail.
    So `trimmed()` — the mean of the fastest quarter — is both sub-quantum
    accurate and insensitive to whatever else the machine is doing.

    Keep the window SHORT (~2 s): a long one both slows the quality
    adaptation down and, when a measurement starts, is still full of stale
    frames from before the change. */
const WORK_RING = new Float32Array(120);
const WORK_SORT = new Float32Array(120);
let workPos = 0;
let workFilled = 0;

/* ---- frame log -----------------------------------------------------------
   A rolling window of frame INTERVALS, with the two things that can make one
   long: how many segments were deposited, and whether the halation passes ran.
   The median never shows a hitch — 1 % / 0.1 % low does, which is what a
   benchmark reports and what a hitch feels like. Read it with `__scope.perf()`
   or by clicking the 画质 badge; the output is plain text made for copy-paste,
   so nobody has to record a profiler again. */
const FL_N = 8192;      // ~2.3 min at 60 fps: long enough to report it afterwards
const flIv = new Float32Array(FL_N);     // ms between rAF ticks
const flSeg = new Int32Array(FL_N);      // segments deposited by that frame
const flHalo = new Uint8Array(FL_N);     // halation passes were running
const flScale = new Uint8Array(FL_N);    // canvas was resized during it
const flT = new Float64Array(FL_N);      // when that frame ended
const flEvents = [];                     // {t, what}
let flAt = 0, flFilled = 0, flPrev = 0;
let flLastSeg = 0, flLastHalo = 0, flResized = false;

function noteEvent(what) {
  flEvents.push({ t: performance.now(), what: String(what) });
  if (flEvents.length > 200) flEvents.shift();
}

/* ---- the audio watchdog --------------------------------------------------
   A dropout caused by the audio thread missing its deadline fires NO DOM event:
   the element still says it is playing, no `waiting`, no `error`, and the renderer
   keeps painting — there is simply silence, and if nothing is playing there is
   nothing to paint either. That is the reported symptom, and it cannot be caught
   by listening to events.

   What does move is the AUDIO CLOCK: `AudioContext.currentTime` only advances
   while the graph is actually being rendered, so wall-clock progress minus
   audio-clock progress IS the dropout, in milliseconds. Log it, together with
   silence while supposedly playing and the element's own state.

   Also timestamped here: page lifecycle (a frozen/backgrounded tab is a prime
   suspect), the context state, and Firefox's own long-task entries when it
   supports them. */
let lastClock = 0, lastClockWall = 0, ctxState = '', silentMs = 0;
let peakL = 0, peakR = 0;                 // the last drawn frame's channel peaks
function watchAudio(now) {
  const st = audio.status();
  if (st.contextState !== ctxState) {
    noteEvent(`音频上下文 ${ctxState || '(未建)'} → ${st.contextState}`);
    ctxState = st.contextState;
  }
  const el = dom.audio;
  const live = !el.paused && !el.ended && st.contextState === 'running';
  if (lastClock && st.clockMs) {
    const dClock = st.clockMs - lastClock;
    const dWall = now - lastClockWall;
    /* A track at a different sample rate gets a NEW AudioContext and the clock
       restarts at zero. That is not a dropout, and reporting it as "落后 356 s"
       (the first real capture did exactly that) is the instrument lying. */
    if (dClock < -100) noteEvent('音频上下文重建（换采样率，时钟归零）');
    const slip = dWall - dClock;
    if (dClock >= -100 && live && slip > 40) {
      const buffered = el.buffered.length ? el.buffered.end(el.buffered.length - 1) - el.currentTime : 0;
      noteEvent(`音频时钟落后 ${Math.round(slip)} ms · 静默 ${Math.round(silentMs)} ms · readyState ${el.readyState} · 缓冲 ${buffered.toFixed(1)}s`);
    }
  }
  if (st.clockMs) { lastClock = st.clockMs; lastClockWall = now; }
  const quiet = live && peakL < 1e-4 && peakR < 1e-4;
  silentMs = quiet ? silentMs + 100 : 0;
  if (silentMs === 1200) {
    noteEvent(`信号静默 1.2 s（在播放但分析器全 0）· readyState ${el.readyState}`);
    /* The one silence the app cannot undo from inside: the element's own volume,
       .muted, and whatever the browser's tab-mute button does to it all sit
       BEFORE MediaElementAudioSourceNode, so the analysers read zeros and the
       screen goes blank while the transport still says "playing". The app writes
       neither property any more, so seeing either set means someone else did —
       name that, instead of drawing nothing. */
    const silencedOutside = el.muted || el.volume === 0;
    core.toast(silencedOutside
      ? '正在播放但没有信号：标签页或元素被静音了'
      : '正在播放但分析器没有信号，检查音量与输出设备');
  }
}

function recordFrame(now) {
  const iv = flPrev ? now - flPrev : 0;
  flPrev = now;
  if (iv <= 0 || iv > 5000) return;
  flIv[flAt] = iv; flSeg[flAt] = flLastSeg;
  flHalo[flAt] = flLastHalo; flScale[flAt] = flResized ? 1 : 0;
  flT[flAt] = now;
  flResized = false;
  flAt = (flAt + 1) % FL_N;
  if (flFilled < FL_N) flFilled++;
}

/** The frame log as text. `seconds` limits it to the recent past. */
function perfLog(seconds = 0) {
  if (!flFilled) return '帧日志:还没有数据';
  const pick = [];
  let span = 0;
  for (let k = 0; k < flFilled; k++) {
    const i = (flAt - 1 - k + FL_N) % FL_N;
    pick.push(i); span += flIv[i];
    if (seconds && span >= seconds * 1000) break;
  }
  const iv = pick.map((i) => flIv[i]).sort((a, b) => a - b);
  const q = (p) => iv[Math.min(iv.length - 1, Math.floor(p * (iv.length - 1)))];
  const low = (f) => {
    const k = Math.max(1, Math.round(iv.length * f));
    let sum = 0;
    for (let i = iv.length - k; i < iv.length; i++) sum += iv[i];
    return 1000 / (sum / k);
  };
  const over = (t) => iv.filter((x) => x > t).length;
  /* Frames the browser itself stretched (hidden tab → rAF throttled to ~1 Hz, so
     its intervals are whole seconds). Counting them in the 1 % low makes the app
     look terrible for something it did not do — the first real capture's "0.1 %
     low 0.7 fps" was nine of these and nothing else. */
  const stretched = pick.filter((i) => flIv[i] > 900).length;
  const honest = pick.filter((i) => flIv[i] <= 900).map((i) => flIv[i]).sort((a, b) => a - b);
  const hq = (pp) => (honest.length ? honest[Math.min(honest.length - 1, Math.floor(pp * (honest.length - 1)))] : 0);
  const worst = pick.slice().sort((a, b) => flIv[b] - flIv[a]).slice(0, 6);
  const now = performance.now();
  const lines = [
    `帧日志:${(span / 1000).toFixed(1)}s / ${iv.length} 帧`,
    `  中位 ${q(0.5).toFixed(2)} ms (${(1000 / q(0.5)).toFixed(1)} fps) · p90 ${q(0.9).toFixed(2)} · p99 ${q(0.99).toFixed(2)} · p99.9 ${q(0.999).toFixed(2)} · 最差 ${iv[iv.length - 1].toFixed(1)} ms`,
    `  1% low ${low(0.01).toFixed(1)} fps · 0.1% low ${low(0.001).toFixed(1)} fps${stretched ? `（其中 ${stretched} 帧是浏览器把隐藏标签页的 rAF 拉长到整秒，见「可见性」事件）` : ''}`,
    stretched ? `  去掉被拉长的帧后:中位 ${hq(0.5).toFixed(2)} ms · p99 ${hq(0.99).toFixed(2)} · 最差 ${honest[honest.length - 1].toFixed(1)} ms` : '',
    `  超 20/33/50 ms 的帧:${over(20)} / ${over(33)} / ${over(50)}`,
    '  最差的几帧:',
  ];
  for (const i of worst) {
    lines.push(`    ${((flT[i] - now) / 1000).toFixed(1)}s  ${flIv[i].toFixed(1)} ms (${(1000 / flIv[i]).toFixed(1)} fps) · ${flSeg[i]} 段 · 光晕${flHalo[i] ? '开' : '关'}${flScale[i] ? ' · 该帧前刚 resize' : ''}`);
  }
  if (flEvents.length) {
    lines.push('  事件(负号 = 多少秒前):');
    for (const e of flEvents.slice(-14)) lines.push(`    ${((e.t - now) / 1000).toFixed(1)}s  ${e.what}`);
  }
  const text = lines.filter(Boolean).join('\n');
  console.log(text);
  return text;
}

function recordWork(ms) {
  WORK_RING[workPos] = ms;
  workPos = (workPos + 1) % WORK_RING.length;
  if (workFilled < WORK_RING.length) workFilled++;
}

function resetWorkStats() {
  workPos = 0;
  workFilled = 0;
  workAvg = 0;
  workP50 = 0;
}

function workSorted() {
  WORK_SORT.set(WORK_RING.subarray(0, workFilled));
  const a = WORK_SORT.subarray(0, workFilled);
  a.sort();
  return a;
}

function workStat(p) {
  if (!workFilled) return 0;
  const a = workSorted();
  return a[Math.min(workFilled - 1, Math.floor(p * (workFilled - 1)))];
}

/** Mean of the fastest `q` fraction — the load-proof cost estimate. */
function workTrimmed(q) {
  if (!workFilled) return 0;
  const a = workSorted();
  const n = Math.max(1, Math.floor(workFilled * q));
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i];
  return s / n;
}


/** The context of the frame that was just drawn (its interval is recorded at
    the top of the next tick, where the interval is actually known). */
export function setContext(segs, halo) { flLastSeg = segs; flLastHalo = halo; }
export function setPeaks(l, r) { peakL = l; peakR = r; }
/** A canvas resize is a prime suspect for a hitch: mark the next frame. */
export function noteResize(w, h, dpr) { flResized = true; noteEvent(`resize ${w}×${h} @${dpr}x`); }
export const workFilledCount = () => workFilled;

/* On its OWN TIMER, not on rAF: a hidden tab throttles rAF to about 1 Hz, and
   that is precisely the state in which a multi-second audio dropout would go
   unnoticed — which is what the first real capture showed. Timer callbacks keep
   firing (throttled, but firing) in a hidden tab. */
setInterval(() => watchAudio(performance.now()), 250);

/* Page lifecycle and long tasks: a frozen tab or a 200 ms task explains a stall
   that the frame log would otherwise only show as a number. */
for (const ev of ['freeze', 'resume', 'pagehide', 'pageshow']) {
  document.addEventListener(ev, () => noteEvent(`页面 ${ev}`));
}
document.addEventListener('visibilitychange', () => noteEvent(`可见性 ${document.visibilityState}`));
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) noteEvent(`长任务 ${Math.round(e.duration)} ms`);
  }).observe({ entryTypes: ['longtask'] });
} catch (e) { /* Firefox without the longtask entry type */ }

export {
  noteEvent,
  perfLog,
  recordFrame,
  recordWork,
  resetWorkStats,
  workSorted,
  workStat,
  workTrimmed,
};
