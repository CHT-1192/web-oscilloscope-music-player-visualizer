/* ============================================================================
    core.js — the leaves: shorthands, the settings object, DOM refs, toast

    Nothing here depends on anything else in the app, which is what lets every
    other module import it without a cycle. `S` and `dom` are exported as
    objects on purpose: callers mutate their fields, and a shared object
    reference survives being imported, while a re-exported primitive would not.
   ========================================================================== */

/* ------------------------------------------------------------------ utils */

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const TAU = Math.PI * 2;

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}
function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '--:--';
  const t = Math.floor(sec);
  const m = Math.floor(t / 60);
  const s = t % 60;
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
function fmtHz(hz) {
  if (!hz) return null;
  return `${(hz / 1000).toFixed(hz % 1000 ? 1 : 0)} kHz`;
}
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
/* --------------------------------------------------------------- settings */

/** Analyser window sizes, in samples. Index is what the slider moves over. */
const WINDOW_CHOICES = [512, 1024, 2048, 4096, 8192, 16384, 32768];
const MAXN = 32768;          // analyser fftSize — the largest window we can show
const BUCKETS = 10;          // velocity-blanking brightness levels (bucket 0 = blanked)

/* The defaults are the midpoint of the two shipped recipes (描边 / 填充, see
   the table in README) — a trade-off, not an optimum. The optimum really does
   depend on the track; that is what the presets are for.
   What is NOT a trade-off is the blow-out bound, and that one is measured.
   Sweeping window x afterglow over the busiest passage of a line-type track,
   24 % keeps the saturated share at 0.66 % of the ink, whereas 62 % (the old
   default) pushed it to 5.3 % at 2048 and 12.8 % at 4096 — a picture that has
   dissolved into a solid mass. 2048 is the largest window that still stays
   under ~1 %, because a 4096 window already self-overlaps within one frame.
   blankRatio is the one default deliberately below the midpoint. Frozen window,
   15x as the reference (nothing blanked): 10x drops 4.0 / 5.3 / 0.4 % of the
   lit ink on 方块 / 穿梭 / 棋盘格, 3x drops 9.7 / 15.2 / 9.4 %. What 3x takes
   that 10x kept is the 3x-10x band of beam speeds: fast, but not obviously a
   retrace. That lands on the material's own fastest sweeps, which is why a
   穿梭 passage is where it shows, so raise it per track from there.
     窗口 (1 + 3) / 2 = 2 · 余辉 (16 + 32) / 2 = 24 · 线宽 (1.15 + 2.3) / 2 ≈ 1.75 */
const DEFAULTS = {
  gainX: 1, gainY: 1, offX: 0, offY: 0,
  windowIdx: 2,
  intensity: 0.9, lineWidth: 1.75, persistence: 24, residue: 0,
  blankRatio: 3, halo: 0,
  color: '#3dff9c',
  rateMode: 'auto',
  renderScale: 'auto',
  blanking: true, trigger: false, autoGain: false, grid: true, beamDot: false,
  invertX: false, invertY: false,
};
const S = Object.assign({}, DEFAULTS);
const winSize = () => WINDOW_CHOICES[clamp(S.windowIdx | 0, 0, WINDOW_CHOICES.length - 1)];

/** Flags any module may set and only the render loop clears.
    They live here, not in render.js, because the audio graph, the settings
    bridge and the UI all invalidate the picture — and audio.js must not depend
    on render.js (render depends on audio for the samples). */
const flags = { redraw: true, settle: 0 };

/** The keys a preset carries. rateMode and renderScale describe the machine you
    happen to be on, so a preset must not carry them to someone else's laptop. */
const PRESET_KEYS = Object.keys(DEFAULTS).filter((k) => k !== 'rateMode' && k !== 'renderScale');

const FORMATTERS = {
  // The readout carries the sign the mapping actually uses, so a flipped axis
  // never shows a bare "+1.00" next to a picture that is upside down.
  gainX: (v) => (S.invertX ? '-' : '') + Number(v).toFixed(2),
  gainY: (v) => (S.invertY ? '-' : '') + Number(v).toFixed(2),
  offX: (v) => Number(v).toFixed(2),
  offY: (v) => Number(v).toFixed(2),
  windowIdx: () => winSize().toLocaleString('en-US'),
  intensity: (v) => Number(v).toFixed(2),
  lineWidth: (v) => Number(v).toFixed(2) + ' px',
  persistence: (v) => Math.round(v) + ' %',
  residue: (v) => (v <= 0 ? '关' : Math.round(v) + ' %'),
  blankRatio: (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)) + '×',
  halo: (v) => (v <= 0 ? '关' : Math.round(v) + ' %'),
  color: (v) => String(v).toUpperCase(),
};

const PRESET_COLORS = ['#3dff9c', '#7ef9ff', '#ffd166', '#ff6b8a', '#c4a7ff', '#eef4f2'];
/* -------------------------------------------------------------------- dom */

const dom = {
  stage: $('stage'), bg: $('bg'), trace: $('trace'), audio: $('audio'),
  hint: $('dropHint'), hintNote: $('hintNote'),
  trackTitle: $('trackTitle'), trackSub: $('trackSub'),
  seek: $('seek'), tCur: $('tCur'), tDur: $('tDur'),
  volume: $('volume'), rate: $('rate'),
  btnPlay: $('btnPlay'), btnPrev: $('btnPrev'), btnNext: $('btnNext'),
  btnSettings: $('btnSettings'), btnList: $('btnList'), btnDemo: $('btnDemo'),
  btnShot: $('btnShot'), btnFull: $('btnFull'), btnReset: $('btnReset'),
  modelBadge: $('modelBadge'),
  panelSettings: $('panelSettings'), panelList: $('panelList'),
  trackList: $('trackList'), listCount: $('listCount'),
  trackFilter: $('trackFilter'), trackSort: $('trackSort'),
  btnSortDir: $('btnSortDir'), btnClear: $('btnClear'), btnMode: $('btnMode'),
  fileInput: $('fileInput'), toast: $('toast'), swatches: $('swatches'),
  presetMode: $('presetMode'), presetChips: $('presetChips'), presetStatus: $('presetStatus'),
  presetRow: $('presetRow'), presetName: $('presetName'), presetText: $('presetText'),
};
/* ------------------------------------------------------------- hint/toast */

let toastTimer = 0;
function toast(msg) {
  dom.toast.textContent = msg;
  dom.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dom.toast.classList.remove('show'), 2600);
}

function setHint(show) {
  dom.hint.classList.toggle('hidden', !show);
}

export {
  $,
  clamp,
  TAU,
  fmtBytes,
  fmtTime,
  fmtHz,
  stamp,
  WINDOW_CHOICES,
  MAXN,
  BUCKETS,
  DEFAULTS,
  S,
  winSize,
  PRESET_COLORS,
  flags,
  PRESET_KEYS,
  FORMATTERS,
  dom,
  toast,
  setHint,
};
