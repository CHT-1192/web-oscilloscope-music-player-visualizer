import * as core from './core.js';
import * as audio from './audio.js';
import * as render from './render.js';

/* The bridge between the settings object and everything it drives: a plain
   object in, every control / engine / pixel out. Both the preset layer and the
   control panel go through here, so "the sliders show what is rendering" is
   decided in one place. */

const {
  $,
  DEFAULTS,
  FORMATTERS,
  PRESET_KEYS,
  S,
  dom,
  flags,
} = core;



const {
  drawBackground,
  rendererKind,
} = render;

function applyAccent(color) {
  document.documentElement.style.setProperty('--accent', color);
  for (const sw of dom.swatches.children) {
    sw.classList.toggle('active', sw.dataset.color.toLowerCase() === String(color).toLowerCase());
  }
  drawBackground();   // the graticule is tinted from the same colour
  flags.redraw = true;
}
/* Two rows describe the RENDERER rather than the signal: 残留 is the 8-bit
   quantisation floor (Canvas path only — the energy renderer has no floor to
   scrub) and 光晕 is the energy renderer's dose-dependent spot (the Canvas path
   strokes a constant width). A slider that moves and changes nothing is a
   control lying about the value in use, so the inert one is disabled and the
   label says why. The real title lives in `data-title` so both can coexist. */
function rendererOnlyRow(key, active, why) {
  const el = document.querySelector(`[data-set="${key}"]`);
  if (!el) return;
  if (!el.dataset.title) el.dataset.title = el.title || '';
  el.disabled = !active;
  el.title = active ? el.dataset.title : why;
  if (el.parentElement) el.parentElement.classList.toggle('is-off', !active);
}

function syncControlsFromState() {
  for (const el of document.querySelectorAll('[data-set]')) {
    el.value = S[el.dataset.set];
    const out = document.querySelector(`[data-out="${el.dataset.set}"]`);
    if (out) out.textContent = FORMATTERS[el.dataset.set](S[el.dataset.set]);
  }
  for (const btn of document.querySelectorAll('[data-toggle]')) {
    btn.setAttribute('aria-pressed', String(!!S[btn.dataset.toggle]));
  }
  const rm = $('rateMode');
  if (rm) rm.value = S.rateMode;
  const rs = $('renderScale');
  if (rs) rs.value = S.renderScale;
  const br = document.querySelector('[data-set="blankRatio"]');
  if (br) {
    br.disabled = !S.blanking;
    if (br.parentElement) br.parentElement.classList.toggle('is-off', !S.blanking);
  }
  const gl2 = rendererKind() === 'webgl2';
  rendererOnlyRow('halo', gl2, '光晕需要 WebGL 能量渲染器（当前是 Canvas 2D 回退）');
  rendererOnlyRow('residue', !gl2, '残留是 8 位路径的量化地板，能量渲染器没有地板要擦（当前是 WebGL）');
  applyAccent(S.color);
}

function snapToControl(key, n) {
  const el = document.querySelector(`[data-set="${key}"]`);
  let v = n;
  if (!el) return v;
  const min = Number(el.min);
  const max = Number(el.max);
  const step = Number(el.step);
  if (Number.isFinite(step) && step > 0) {
    const base = Number.isFinite(min) ? min : 0;
    v = Number((base + Math.round((v - base) / step) * step).toFixed(4));
  }
  if (Number.isFinite(min)) v = Math.max(min, v);
  if (Number.isFinite(max)) v = Math.min(max, v);
  return v;
}
/** Keep only keys we know, with types the UI can express. */
function sanitizeSettings(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of PRESET_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, k)) continue;
    const ref = DEFAULTS[k];
    const v = raw[k];
    if (typeof ref === 'number') {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = snapToControl(k, k === 'windowIdx' ? Math.round(n) : n);
    } else if (typeof ref === 'boolean') {
      out[k] = v === true || v === 'true' || v === 1;
    } else if (k === 'color') {
      if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) out[k] = v.toLowerCase();
    }
  }
  return out;
}
function captureSettings() {
  const out = {};
  for (const k of PRESET_KEYS) out[k] = S[k];
  return out;
}
function settingsEqual(a, b) {
  if (!a || !b) return false;
  for (const k of PRESET_KEYS) {
    const x = a[k];
    const y = b[k];
    if (typeof x === 'number' && typeof y === 'number') {
      if (Math.abs(x - y) > 1e-6) return false;
    } else if (x !== y) return false;
  }
  return true;
}

function applySettings(raw) {
  Object.assign(S, sanitizeSettings(raw));
  render.resetTraceState({ settle: true });
  syncControlsFromState();     // sliders, toggles, colour and the dependent rows
  audio.applyAnalyserSize();   // the window may have moved
}


export {
  applyAccent,
  applySettings,
  captureSettings,
  sanitizeSettings,
  settingsEqual,
  snapToControl,
  syncControlsFromState,
};
