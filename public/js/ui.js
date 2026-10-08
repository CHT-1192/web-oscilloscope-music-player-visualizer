import * as core from './core.js';
import * as audio from './audio.js';
import * as media from './media.js';
import * as render from './render.js';
import * as apply from './apply.js';
import * as presets from './presets.js';
import * as playlist from './playlist.js';

/* The chrome: controls, keyboard, panels, drag & drop, the transport readout.
   Everything here is a consumer — it drives the other modules and owns no
   engine state of its own. */

const {
  $,
  DEFAULTS,
  FORMATTERS,
  PRESET_COLORS,
  PRESET_KEYS,
  S,
  clamp,
  dom,
  flags,
  fmtBytes,
  fmtTime,
  stamp,
  toast,
} = core;

const {
  applyAnalyserSize,
  applyRateMode,
  buildEngine,
  rateText,
} = audio;

const {
  applyScale,
  drawBackground,
  effectiveDpr,
  layout,
  state,
} = render;

const {
  applyAccent,
  syncControlsFromState,
} = apply;

const {
  noteSettingsChanged,
} = presets;

const {
  addLocalFiles,
  nextTrack,
  play,
  seekBy,
  setDemo,
  togglePlay,
  tracks,
} = playlist;

const uiCache = { cur: -1, dur: -1, seek: -1 };
let posPushed = -1;
/* The 原始样本 switch needs a second line, because on some files it is on and
   still not the source in use — the picture would then be coming from the
   element tap while the switch says otherwise. Name the one that is running.
   With no track loaded there is nothing to name, so the switch stands alone
   rather than reporting a source for audio that does not exist. */
function updatePcmNote() {
  const el = dom.pcmNote;
  if (!el) return;
  const st = audio.status();
  const p = st.pcm;
  const text = st.source === 'demo' || p.reason === '未载入' ? ''
    : !p.enabled ? '元素采样'
      : p.usable ? `原始样本 · ${fmtBytes(p.bytes)}`
        : `元素采样（${p.reason || (p.rateLimited ? '变速中' : '未就绪')}）`;
  if (el.textContent !== text) el.textContent = text;
}

function updateTransportUI() {
  updatePcmNote();
  const a = dom.audio;
  media.setPlaying(!a.paused);
  const cur = Number.isFinite(a.currentTime) ? a.currentTime : 0;
  const dur = Number.isFinite(a.duration) ? a.duration : 0;
  if (Math.abs(cur - uiCache.cur) >= 0.06 || Math.abs(dur - uiCache.dur) > 0.2) {
    uiCache.cur = cur;
    uiCache.dur = dur;
    dom.tCur.textContent = fmtTime(cur);
    dom.tDur.textContent = Number.isFinite(a.duration) ? fmtTime(dur) : '--:--';
    /* The OS progress bar. Once a second is plenty for a scrubber and each call
       is IPC, so it rides the same throttle as the readout above. */
    const sec = Math.floor(cur);
    if (dur > 0 && sec !== posPushed) { posPushed = sec; media.setPosition(dur, cur, a.playbackRate); }
    const pct = dur > 0 ? clamp((cur / dur) * 100, 0, 100) : 0;
    if (!seekHeld) {
      dom.seek.value = String(Math.round(pct * 10));
      dom.seek.style.setProperty('--p', pct.toFixed(2));
    }
  }
}
let seekHeld = false;

function bindControls() {
  /* The shortcuts table in the README was a lie: onKey survived the module split
     but nothing ever bound it, so space / arrows / , / . / D / S / F / O were all
     dead. Bind it here, where every other control gets wired. */
  document.addEventListener('keydown', onKey);
  /* The operating system's side of the transport: the media keys when the window
     is not focused, the Control Center buttons, and the Now Playing tile — whose
     artwork is the live figure. ui.js owns the transport, so it hands the hooks
     over; media.js knows nothing about playlists or pixels. */
  media.install({
    play: () => play(),
    pause: () => dom.audio.pause(),
    next: () => nextTrack(1),
    prev: () => nextTrack(-1),
    seekBy: (d) => seekBy(d),
    seekTo: (t) => { try { dom.audio.currentTime = t; } catch (err) { /* ignore */ } },
    frame: () => render.composite(),
  });
  for (const el of document.querySelectorAll('[data-set]')) {
    const key = el.dataset.set;
    const out = document.querySelector(`[data-out="${key}"]`);
    const onInput = () => {
      S[key] = el.type === 'range' ? parseFloat(el.value) : el.value;
      if (out) out.textContent = FORMATTERS[key](S[key]);
      if (key === 'color') applyAccent(S.color);
      if (key === 'windowIdx') { render.resetRefSpeed(); applyAnalyserSize(); }
      flags.redraw = true;
      noteSettingsChanged();
    };
    el.addEventListener('input', onInput);
  }
  // colour presets
  for (const c of PRESET_COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.dataset.color = c;
    b.style.setProperty('--c', c);
    b.title = c;
    b.addEventListener('click', () => {
      S.color = c;
      const input = document.querySelector('[data-set="color"]');
      input.value = c;
      const out = document.querySelector('[data-out="color"]');
      if (out) out.textContent = c.toUpperCase();
      applyAccent(c);
      flags.redraw = true;
      noteSettingsChanged();
    });
    dom.swatches.appendChild(b);
  }
  for (const btn of document.querySelectorAll('[data-toggle]')) {
    const key = btn.dataset.toggle;
    btn.setAttribute('aria-pressed', String(!!S[key]));
    btn.addEventListener('click', () => {
      S[key] = !S[key];
      btn.setAttribute('aria-pressed', String(S[key]));
      if (key === 'grid') drawBackground();
      if (key === 'trigger') render.resetRefSpeed();
      if (key === 'blanking') syncControlsFromState();   // enable/disable the threshold row
      /* 反向 flips the axis the gain readout describes, so the readout has to
         follow it: a bare "+1.00" next to an upside-down picture is a control
         lying about the value in use. */
      if (key === 'invertX' || key === 'invertY') {
        const gainKey = key === 'invertX' ? 'gainX' : 'gainY';
        const out = document.querySelector(`[data-out="${gainKey}"]`);
        if (out) out.textContent = FORMATTERS[gainKey](S[gainKey]);
      }
      flags.redraw = true;
      noteSettingsChanged();
    });
  }
  for (const el of document.querySelectorAll('[data-close]')) {
    el.addEventListener('click', () => $(el.dataset.close).classList.remove('open'));
  }
  // transport
  dom.btnPlay.addEventListener('click', togglePlay);
  dom.btnPrev.addEventListener('click', () => nextTrack(-1));
  dom.btnNext.addEventListener('click', () => nextTrack(1));
  dom.btnMode.addEventListener('click', () => playlist.cycleMode());

  /* Playlist tools. Clearing takes two clicks, like deleting a preset: the
     button next to it adds files, and that is not undoable. */
  dom.trackFilter.addEventListener('input', () => playlist.setFilter(dom.trackFilter.value));
  dom.trackSort.addEventListener('change', () => playlist.setSort(dom.trackSort.value));
  dom.btnSortDir.addEventListener('click', () => playlist.toggleSortDir());
  let clearArm = 0;
  const disarmClear = () => {
    if (!clearArm) return;
    window.clearTimeout(clearArm);
    clearArm = 0;
    dom.btnClear.classList.remove('armed');
    dom.btnClear.textContent = '清空';
  };
  dom.btnClear.addEventListener('click', () => {
    if (!clearArm) {
      clearArm = window.setTimeout(disarmClear, 2500);
      dom.btnClear.classList.add('armed');
      dom.btnClear.textContent = '确认清空';
      return;
    }
    disarmClear();
    playlist.clearTracks();
    toast('列表已清空，磁盘上的文件没动');
  });
  /* Closing the tab is the other moment the playhead is worth writing down;
     timeupdate alone can miss the last few seconds. */
  window.addEventListener('pagehide', () => playlist.flushPlayhead());
  dom.btnDemo.addEventListener('click', () => {
    const turningOn = !audio.isDemo();
    setDemo(turningOn);
    if (turningOn && !S.trigger) { S.trigger = true; syncControlsFromState(); }
    if (turningOn) toast('演示信号');
  });
  dom.btnSettings.addEventListener('click', () => togglePanel('panelSettings'));
  dom.btnList.addEventListener('click', () => togglePanel('panelList'));
  dom.btnFull.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => toast('无法进入全屏'));
  });
  dom.btnShot.addEventListener('click', screenshot);
  dom.btnReset.addEventListener('click', () => {
    resetSettings();
    toast('已恢复默认设置');
  });
  const openPicker = () => dom.fileInput.click();
  $('btnOpen').addEventListener('click', openPicker);
  $('hintOpen').addEventListener('click', (e) => { e.stopPropagation(); openPicker(); });
  dom.fileInput.addEventListener('change', () => {
    if (dom.fileInput.files && dom.fileInput.files.length) addLocalFiles(dom.fileInput.files);
    dom.fileInput.value = '';
  });
  dom.hint.addEventListener('click', () => { if (tracks.length || dom.audio.src) play(); });
  // seek
  dom.seek.addEventListener('pointerdown', () => { seekHeld = true; });
  dom.seek.addEventListener('input', () => {
    const d = dom.audio.duration;
    if (Number.isFinite(d) && d > 0) {
      const pct = Number(dom.seek.value) / 10;
      dom.seek.style.setProperty('--p', pct.toFixed(2));
      dom.audio.currentTime = (pct / 100) * d;
      dom.tCur.textContent = fmtTime(dom.audio.currentTime);
    }
    flags.redraw = true;
  });
  const releaseSeek = () => { seekHeld = false; };
  dom.seek.addEventListener('pointerup', releaseSeek);
  dom.seek.addEventListener('pointercancel', releaseSeek);
  dom.seek.addEventListener('change', releaseSeek);
  dom.volume.addEventListener('input', () => { audio.setVolume(dom.volume.value); });
  dom.rate.addEventListener('change', () => {
    dom.audio.preservesPitch = true;
    dom.audio.playbackRate = Number(dom.rate.value);
  });
  audio.setVolume(dom.volume.value);
  const rateModeSel = $('rateMode');
  if (rateModeSel) {
    rateModeSel.value = S.rateMode;
    rateModeSel.addEventListener('change', () => {
      S.rateMode = rateModeSel.value;
      applyRateMode();
      const eng = audio.status().engineRate;
      const srcRate = audio.status().sourceRate;
      toast(!eng ? '引擎跟随设备采样率'
        : !srcRate ? `引擎 ${rateText(eng)}`
          : `引擎 ${rateText(eng)} · ${eng === srcRate ? '原生' : `源 ${rateText(srcRate)} · 重采样`}`);
    });
  }
  const scaleSel = $('renderScale');    if (scaleSel) {
    scaleSel.value = S.renderScale;
    scaleSel.addEventListener('change', () => {
      S.renderScale = scaleSel.value;
      if (S.renderScale === 'auto') { render.resetQuality(); }
      applyScale();
      toast(`渲染缩放 ${Math.round(effectiveDpr() * 100)}%`);
    });
  }
  const perfBtn = $('btnPerf');
  if (perfBtn) perfBtn.addEventListener('click', () => setPerfMode(!perfSnapshot));
  window.addEventListener('resize', () => { if (layout()) flags.redraw = true; });
  if (window.ResizeObserver) {
    new ResizeObserver(() => { if (layout()) flags.redraw = true; }).observe(dom.stage);
  }
  document.addEventListener('fullscreenchange', () => { if (layout()) flags.redraw = true; });
}
/** Audio-element listeners. Re-attached every time the engine rebuilds the
    element (a new AudioContext needs a new <audio> — see buildEngine). */
function bindAudioEvents(el) {
  el.addEventListener('play', () => {
    dom.btnPlay.classList.add('playing');
    /* Always the CURRENT element (dom.audio), never the one this listener was
       bound to: changing the engine rate replaces the <audio>, and a `pause`
       from the element that was just replaced can be delivered after the new one
       has started — which left the panel saying "paused" while it was playing.
       updateTransportUI asks again ten times a second, so this is also
       self-correcting rather than a state that can drift. */
    media.setPlaying(!dom.audio.paused);
    flags.redraw = true;
  });
  el.addEventListener('pause', () => {
    dom.btnPlay.classList.remove('playing');
    media.setPlaying(!dom.audio.paused);
    playlist.flushPlayhead();
  });
  el.addEventListener('timeupdate', () => playlist.notePlayhead());
  el.addEventListener('loadedmetadata', () => playlist.noteDuration());
  el.addEventListener('ended', () => {
    dom.btnPlay.classList.remove('playing');
    media.setPlaying(!dom.audio.paused);
    /* What "ended" means is a playlist decision (顺序 / 单曲 / 随机), not a UI one. */
    playlist.advance();
  });
  /* Media trouble is exactly what "没声" looks like from the inside, and it is
     invisible while it is happening. Timestamp it into the frame log. */
  for (const ev of ['playing', 'pause', 'waiting', 'stalled', 'suspend', 'emptied']) {
    el.addEventListener(ev, () => render.noteEvent(`音频 ${ev}${el.error ? ' err' + el.error.code : ''}`));
  }
  el.addEventListener('error', () => {
    if (!el.src) return;
    const code = el.error ? el.error.code : 0;
    render.noteEvent(`音频 error code=${code}`);
    /* Chromium ships no decoder for some of these at all — canPlayType returns
       the empty string — so "cannot decode" is true but useless: it sends people
       off to re-encode a file that was never broken. Name it instead. */
    const t = playlist.currentTrack();
    const noDecoder = { ALAC: 'ALAC', AIFF: 'AIFF', AIFC: 'AIFF-C', CAF: 'CAF' };
    const named = t && (noDecoder[t.codec] || noDecoder[t.format]);
    if (code === 4 && named) {
      toast(`此浏览器不支持 ${named}（Safari 可以）`);
      return;
    }
    toast(code === 4 ? '浏览器无法解码此文件' : '音频加载失败');
  });
  el.addEventListener('seeking', () => { flags.redraw = true; });
  el.addEventListener('loadedmetadata', () => {
    uiCache.dur = -1;
    flags.redraw = true;
  });
}
/** Restore every setting to its default, including the derived state that
    syncControlsFromState() alone does not touch (analyser size, render
    scale, smoothing accumulators). Forgetting the analyser size here left a
    4096-sample window being drawn out of a 1024-sample buffer. */
/** Switch the visible source to/from the built-in demo. audio.js owns the
    graph; the titles, the button, the preset memory and the render state are
    this layer's business — which is why the engine takes a hook instead. */

function resetSettings() {
  Object.assign(S, DEFAULTS);
  render.resetQuality();
  render.resetTraceState({ settle: true });
  syncControlsFromState();
  applyAnalyserSize();
  applyScale();
  drawBackground();
  presets.setActivePreset('默认');   // defaults ARE the 默认 preset, for the keys it covers
  noteSettingsChanged();
}
/** One-click low-power preset. The levers are chosen from measurements in
    test/bench.js: the per-frame cost is dominated by how many segments get
    drawn, so shrinking the window is what actually helps (32768 -> 1024 took
    a frame from 1.49 ms to 0.08 ms). Render scale barely moved the needle. */
let perfSnapshot = null;
function setPerfMode(on) {
  const btn = $('btnPerf');
  if (on) {
    if (!perfSnapshot) {
      perfSnapshot = {
        windowIdx: S.windowIdx, grid: S.grid, persistence: S.persistence,
        rateMode: S.rateMode, renderScale: S.renderScale,
      };
    }
    S.windowIdx = 2;        // 2048 samples
    S.grid = false;
    S.persistence = 45;
    S.rateMode = 'device';  // let the audio graph run at the device rate
    S.renderScale = '0.75';
  } else if (perfSnapshot) {
    Object.assign(S, perfSnapshot);
    perfSnapshot = null;
  }
  if (btn) btn.setAttribute('aria-pressed', String(!!on));
  syncControlsFromState();
  applyAnalyserSize();
  applyRateMode();
  applyScale();
  drawBackground();
  render.resetRefSpeed();
  flags.settle = 100;
  presets.setActivePreset(null);   // perf mode is a machine setting, not a preset
  noteSettingsChanged();
  toast(on ? '性能模式：开' : '性能模式：关');
}
function togglePanel(id) {
  const p = $(id);
  const open = !p.classList.contains('open');
  p.classList.toggle('open', open);
  $(id === 'panelSettings' ? 'btnSettings' : 'btnList').classList.toggle('on', open);
  if (layout()) { flags.redraw = true; flags.settle = 100; }   // the plot may need to give up margin
  // Left and right rails are independent now that they reserve their own
  // space, so both panels can be open at once.
}
function screenshot() {
  const c = render.composite();
  if (!c) return;
  c.toBlob((blob) => {
    if (!blob) return toast('截图失败');
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = `oscilloscope-${stamp()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
    toast('已保存 PNG');
  }, 'image/png');
}

/* Which focused element owns the keyboard.
   Text entry owns all of it: a space there is a space, and the playlist filter is
   meant to be typed in. A RANGE does not. It keeps focus after you drag it, and
   the guard here used to match `input` of ANY kind, so after touching 音量 or the
   seek bar every shortcut was swallowed — space did nothing at all until you
   clicked somewhere else. A slider does use its arrows (and Home/End/Page), so
   those stay with it: never take a key the focused control uses, never swallow
   one it does not. */
const SLIDER_KEYS = /^(Arrow(Left|Right|Up|Down)|Home|End|Page(Up|Down))$/;
function ownsKeyboard(el, key) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  if (el.type !== 'range') return true;
  /* A slider owns its arrows, with one exception: 音量 and the seek bar are the
     transport, and their arrows are the documented shortcut (⇧5 s / ±0.05). */
  if (el === dom.volume || el === dom.seek) return false;
  return SLIDER_KEYS.test(key);
}

function onKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  /* The keyboard's media keys (F7 / F8 / F9 on a Mac) are the system's transport
     controls, so they are handled before anything else can claim the keyboard.
     Measured: the event arrives as an ordinary keydown whose target is whatever
     has FOCUS — a text field or a slider included — with key 'MediaPlayPause',
     so the ownership test below would otherwise swallow it. Holding one of them
     repeats, hence the guard. */
  switch (e.key) {
    case 'MediaPlayPause': e.preventDefault(); if (!e.repeat) togglePlay(); return;
    case 'MediaTrackNext': e.preventDefault(); if (!e.repeat) nextTrack(1); return;
    case 'MediaTrackPrevious': e.preventDefault(); if (!e.repeat) nextTrack(-1); return;
    case 'MediaStop': e.preventDefault(); dom.audio.pause(); return;
    default: break;
  }
  /* A composing IME owns the keyboard, space included: that space is how you
     commit a candidate, not a play/pause. keyCode 229 is the same thing in the
     legacy encoding, and some IMEs report only that. */
  if (e.isComposing || e.keyCode === 229) return;
  /* `code` is the physical key and does not go through the IME, so a space that
     arrives as 'Process' (an IME enabled but not composing) is still a space. */
  const key = e.key === 'Process' && e.code === 'Space' ? ' ' : e.key;
  if (ownsKeyboard(e.target, key) && key !== 'Escape') return;
  switch (key) {
    case ' ': case 'Spacebar': case 'k': case 'K':
      e.preventDefault();
      if (e.repeat) break;               // holding it must not stutter the transport
      togglePlay(); break;
    case 'ArrowLeft': e.preventDefault(); seekBy(-5); break;
    case 'ArrowRight': e.preventDefault(); seekBy(5); break;
    case 'ArrowUp':
      e.preventDefault();
      dom.volume.value = String(clamp(Number(dom.volume.value) + 0.05, 0, 1));
      toast(`音量 ${Math.round(audio.setVolume(dom.volume.value) * 100)}%`);
      break;
    case 'ArrowDown':
      e.preventDefault();
      dom.volume.value = String(clamp(Number(dom.volume.value) - 0.05, 0, 1));
      toast(`音量 ${Math.round(audio.setVolume(dom.volume.value) * 100)}%`);
      break;
    case ',': nextTrack(-1); break;
    case '.': nextTrack(1); break;
    case 'd': case 'D': {
      const on = !audio.isDemo();
      setDemo(on);
      if (on && !S.trigger) { S.trigger = true; syncControlsFromState(); }
      break;
    }
    case 'l': togglePanel('panelList'); break;
    case 'm': case 'M': playlist.cycleMode(); break;
    /* Shift+L rather than plain L: the log is a diagnostic, the playlist is what
       people actually use, and a dead duplicate `case 'l'` was hiding the
       collision until the docs were read against the code. */
    case 'L':
      render.perfLog();
      toast('帧统计已输出到控制台');
      break;
    case 'p': case 'P': togglePanel('panelSettings'); break;
    case 'f': case 'F':
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
      break;
    case 's': case 'S': screenshot(); break;
    case 'g': case 'G': S.grid = !S.grid; syncControlsFromState(); drawBackground(); flags.redraw = true; break;
    case 'b': case 'B': S.blanking = !S.blanking; syncControlsFromState(); toast('速度消隐 ' + (S.blanking ? '开' : '关')); break;
    case 't': case 'T': S.trigger = !S.trigger; syncControlsFromState(); render.resetRefSpeed(); toast('相位锁定 ' + (S.trigger ? '开' : '关')); break;
    case 'r': case 'R':
      resetSettings();
      toast('已恢复默认设置'); break;
    case 'o': case 'O':
      setPerfMode(!perfSnapshot); break;
    case 'Escape':
      dom.panelSettings.classList.remove('open');
      dom.panelList.classList.remove('open');
      dom.btnSettings.classList.remove('on');
      dom.btnList.classList.remove('on');
      break;
    default: break;
  }
}

function bindDragDrop() {
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    depth++;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    depth = Math.max(0, depth - 1);
    if (!depth) document.body.classList.remove('dragging');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      addLocalFiles(e.dataTransfer.files);
    }
  });
  // hide the chrome when the pointer is idle and not over any control
  let idleTimer = 0;
  let overUI = false;
  const wake = () => {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const panelOpen = document.querySelector('.panel.open');
      if (!overUI && !panelOpen && !document.body.classList.contains('dragging')) {
        document.body.classList.add('idle');
      }
    }, 3200);
  };
  for (const el of [document.querySelector('.dock'), document.querySelector('.topbar')]) {
    el.addEventListener('pointerenter', () => { overUI = true; wake(); });
    el.addEventListener('pointerleave', () => { overUI = false; wake(); });
  }
  for (const el of [dom.panelSettings, dom.panelList]) {
    el.addEventListener('pointerenter', () => { overUI = true; wake(); });
    el.addEventListener('pointerleave', () => { overUI = false; wake(); });
  }
  window.addEventListener('pointermove', wake, { passive: true });
  window.addEventListener('pointerdown', wake, { passive: true });
  wake();
}


export {
  bindAudioEvents,
  bindControls,
  bindDragDrop,
  onKey,
  resetSettings,
  screenshot,
  setPerfMode,
  togglePanel,
  uiCache,
  updateTransportUI,
};
