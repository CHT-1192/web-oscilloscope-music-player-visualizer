/* ============================================================================
 *  Web Oscilloscope Music Player / Visualizer
 *  ---------------------------------------------------------------------------
 *  Renders a stereo signal as an X/Y beam path:  left channel -> X, right -> Y.
 *
 *  DESIGN CONSTRAINTS (explicitly requested)
 *  ---------------------------------------------------------------------------
 *  1. NO RETRACE LINES (无回扫线)
 *     - A trace path is never `closePath()`d, so the beam never jumps from the
 *       end of a sweep back to its start.
 *     - Every frame starts a fresh sub-path with `moveTo()`; segments are never
 *       joined across analysis frames, so no wrap-around chord is ever drawn.
 *     - Optional VELOCITY BLANKING dims fast beam movements (brightness ∝ 1/v).
 *       Retrace/blanking sweeps in oscilloscope music are fast, so they fade to
 *       near-invisible exactly as they do on a real CRT — this is the principled
 *       way to kill retrace lines, not a post-process trick.
 *
 *  2. NO GLOW (无辉光)
 *     - No `shadowBlur` / `shadowColor`, no bloom pass.
 *     - No `globalCompositeOperation = 'lighter'` (additive) accumulation.
 *     - No CSS blur/drop-shadow filter anywhere near the canvas.
 *     - Afterglow uses `destination-out` alpha decay: pixels only ever get
 *       *dimmer*, they never add brightness to their neighbours.
 * ========================================================================== */
(function () {
  'use strict';

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

  const DEFAULTS = {
    gainX: 1, gainY: 1, offX: 0, offY: 0,
    windowIdx: 3,
    intensity: 0.9, lineWidth: 1.15, persistence: 62, burnIn: 0, residue: 0,
    blankRatio: 10,
    color: '#3dff9c',
    rateMode: 'auto',
    renderScale: 'auto',
    blanking: true, trigger: false, autoGain: false, grid: true, beamDot: false,
  };
  const S = Object.assign({}, DEFAULTS);
  const winSize = () => WINDOW_CHOICES[clamp(S.windowIdx | 0, 0, WINDOW_CHOICES.length - 1)];

  const PRESET_COLORS = ['#3dff9c', '#7ef9ff', '#ffd166', '#ff6b8a', '#c4a7ff', '#eef4f2'];

  /* -------------------------------------------------------------------- dom */

  const dom = {
    stage: $('stage'), bg: $('bg'), burnin: $('burnin'), trace: $('trace'), audio: $('audio'),
    hint: $('dropHint'), hintNote: $('hintNote'),
    trackTitle: $('trackTitle'), trackSub: $('trackSub'),
    seek: $('seek'), tCur: $('tCur'), tDur: $('tDur'),
    volume: $('volume'), rate: $('rate'),
    btnPlay: $('btnPlay'), btnPrev: $('btnPrev'), btnNext: $('btnNext'),
    btnSettings: $('btnSettings'), btnList: $('btnList'), btnDemo: $('btnDemo'),
    btnShot: $('btnShot'), btnFull: $('btnFull'), btnReset: $('btnReset'),
    panelSettings: $('panelSettings'), panelList: $('panelList'),
    trackList: $('trackList'), listCount: $('listCount'),
    fileInput: $('fileInput'), toast: $('toast'), swatches: $('swatches'),
  };

  const bctx = dom.bg.getContext('2d');
  const nctx = dom.burnin.getContext('2d');   // burn-in layer
  const tctx = dom.trace.getContext('2d');

  /* --------------------------------------------------------------- geometry */

  let W = 0, H = 0, DPR = 1;          // canvas size, in device pixels
  let PLOT = 0, PLOT_X = 0, PLOT_Y = 0; // square plotting area (keeps circles round)

  /* Adaptive resolution. Canvas cost scales with pixel count, so on a slow
     machine the cheapest big win is to render fewer pixels and let the browser
     upscale. autoScale drops (and recovers) in 1/8 steps based on measured
     render time; it never goes below 0.5. */
  const SCALE_MIN = 0.5;
  let autoScale = 1;
  let workAvg = 0;            // ms spent inside the render section, smoothed
  let workP50 = 0;            // median of the rolling window
  let qualityCooldown = 0;
  let workStatCountdown = 30;

  /* Rolling window of per-frame render times.
   *
   *  performance.now() is quantised to 100 us in Chrome, which is coarser than
   *  the differences worth measuring, so no single sample is useful. Two
   *  properties make the window work anyway:
   *    - averaging many quantised samples recovers sub-quantum resolution;
   *    - background load (another app, a compile) can only ever ADD slow
   *      frames, so it shows up purely as a right tail.
   *  So `trimmed()` — the mean of the fastest quarter — is both sub-quantum
   *  accurate and insensitive to whatever else the machine is doing.
   *
   *  Keep the window SHORT (~2 s): a long one both slows the quality
   *  adaptation down and, when a measurement starts, is still full of stale
   *  frames from before the change. */
  const WORK_RING = new Float32Array(120);
  const WORK_SORT = new Float32Array(120);
  let workPos = 0;
  let workFilled = 0;

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

  function effectiveDpr() {
    const base = clamp(window.devicePixelRatio || 1, 1, 3);
    const mul = S.renderScale === 'auto' ? autoScale : Number(S.renderScale);
    return clamp(base * (Number.isFinite(mul) && mul > 0 ? mul : 1), 0.4, 3);
  }

  /** How far the open side panels reach into the stage, in CSS px. The canvas
   *  itself is never resized for a panel; only the PLOT gives up room, and only
   *  as much as it must. On a wide window the square plot has a margin wide
   *  enough to hide a whole panel, so nothing moves at all. */
  function panelInset() {
    const stage = dom.stage.getBoundingClientRect();
    if (!stage.width) return 0;
    const mid = (stage.left + stage.right) / 2;
    let inset = 0;
    for (const el of [dom.panelList, dom.panelSettings]) {
      if (!el || !el.classList.contains('open')) continue;
      const r = el.getBoundingClientRect();
      // measure the intrusion from the edge the panel actually sits on
      const onRight = (r.left + r.right) / 2 > mid;
      inset = Math.max(inset, onRight ? stage.right - r.left : r.right - stage.left);
    }
    return Math.max(0, inset);
  }

  let lastInset = -1;

  function layout() {
    const rect = dom.stage.getBoundingClientRect();
    const dpr = effectiveDpr();
    const w = Math.max(2, Math.round((rect.width || window.innerWidth) * dpr));
    const h = Math.max(2, Math.round((rect.height || window.innerHeight) * dpr));
    const inset = panelInset();
    if (w === W && h === H && dpr === DPR && inset === lastInset) return false;
    lastInset = inset;

    DPR = dpr; W = w; H = h;
    dom.bg.width = W; dom.bg.height = H;           // redrawn from scratch below
    resizeKeeping(dom.burnin, nctx);
    resizeKeeping(dom.trace, tctx);

    // Stay centred in the canvas and only shrink when a panel genuinely does
    // not fit in the margin beside the plot. Using max() rather than the sum
    // keeps it centred, so opening one panel never shoves the plot sideways.
    const margin = inset * dpr;
    PLOT = Math.max(64 * dpr, Math.min(H * 0.9, (W - 2 * margin) * 0.96));
    PLOT_X = (W - PLOT) / 2;
    PLOT_Y = (H - PLOT) / 2;

    drawBackground();
    return true;
  }

  /** Resize a canvas without throwing away what is already on it.
   *  Assigning canvas.width clears the bitmap, which would silently destroy the
   *  accumulated afterglow / burn-in on every window resize or fullscreen
   *  toggle — and the whole point of those layers is that they persist. */
  function resizeKeeping(canvas, ctx) {
    const ow = canvas.width, oh = canvas.height;
    if (!ow || !oh) { canvas.width = W; canvas.height = H; return; }
    const off = document.createElement('canvas');
    off.width = ow; off.height = oh;
    off.getContext('2d').drawImage(canvas, 0, 0);
    canvas.width = W; canvas.height = H;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(off, 0, 0, ow, oh, 0, 0, W, H);   // rescaled to the new size
  }

  /** Force a fresh layout after the resolution changed. */
  function applyScale() {
    W = 0; H = 0;
    if (layout()) { needsRedraw = true; settle = 100; }
    updatePerfBadge();
    const out = document.querySelector('[data-out="renderScale"]');
    if (out) {
      out.textContent = scaleLabel();
      out.title = `画布 ${W}×${H} 设备像素`;
    }
  }

  const scaleLabel = () => `${Math.round(effectiveDpr() * 100)}%`;

  function updatePerfBadge() {
    const el = $('perfBadge');
    if (!el) return;
    const reduced = S.renderScale === 'auto' && autoScale < 1;
    el.textContent = `画质 ${Math.round(autoScale * 100)}%`;
    el.className = 'rate-badge perf-badge' + (reduced ? ' is-warn' : '');
    el.hidden = !reduced;
  }

  /** Shrink the render target when a frame costs too much, grow it back when
   *  there is headroom.
   *
   *  Driven by the MEDIAN of a rolling window rather than a mean: a single
   *  slow frame (GC pause, another app on the machine, a compile in the
   *  background) should not trigger a resolution drop, and the median is what
   *  a mean cannot give us. */
  function adaptQuality(workMs) {
    recordWork(workMs);
    workAvg += (workMs - workAvg) * 0.08;

    if (qualityCooldown > 0) qualityCooldown--;
    if (--workStatCountdown > 0) return;
    workStatCountdown = 30;

    workP50 = workTrimmed(0.5);
    updatePerfBadge();
    if (S.renderScale !== 'auto' || qualityCooldown > 0) return;

    if (workP50 > 10 && autoScale > SCALE_MIN) {
      autoScale = Math.max(SCALE_MIN, autoScale - 0.125);
      qualityCooldown = 120;
      applyScale();
    } else if (workP50 < 3.5 && autoScale < 1) {
      autoScale = Math.min(1, autoScale + 0.125);
      qualityCooldown = 120;
      applyScale();
    }
  }

  /* --------------------------------------------------- static background/grid */

  function hexToRgb(hex) {
    let h = String(hex || '').trim().replace(/^#/, '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    if (h.length !== 6 || !Number.isFinite(n)) return { r: 120, g: 190, b: 175 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function drawBackground() {
    const g = bctx;
    // Graticule inherits the beam colour so it never clashes with it.
    const c = hexToRgb(S.color);
    const tint = (a) => `rgba(${c.r},${c.g},${c.b},${a})`;

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, W, H);

    g.fillStyle = '#03060a';
    g.fillRect(0, 0, W, H);

    // Vignette: the edges are simply *darker* than the centre. Nothing here
    // adds light around the beam, so it cannot read as glow.
    const vg = g.createRadialGradient(W / 2, H / 2, PLOT * 0.15, W / 2, H / 2, Math.max(W, H) * 0.78);
    vg.addColorStop(0, 'rgba(13,24,28,0.92)');
    vg.addColorStop(0.55, 'rgba(6,11,15,0.92)');
    vg.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = vg;
    g.fillRect(0, 0, W, H);

    if (!S.grid) return;

    const lw = Math.max(1, Math.round(DPR));
    const snap = (v) => (lw % 2 ? Math.round(v) + 0.5 : Math.round(v));
    const DIV = 10;
    const x0 = PLOT_X, y0 = PLOT_Y, s = PLOT;
    const x1 = x0 + s, y1 = y0 + s;

    g.lineWidth = lw;

    // fine graticule
    g.strokeStyle = tint(0.07);
    g.beginPath();
    for (let i = 1; i < DIV; i++) {
      const px = snap(x0 + (s * i) / DIV);
      const py = snap(y0 + (s * i) / DIV);
      g.moveTo(px, snap(y0)); g.lineTo(px, snap(y1));
      g.moveTo(snap(x0), py); g.lineTo(snap(x1), py);
    }
    g.stroke();

    // centre axes
    g.strokeStyle = tint(0.17);
    g.beginPath();
    g.moveTo(snap(x0 + s / 2), snap(y0)); g.lineTo(snap(x0 + s / 2), snap(y1));
    g.moveTo(snap(x0), snap(y0 + s / 2)); g.lineTo(snap(x1), snap(y0 + s / 2));
    g.stroke();

    // frame
    g.strokeStyle = tint(0.24);
    g.strokeRect(snap(x0), snap(y0), Math.round(s), Math.round(s));

    // edge ticks
    g.strokeStyle = tint(0.30);
    g.beginPath();
    const tick = 5 * DPR;
    const N = DIV * 5;
    for (let i = 1; i < N; i++) {
      const p = (s * i) / N;
      const len = i % 5 === 0 ? tick * 1.7 : tick;
      const px = snap(x0 + p), py = snap(y0 + p);
      g.moveTo(px, snap(y0)); g.lineTo(px, snap(y0 + len));
      g.moveTo(px, snap(y1)); g.lineTo(px, snap(y1 - len));
      g.moveTo(snap(x0), py); g.lineTo(snap(x0 + len), py);
      g.moveTo(snap(x1), py); g.lineTo(snap(x1 - len), py);
    }
    g.stroke();

    // axis captions
    g.fillStyle = tint(0.34);
    g.font = `${Math.round(9.5 * DPR)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    g.textBaseline = 'top';
    g.fillText('X ← L', snap(x0 + 8), snap(y0 + 6));
    g.textBaseline = 'bottom';
    g.fillText('Y ← R', snap(x0 + 8), snap(y1 - 6));
  }

  /* ----------------------------------------------------------- audio graph */

  /*  Sample-rate policy
   *  ------------------
   *  A WebAudio graph runs at exactly one rate, and a MediaElementAudioSource
   *  resamples decoded media into it. A default AudioContext runs at the
   *  *device* rate (48 kHz on most machines), so a 192 kHz FLAC would be
   *  resampled down and everything above 24 kHz thrown away.
   *
   *  Verified against an independent ffmpeg decode of the bundled FLAC: when
   *  the context rate equals the file's own rate, the analyser returns the
   *  file's samples BIT-FOR-BIT (residual exactly 0, max|diff| 0). So by
   *  default the context is built at the source's native rate and nothing is
   *  resampled on the visual path.
   *
   *  (The OS still resamples the final output for your speakers. That is
   *  unavoidable — the device runs at 48 kHz — and it cannot affect what is
   *  drawn, because the analysers tap the graph, not the output.)
   */
  const RATE_MIN = 8000;
  const RATE_MAX = 384000;

  let ac = null;
  let engineWanted = 0;                       // rate requested; 0 = device default
  let sourceRate = 0;                         // native rate of loaded media; 0 = unknown
  let mediaSrc = null, splitter = null, zeroGain = null;
  let anL = null, anR = null;                 // analysers fed by the <audio> element
  let demoAnL = null, demoAnR = null;         // analysers fed by the built-in synth
  let demo = null;                            // demo synth nodes
  let demoBuilt = false;
  let source = 'media';                       // 'media' | 'demo'
  let useFloat = true;
  let audioDead = false;                      // set once the graph can't be built

  const bufL = new Float32Array(MAXN);
  const bufR = new Float32Array(MAXN);
  const byteL = new Uint8Array(MAXN);
  const byteR = new Uint8Array(MAXN);

  /* The analyser buffer is sized to the visible window, not always 32768.
     Copying 32768 samples x 2 channels 60 times a second is pure waste when
     only 4096 are ever drawn — and it is 4x (or 32x) more memory traffic. */
  let analyserSize = 0;
  let viewL = bufL;
  let viewR = bufR;
  let viewBL = byteL;
  let viewBR = byteR;

  const pow2ceil = (v) => {
    let p = 1024;
    while (p < v && p < MAXN) p <<= 1;
    return clamp(p, 1024, MAXN);
  };

  /** fftSize = 2x the window: enough for the window plus trigger search room. */
  function applyAnalyserSize() {
    const want = pow2ceil(winSize() * 2);
    if (want === analyserSize) return;
    analyserSize = want;
    viewL = bufL.subarray(0, want);
    viewR = bufR.subarray(0, want);
    viewBL = byteL.subarray(0, want);
    viewBR = byteR.subarray(0, want);
    for (const a of [anL, anR, demoAnL, demoAnR]) {
      if (a && a.fftSize !== want) a.fftSize = want;
    }
  }

  function clampRate(r) {
    return Number.isFinite(r) && r >= RATE_MIN && r <= RATE_MAX ? Math.round(r) : 0;
  }

  const rateText = (r) => `${r % 1000 === 0 ? r / 1000 : (r / 1000).toFixed(1)} kHz`;

  /** Which context rate the current settings + source call for (0 = device). */
  function desiredRate() {
    if (S.rateMode === 'device') return 0;
    if (S.rateMode === 'auto') return sourceRate ? clampRate(sourceRate) : 0;
    return clampRate(Number(S.rateMode));
  }

  function makeAnalyser() {
    const a = ac.createAnalyser();
    a.fftSize = analyserSize || MAXN;
    a.smoothingTimeConstant = 0;   // time-domain data is unaffected, but be explicit
    return a;
  }

  function teardownEngine() {
    try { if (demo) { demo.ox.stop(); demo.oy.stop(); } } catch (e) { /* ignore */ }
    demo = null; demoBuilt = false; demoAnL = demoAnR = null;
    try { if (mediaSrc) mediaSrc.disconnect(); } catch (e) { /* ignore */ }
    try { if (zeroGain) zeroGain.disconnect(); } catch (e) { /* ignore */ }
    try { if (ac) ac.close(); } catch (e) { /* ignore */ }
    ac = null; mediaSrc = splitter = zeroGain = anL = anR = null;
    engineWanted = 0;
  }

  /** Build a fresh context at `want` Hz (0 = device default).
   *  createMediaElementSource may only ever be called once per element, so the
   *  <audio> element has to be replaced together with the context. */
  function buildEngine(want) {
    if (audioDead) return null;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { audioDead = true; toast('此浏览器不支持 Web Audio API'); return null; }

    const prev = dom.audio;
    const el = document.createElement('audio');
    el.id = 'audio';
    el.preload = 'metadata';
    el.volume = prev ? prev.volume : Number(dom.volume.value);
    el.preservesPitch = true;
    el.playbackRate = Number(dom.rate.value) || 1;

    teardownEngine();

    if (prev && prev.parentNode) prev.replaceWith(el);
    else document.body.appendChild(el);
    dom.audio = el;
    bindAudioEvents(el);

    let ctx;
    let actual = want;
    try {
      ctx = want ? new AC({ sampleRate: want }) : new AC();
    } catch (err) {
      // rate rejected by this browser/platform — fall back to the device rate
      actual = 0;
      try {
        ctx = new AC();
      } catch (err2) {
        audioDead = true;
        toast('音频初始化失败：' + err2.message);
        return null;
      }
    }

    ac = ctx;
    engineWanted = actual;
    useFloat = typeof AnalyserNode.prototype.getFloatTimeDomainData === 'function';

    mediaSrc = ac.createMediaElementSource(el);
    splitter = ac.createChannelSplitter(2);
    anL = makeAnalyser();
    anR = makeAnalyser();

    mediaSrc.connect(splitter);
    splitter.connect(anL, 0);
    splitter.connect(anR, 1);
    mediaSrc.connect(ac.destination);

    // Analysers with no downstream connection can be starved of processing in
    // some engines. A zero-gain path to the destination keeps them pulled
    // without adding any audible (or visible) signal.
    zeroGain = ac.createGain();
    zeroGain.gain.value = 0;
    anL.connect(zeroGain);
    anR.connect(zeroGain);
    zeroGain.connect(ac.destination);

    updateRateBadge();
    needsRedraw = true;
    return ac;
  }

  function ensureGraph() {
    if (ac) return ac;
    if (audioDead) return null;
    return buildEngine(desiredRate());
  }

  function resumeContext() {
    const ctx = ensureGraph();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  /** A brand new source is about to be loaded, so there is nothing to preserve. */
  function ensureEngineRate() {
    if (audioDead) return;
    const want = desiredRate();
    if (!ac || want !== engineWanted) buildEngine(want);
    updateRateBadge();
  }

  /** The rate *setting* changed — keep the position and play state. */
  function applyRateMode() {
    if (audioDead) return;
    const want = desiredRate();
    if (ac && want === engineWanted) { updateRateBadge(); return; }

    const t = tracks[curIndex];
    const time = ac && t ? (dom.audio.currentTime || 0) : 0;
    const playing = ac && t ? (!dom.audio.paused && !dom.audio.ended) : false;
    const wasDemo = source === 'demo';

    buildEngine(want);

    if (wasDemo) {
      setDemo(true);
    } else if (t) {
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
    updateRateBadge();
    needsRedraw = true;
  }

  /** Small always-visible readout: is the engine native to this file? */
  function updateRateBadge() {
    const el = $('rateBadge');
    if (!el) return;
    const eng = ac ? ac.sampleRate : 0;

    // the window readout is a sample count; its duration depends on the rate
    const out = document.querySelector('[data-out="windowIdx"]');
    if (out) {
      out.textContent = FORMATTERS.windowIdx();
      out.title = `${((winSize() / (eng || 48000)) * 1000).toFixed(1)} ms`;
    }

    if (!eng) { el.textContent = '—'; el.className = 'rate-badge'; el.title = ''; return; }
    if (!sourceRate) {
      el.textContent = `${rateText(eng)} 引擎`;
      el.className = 'rate-badge';
      el.title = '当前音频引擎采样率（未载入音频，无从判断是否重采样）';
      return;
    }
    const native = eng === sourceRate;
    el.textContent = native
      ? `${rateText(eng)} 原生`
      : `${rateText(eng)} ← ${rateText(sourceRate)} 重采样`;
    el.className = 'rate-badge ' + (native ? 'is-native' : 'is-resampled');
    el.title = native
      ? `引擎与音频文件同为 ${sourceRate} Hz：分析器读到的是文件原始采样点，没有重采样`
      : `音频文件是 ${sourceRate} Hz，被重采样到 ${eng} Hz`;
  }

  function currentAnalysers() {
    if (source === 'demo') return demoAnL && demoAnR ? [demoAnL, demoAnR] : null;
    return anL && anR ? [anL, anR] : null;
  }

  /* ------------------------------------------------------- built-in demo sig */

  /* Two oscillators at a 3:2 ratio drive a clean Lissajous figure. Handy for
     checking the renderer (and for tuning gain / persistence) with no file. */
  function buildDemo() {
    if (demoBuilt || !ac) return;
    const merger = ac.createChannelMerger(2);
    const gx = ac.createGain(); gx.gain.value = 0.85;
    const gy = ac.createGain(); gy.gain.value = 0.85;
    const ox = ac.createOscillator(); ox.type = 'sine'; ox.frequency.value = 45; // X
    const oy = ac.createOscillator(); oy.type = 'sine'; oy.frequency.value = 30; // Y
    const dsp = ac.createChannelSplitter(2);

    ox.connect(gx); gx.connect(merger, 0, 0);
    oy.connect(gy); gy.connect(merger, 0, 1);
    merger.connect(dsp);
    demoAnL = makeAnalyser();
    demoAnR = makeAnalyser();
    dsp.connect(demoAnL, 0);
    dsp.connect(demoAnR, 1);
    demoAnL.connect(zeroGain);
    demoAnR.connect(zeroGain);

    ox.start(); oy.start();   // silent: everything reaches the output through zeroGain
    demo = { merger, dsp, gx, gy, ox, oy };
    demoBuilt = true;
  }

  function setDemo(on) {
    const ctx = resumeContext();
    if (!ctx) return;
    buildDemo();
    if (on) {
      try { demo.merger.connect(demo.dsp); } catch (e) { /* already connected */ }
      source = 'demo';
      dom.audio.pause();
      dom.btnDemo.classList.add('on');
      dom.trackTitle.textContent = '演示信号 · Demo';
      dom.trackSub.textContent = '内置合成器 · 3:2 利萨如曲线';
      document.title = '演示信号 · 示波器音乐播放器';
      setHint(false);
      needsRedraw = true;
      refSpeed = 0;
    } else {
      try { demo.merger.disconnect(); } catch (e) { /* not connected */ }
      source = 'media';
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

  /* -------------------------------------------------------------- playlist */

  let tracks = [];
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
      tracks = data.tracks.map((t) => ({
        name: t.name,
        url: t.url,
        blob: false,
        sampleRate: t.sampleRate || 0,
        meta: [
          t.format,
          t.sampleRate ? `${fmtHz(t.sampleRate)}` : null,
          t.bits ? `${t.bits}-bit` : null,
          t.channels === 2 ? '立体声' : t.channels ? `${t.channels}ch` : null,
          t.durationText,
          t.sizeText,
        ].filter(Boolean).join(' · '),
      }));
      renderPlaylist();
      return true;
    } catch (err) {
      return false;   // standalone / file:// — the file picker takes over
    }
  }

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

      // ---- MP4 / M4A (mdhd timescale)
      const ascii = Array.from(head.subarray(0, Math.min(head.length, 262144)), (c) => String.fromCharCode(c)).join('');
      const mi = ascii.indexOf('mdhd');
      if (mi >= 0) {
        const version = head[mi + 4];
        const tsOff = mi + 4 + 4 + (version === 1 ? 16 : 8);
        if (tsOff + 4 <= head.length) return { format: 'M4A', rate: dv.getUint32(tsOff), channels: 2, bits: 16 };
      }
    } catch (err) { /* unreadable header — fall back to the device rate */ }
    return null;
  }

  function describeAudio(info, size) {
    if (!info) return fmtBytes(size);
    return [
      info.format,
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
        meta: describeAudio(info, f.size),
      });
    }
    renderPlaylist();
    loadTrack(first, true);
  }

  function loadTrack(i, autoplay) {
    const t = tracks[i];
    if (!t) return;
    if (source === 'demo') setDemo(false);
    curIndex = i;
    // Build/rebuild the engine at this file's own rate *before* loading, so the
    // media is never resampled into the device rate on the analysis path.
    sourceRate = t.sampleRate || 0;
    ensureEngineRate();
    dom.audio.src = t.url;
    dom.audio.load();

    dom.trackTitle.textContent = t.name;
    dom.trackSub.textContent = t.meta || '';
    document.title = `${t.name} · 示波器音乐播放器`;
    setHint(false);
    renderPlaylist();
    refSpeed = 0;
    agGain = 1;
    scrubTick = 0;
    monoCounter = 0;
    needsRedraw = true;

    if (autoplay) play();
  }

  /* --------------------------------------------------------------- playback */

  async function play() {
    resumeContext();
    if (source === 'demo') {
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
    needsRedraw = true;
  }

  /* ------------------------------------------------------------- renderer */

  const PX = new Float32Array(MAXN);
  const PY = new Float32Array(MAXN);
  /* Segment indices grouped by brightness bucket. Building these in the same
     pass that maps samples to pixels means the whole trace is produced with
     ONE pass over the samples plus one canvas op per drawn segment, instead of
     one full scan per brightness level. */
  const BUCKET_IDX = new Int32Array(BUCKETS * MAXN);
  const BUCKET_N = new Int32Array(BUCKETS);

  let rafId = 0;
  let needsRedraw = true;
  let haveSignal = false;   // has a live frame ever been captured?
  let settle = 0;           // frames left to re-settle the afterglow after a pause
  let wasLive = false;
  let refSpeed = 0;        // smoothed mean beam speed, the 1/v blanking reference
  let agGain = 1;          // auto-gain (applied to BOTH axes to keep the figure's shape)
  let monoCounter = 0;
  let monoLike = false;
  let lastPeakL = 0;       // previous frame's peaks — auto-gain is smoothed anyway
  let lastPeakR = 0;

  function fadeAlpha() {
    // 0 %  -> 1.0  (full clear every frame, zero afterglow)
    // 100% -> 0.03 (long phosphor-like tail)
    const p = clamp(S.persistence / 100, 0, 1);
    return Math.pow(1 - p, 2) * 0.97 + 0.03;
  }

  /** Erase a layer by `alpha` — pure subtraction, never addition. */
  function fadeLayer(ctx, alpha) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = `rgba(0,0,0,${alpha})`;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
  }

  /* ---- the 8-bit quantisation floor (the "residue" slider) --------------
   * destination-out multiplies alpha: n <- n*(1-a). With round-to-nearest
   * 8-bit storage, every n <= 1/(2a) is a FIXED POINT and never decays. So a
   * slow fade (high 余辉) does not leave a longer ghost, it leaves a BRIGHTER
   * one — at 100% the floor is alpha ~15, clearly visible, and the whole region
   * the beam has ever swept keeps it forever.
   *
   * A periodic strong scrub is the only way out: a step of 1.0 clears the floor
   * completely, and anything weaker leaves a predictable amount of it behind.
   * Hence one slider, expressed as the residue you are willing to keep.
   */
  const SCRUB_EVERY = 180;   // frames (~3 s, longer than any visible trail)
  let scrubTick = 0;

  function scrubAlpha() {
    const r = clamp(S.residue / 100, 0, 1);
    if (r <= 0) return 1;                     // off -> wipe the floor completely
    return Math.min(1, 3.125 / (r * 100));    // leaves a floor of roughly 16*r
  }

  /* ---- burn-in ---------------------------------------------------------- */
  /* A second accumulation layer that decays far more slowly than the afterglow:
     it models phosphor *damage* rather than phosphor decay. Exposure is the
     time-integral of beam current, so it is laid down from the same beam path
     (and the same retrace blanking) as the trace — still crisp strokes, not a
     blur, which is why it is not glow.

     The exposure rate comes from a FRACTIONAL BUDGET, not from a tiny alpha: a
     per-frame alpha below ~1/255 rounds away on an 8-bit backing store and
     would never accumulate at all, so each painting uses a healthy alpha and
     paintings are simply spaced out.
     0 % = off, 100 % = permanent (never decays). */
  const burn = { on: false, gain: 0.03, rate: 0, decay: 0, fadeStep: 0.25, fadeEvery: 0, budget: 0, fadeTick: 0 };

  function clearBurnIn() {
    if (!W || !H) return;
    nctx.setTransform(1, 0, 0, 1, 0, 0);
    nctx.globalAlpha = 1;
    nctx.globalCompositeOperation = 'source-over';
    nctx.clearRect(0, 0, W, H);
    burn.budget = 0;
    needsRedraw = true;
  }

  function updateBurnIn(force) {
    const b = clamp(S.burnIn / 100, 0, 1);
    const was = burn.on;
    burn.on = b > 0.001;
    burn.gain = 0.03;                      // per painting, well clear of 1/255
    burn.rate = 0.02 * b;                  // paintings per frame (~1.2/s at 100%)
    // Steady state for a pixel the beam keeps returning to is roughly
    // rate*gain/decay, so decay is what decides how strong the ghost gets.
    burn.decay = b >= 0.99 ? 0 : 0.0012 * Math.pow(1 - b, 2);
    // Step big enough to clear the floor, then spread the steps out to keep the
    // requested average rate.
    burn.fadeStep = 0.25;
    burn.fadeEvery = burn.decay > 0 ? Math.max(1, Math.round(burn.fadeStep / burn.decay)) : 0;
    burn.budget = 0;
    burn.fadeTick = 0;
    if (force || (was && !burn.on)) clearBurnIn();   // turning it off wipes the ghost
    const out = document.querySelector('[data-out="burnIn"]');
    if (out) out.textContent = FORMATTERS.burnIn(S.burnIn);
  }

  /** Rising zero-crossing on X, used to phase-lock periodic figures. */
  function findTrigger(buf, maxStart, n) {
    const limit = Math.min(maxStart, n);
    let armed = false;
    let best = -1;
    for (let i = 1; i < limit; i++) {
      const v = buf[i];
      if (v < -0.03) { armed = true; continue; }
      if (armed && v >= 0) { best = i; break; }
    }
    return best < 0 ? 0 : best;
  }

  function readSignal() {
    const a = currentAnalysers();
    if (!a) return false;
    if (useFloat) {
      // Read only analyserSize samples, not the whole 32768-sample buffer.
      a[0].getFloatTimeDomainData(viewL);
      a[1].getFloatTimeDomainData(viewR);
    } else {
      a[0].getByteTimeDomainData(viewBL);
      a[1].getByteTimeDomainData(viewBR);
      for (let i = 0; i < analyserSize; i++) {
        bufL[i] = (byteL[i] - 128) / 128;
        bufR[i] = (byteR[i] - 128) / 128;
      }
    }
    return true;
  }

  function drawTrace(n, live) {
    const m = n - 1;
    const maxStart = Math.max(0, analyserSize - n);

    let start = 0;
    if (S.trigger && maxStart > 0) start = findTrigger(bufL, maxStart, n);

    /* ---- auto-gain from the previous frame's peaks (one frame of lag on a
       value that is exponentially smoothed anyway) ------------------------ */
    if (S.autoGain) {
      const pk = Math.max(lastPeakL, monoLike ? lastPeakL : lastPeakR, 1e-4);
      const target = clamp(0.9 / pk, 0.35, 12);
      const k = target < agGain ? 0.10 : 0.012;   // quick attack, slow release
      agGain += (target - agGain) * k;
    } else if (agGain !== 1) {
      agGain += (1 - agGain) * 0.12;
      if (Math.abs(agGain - 1) < 1e-3) agGain = 1;
    }

    const scale = PLOT * 0.5;
    const ox = PLOT_X + PLOT * 0.5 + S.offX * scale;
    const oy = PLOT_Y + PLOT * 0.5 - S.offY * scale;
    const kx = scale * S.gainX * agGain;
    const ky = scale * S.gainY * agGain;

    const blanking = S.blanking;
    const ref = Math.max(refSpeed > 0 ? refSpeed : PLOT * 0.01, PLOT * 0.0004);
    const eps = PLOT * 0.0015;          // only keeps ref/s finite as s -> 0
    const blankAt = S.blankRatio * ref;   // explicit drop threshold, no hidden clamp
    const topBucket = BUCKETS - 1;

    /* ---- ONE pass: map to pixels, track peaks, bucket the segments ------ */
    let peakL = 0, peakR = 0, total = 0;
    let prevX = 0, prevY = 0;
    if (blanking) BUCKET_N.fill(0);

    for (let i = 0; i < n; i++) {
      let l = bufL[start + i];
      const al = l < 0 ? -l : l;
      if (al > peakL) peakL = al;
      let r = monoLike ? l : bufR[start + i];
      const ar = r < 0 ? -r : r;
      if (ar > peakR) peakR = ar;
      if (l > 16) l = 16; else if (l < -16) l = -16;
      if (r > 16) r = 16; else if (r < -16) r = -16;

      const x = ox + l * kx;
      const y = oy - r * ky;
      PX[i] = x;
      PY[i] = y;

      if (i > 0) {
        const dx = x - prevX, dy = y - prevY;
        const s = Math.sqrt(dx * dx + dy * dy);
        total += s;
        // Retrace blanking is an explicit comparison against the running mean
        // speed, NOT a side effect of the bucket index. Making it explicit is
        // what lets the threshold be a number you can state, test, and set:
        // a segment is dropped when it is more than blankRatio times faster
        // than the typical beam speed.
        if (blanking && s <= blankAt) {
          const w = ref / (s + eps);              // brightness ∝ 1/speed
          let b = Math.ceil(w * topBucket);
          if (b > topBucket) b = topBucket;
          else if (b < 1) b = 1;
          BUCKET_IDX[b * MAXN + BUCKET_N[b]++] = i - 1;
        }
      }
      prevX = x;
      prevY = y;
    }

    if (blanking) {
      const mean = total / m;
      if (!(refSpeed > 0)) refSpeed = mean;
      refSpeed += (mean - refSpeed) * 0.06;
    }

    /* ---- mono fallback: a single-channel file leaves Y flat ------------ */
    if (peakR < 1e-4 && peakL > 1e-3) monoCounter++;
    else monoCounter = 0;
    if (monoCounter > 40) monoLike = true;
    else if (monoCounter === 0 && monoLike && peakR > 1e-3) monoLike = false;
    lastPeakL = peakL;
    lastPeakR = peakR;

    /* ---- paint ---------------------------------------------------------- */
    paintInto(tctx, n, S.intensity);

    // Burn-in: the same beam path laid down a second time on the slow layer.
    // Only while the beam is actually running — a paused scope has no beam, so
    // re-settling the afterglow must not keep exposing the phosphor.
    if (burn.on && live) {
      burn.budget += burn.rate;
      if (burn.budget >= 1) {
        burn.budget = Math.min(burn.budget - 1, 1);   // never burst after a stall
        paintInto(nctx, n, burn.gain);
      }
    }

    if (S.beamDot) {
      const lw = S.lineWidth * DPR;
      tctx.fillStyle = S.color;
      tctx.beginPath();
      tctx.arc(PX[n - 1], PY[n - 1], Math.max(1.5 * DPR, lw * 1.4), 0, TAU);
      tctx.fill();
    }
  }

  /** Stroke the already-computed beam path into `ctx` with `base` as the peak
   *  alpha. Shared by the afterglow layer and the burn-in layer. */
  function paintInto(ctx, n, base) {
    ctx.lineWidth = S.lineWidth * DPR;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = S.color;

    if (!S.blanking) {
      // Plain beam path: one continuous polyline, never closed.
      ctx.globalAlpha = clamp(base, 0, 1);
      ctx.beginPath();
      ctx.moveTo(PX[0], PY[0]);
      for (let i = 1; i < n; i++) ctx.lineTo(PX[i], PY[i]);
      ctx.stroke();
      ctx.globalAlpha = 1;
      return;
    }

    // Only the surviving segments reach here: anything faster than
    // blankRatio × the mean beam speed was already dropped in the pass above.
    // Those are retrace / blanking strokes — on a CRT the beam is racing, so
    // they carry almost no charge per unit length, and under afterglow even a
    // very dim one would still accumulate frame after frame into a visible
    // chord. Dropping them outright is what removes retrace lines for good,
    // rather than merely fading them. What is left is dimmed ∝ 1/speed.
    for (let b = 1; b < BUCKETS; b++) {
      const cnt = BUCKET_N[b];
      if (!cnt) continue;
      const base0 = b * MAXN;
      ctx.globalAlpha = clamp(base * (b / (BUCKETS - 1)), 0, 1);
      ctx.beginPath();
      let prev = -2;
      for (let k = 0; k < cnt; k++) {
        const si = BUCKET_IDX[base0 + k];
        if (si !== prev + 1) ctx.moveTo(PX[si], PY[si]);   // contiguous runs skip the moveTo
        ctx.lineTo(PX[si + 1], PY[si + 1]);
        prev = si;
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /* ------------------------------------------------------------ main loop */

  function isLive() {
    if (!currentAnalysers()) return false;
    if (source === 'demo') return !!ac && ac.state === 'running';
    return !dom.audio.paused && !dom.audio.ended && !dom.audio.seeking;
  }

  let uiTick = 0;

  function loop(ts) {
    rafId = requestAnimationFrame(loop);
    const now = typeof ts === 'number' ? ts : performance.now();
    // The scrubber only needs ~10 Hz; writing three DOM properties every frame
    // was costing more than it looked.
    if (now - uiTick > 100) { uiTick = now; updateTransportUI(); }
    if (document.hidden) return;
    if (!W || !H) return;

    const live = isLive();

    if (live) {
      wasLive = true;
      settle = 0;
      if (!readSignal()) return;
      haveSignal = true;
    } else {
      // A paused <audio> element feeds the graph silence, so the analysers go
      // flat. Never re-read them here — keep painting the last captured window
      // instead, otherwise pausing (or nudging a slider while paused) would
      // blank the screen.
      if (wasLive) {
        wasLive = false;
        settle = 100;                                   // just paused: let the afterglow settle
        if (S.residue <= 0) scrubTick = SCRUB_EVERY;    // and wipe the floor before it freezes
      }
      if (needsRedraw) settle = 100;                    // settings changed: re-settle
      if (!haveSignal || settle <= 0) { needsRedraw = false; return; }
      settle--;
    }
    needsRedraw = false;

    const workStart = performance.now();
    // Afterglow is pure subtraction: destination-out only ever removes alpha,
    // so a bright pixel can never bleed light into its neighbours.
    if (++scrubTick >= SCRUB_EVERY) {
      scrubTick = 0;
      fadeLayer(tctx, scrubAlpha());
    } else {
      fadeLayer(tctx, fadeAlpha());
    }
    // The burn-in decays far more slowly than the afterglow, so its fade runs
    // in chunky steps. A small per-frame step would sit below the quantisation
    // floor and the ghost would never decay at all.
    if (burn.on && burn.fadeEvery > 0 && ++burn.fadeTick >= burn.fadeEvery) {
      burn.fadeTick = 0;
      fadeLayer(nctx, burn.fadeStep);
    }

    try {
      drawTrace(winSize(), live);
    } catch (err) {
      if (!loop.warned) { loop.warned = true; console.error('[scope] render error', err); }
    }
    tctx.globalAlpha = 1;
    adaptQuality(performance.now() - workStart);
  }

  /* ------------------------------------------------------- transport UI sync */

  const uiCache = { cur: -1, dur: -1, seek: -1 };

  function updateTransportUI() {
    const a = dom.audio;
    const cur = Number.isFinite(a.currentTime) ? a.currentTime : 0;
    const dur = Number.isFinite(a.duration) ? a.duration : 0;

    if (Math.abs(cur - uiCache.cur) >= 0.06 || Math.abs(dur - uiCache.dur) > 0.2) {
      uiCache.cur = cur;
      uiCache.dur = dur;
      dom.tCur.textContent = fmtTime(cur);
      dom.tDur.textContent = Number.isFinite(a.duration) ? fmtTime(dur) : '--:--';
      const pct = dur > 0 ? clamp((cur / dur) * 100, 0, 100) : 0;
      if (!seekHeld) {
        dom.seek.value = String(Math.round(pct * 10));
        dom.seek.style.setProperty('--p', pct.toFixed(2));
      }
    }
  }

  let seekHeld = false;

  /* ------------------------------------------------------------- UI wiring */

  const FORMATTERS = {
    gainX: (v) => Number(v).toFixed(2),
    gainY: (v) => Number(v).toFixed(2),
    offX: (v) => Number(v).toFixed(2),
    offY: (v) => Number(v).toFixed(2),
    windowIdx: () => winSize().toLocaleString('en-US'),
    intensity: (v) => Number(v).toFixed(2),
    lineWidth: (v) => Number(v).toFixed(2) + ' px',
    persistence: (v) => Math.round(v) + ' %',
    burnIn: (v) => (v <= 0 ? '关' : v >= 99.5 ? '永久' : Math.round(v) + ' %'),
    residue: (v) => (v <= 0 ? '关' : Math.round(v) + ' %'),
    blankRatio: (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)) + '×',
    color: (v) => String(v).toUpperCase(),
  };

  function applyAccent(color) {
    document.documentElement.style.setProperty('--accent', color);
    for (const sw of dom.swatches.children) {
      sw.classList.toggle('active', sw.dataset.color.toLowerCase() === String(color).toLowerCase());
    }
    drawBackground();   // the graticule is tinted from the same colour
    needsRedraw = true;
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
    updateBurnIn(false);
    applyAccent(S.color);
  }

  function bindControls() {
    for (const el of document.querySelectorAll('[data-set]')) {
      const key = el.dataset.set;
      const out = document.querySelector(`[data-out="${key}"]`);
      const onInput = () => {
        S[key] = el.type === 'range' ? parseFloat(el.value) : el.value;
        if (out) out.textContent = FORMATTERS[key](S[key]);
        if (key === 'color') applyAccent(S.color);
        if (key === 'windowIdx') { refSpeed = 0; applyAnalyserSize(); }
        if (key === 'burnIn') updateBurnIn(false);
        needsRedraw = true;
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
        needsRedraw = true;
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
        if (key === 'trigger') refSpeed = 0;
        if (key === 'blanking') syncControlsFromState();   // enable/disable the threshold row
        needsRedraw = true;
      });
    }

    for (const el of document.querySelectorAll('[data-close]')) {
      el.addEventListener('click', () => $(el.dataset.close).classList.remove('open'));
    }

    // transport
    dom.btnPlay.addEventListener('click', togglePlay);
    dom.btnPrev.addEventListener('click', () => nextTrack(-1));
    dom.btnNext.addEventListener('click', () => nextTrack(1));
    dom.btnDemo.addEventListener('click', () => {
      const turningOn = source !== 'demo';
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
      needsRedraw = true;
    });
    const releaseSeek = () => { seekHeld = false; };
    dom.seek.addEventListener('pointerup', releaseSeek);
    dom.seek.addEventListener('pointercancel', releaseSeek);
    dom.seek.addEventListener('change', releaseSeek);

    dom.volume.addEventListener('input', () => { dom.audio.volume = Number(dom.volume.value); });
    dom.rate.addEventListener('change', () => {
      dom.audio.preservesPitch = true;
      dom.audio.playbackRate = Number(dom.rate.value);
    });
    dom.audio.volume = Number(dom.volume.value);

    const rateModeSel = $('rateMode');
    if (rateModeSel) {
      rateModeSel.value = S.rateMode;
      rateModeSel.addEventListener('change', () => {
        S.rateMode = rateModeSel.value;
        applyRateMode();
        const eng = ac ? ac.sampleRate : 0;
        toast(!eng ? '引擎跟随设备采样率'
          : !sourceRate ? `引擎 ${rateText(eng)}`
            : `引擎 ${rateText(eng)} · ${eng === sourceRate ? '原生' : `源 ${rateText(sourceRate)} · 重采样`}`);
      });
    }

    const scaleSel = $('renderScale');    if (scaleSel) {
      scaleSel.value = S.renderScale;
      scaleSel.addEventListener('change', () => {
        S.renderScale = scaleSel.value;
        if (S.renderScale === 'auto') { autoScale = 1; workAvg = 0; qualityCooldown = 120; }
        applyScale();
        toast(`渲染缩放 ${Math.round(effectiveDpr() * 100)}%`);
      });
    }

    const perfBtn = $('btnPerf');
    if (perfBtn) perfBtn.addEventListener('click', () => setPerfMode(!perfSnapshot));

    window.addEventListener('resize', () => { if (layout()) needsRedraw = true; });
    if (window.ResizeObserver) {
      new ResizeObserver(() => { if (layout()) needsRedraw = true; }).observe(dom.stage);
    }
    document.addEventListener('fullscreenchange', () => { if (layout()) needsRedraw = true; });
  }

  /** Audio-element listeners. Re-attached every time the engine rebuilds the
   *  element (a new AudioContext needs a new <audio> — see buildEngine). */
  function bindAudioEvents(el) {
    el.addEventListener('play', () => {
      dom.btnPlay.classList.add('playing');
      needsRedraw = true;
    });
    el.addEventListener('pause', () => dom.btnPlay.classList.remove('playing'));
    el.addEventListener('ended', () => {
      dom.btnPlay.classList.remove('playing');
      if (tracks.length > 1) nextTrack(1);
    });
    el.addEventListener('error', () => {
      if (!el.src) return;
      const code = el.error ? el.error.code : 0;
      toast(code === 4 ? '浏览器无法解码此文件' : '音频加载失败');
    });
    el.addEventListener('seeking', () => { needsRedraw = true; });
    el.addEventListener('loadedmetadata', () => {
      uiCache.dur = -1;
      needsRedraw = true;
    });
  }

  /** Restore every setting to its default, including the derived state that
   *  syncControlsFromState() alone does not touch (analyser size, render
   *  scale, smoothing accumulators). Forgetting the analyser size here left a
   *  4096-sample window being drawn out of a 1024-sample buffer. */
  function resetSettings() {
    Object.assign(S, DEFAULTS);
    autoScale = 1;
    workAvg = 0;
    qualityCooldown = 120;
    refSpeed = 0;
    agGain = 1;
    scrubTick = 0;
    monoCounter = 0;
    monoLike = false;
    lastPeakL = 0;
    lastPeakR = 0;
    syncControlsFromState();
    applyAnalyserSize();
    applyScale();
    drawBackground();
    updateBurnIn(true);
    needsRedraw = true;
    settle = 100;
  }

  /** One-click low-power preset. The levers are chosen from measurements in
   *  test/bench.js: the per-frame cost is dominated by how many segments get
   *  drawn, so shrinking the window is what actually helps (32768 -> 1024 took
   *  a frame from 1.49 ms to 0.08 ms). Render scale barely moved the needle. */
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
    refSpeed = 0;
    needsRedraw = true;
    settle = 100;
    toast(on ? '性能模式：开' : '性能模式：关');
  }

  function togglePanel(id) {
    const p = $(id);
    const open = !p.classList.contains('open');
    p.classList.toggle('open', open);
    $(id === 'panelSettings' ? 'btnSettings' : 'btnList').classList.toggle('on', open);
    if (layout()) { needsRedraw = true; settle = 100; }   // the plot may need to give up margin
    // Left and right rails are independent now that they reserve their own
    // space, so both panels can be open at once.
  }

  function screenshot() {
    if (!W || !H) return;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.drawImage(dom.bg, 0, 0);
    g.drawImage(dom.trace, 0, 0);
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

  /* -------------------------------------------------------------- keyboard */

  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    const typing = t && t.closest && t.closest('input, select, textarea');
    if (typing && e.key !== 'Escape') return;

    switch (e.key) {
      case ' ': case 'k': case 'K':
        e.preventDefault(); togglePlay(); break;
      case 'ArrowLeft': e.preventDefault(); seekBy(-5); break;
      case 'ArrowRight': e.preventDefault(); seekBy(5); break;
      case 'ArrowUp':
        e.preventDefault();
        dom.volume.value = String(clamp(Number(dom.volume.value) + 0.05, 0, 1));
        dom.audio.volume = Number(dom.volume.value);
        toast(`音量 ${Math.round(dom.audio.volume * 100)}%`);
        break;
      case 'ArrowDown':
        e.preventDefault();
        dom.volume.value = String(clamp(Number(dom.volume.value) - 0.05, 0, 1));
        dom.audio.volume = Number(dom.volume.value);
        toast(`音量 ${Math.round(dom.audio.volume * 100)}%`);
        break;
      case ',': nextTrack(-1); break;
      case '.': nextTrack(1); break;
      case 'd': case 'D': {
        const on = source !== 'demo';
        setDemo(on);
        if (on && !S.trigger) { S.trigger = true; syncControlsFromState(); }
        break;
      }
      case 'l': case 'L': togglePanel('panelList'); break;
      case 'p': case 'P': togglePanel('panelSettings'); break;
      case 'f': case 'F':
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen().catch(() => {});
        break;
      case 's': case 'S': screenshot(); break;
      case 'g': case 'G': S.grid = !S.grid; syncControlsFromState(); drawBackground(); needsRedraw = true; break;
      case 'b': case 'B': S.blanking = !S.blanking; syncControlsFromState(); toast('速度消隐 ' + (S.blanking ? '开' : '关')); break;
      case 't': case 'T': S.trigger = !S.trigger; syncControlsFromState(); refSpeed = 0; toast('相位锁定 ' + (S.trigger ? '开' : '关')); break;
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

  /* ------------------------------------------------------- drag & drop + idle */

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

  /* ------------------------------------------------------------ debug seam */

  /* Read-only view of the engine, used by test/verify.js to assert that the
     analysis path really is running at the file's native rate (and therefore
     that no resampling is happening). Harmless in normal use. */
  window.__scope = {
    get state() {
      return {
        engineRate: ac ? ac.sampleRate : 0,
        contextState: ac ? ac.state : 'none',
        sourceRate,
        source,
        rateMode: S.rateMode,
        windowSize: winSize(),
        renderScale: S.renderScale,
        effectiveDpr: effectiveDpr(),
        analyserSize,
        canvas: { w: W, h: H },
        plot: { x: PLOT_X, y: PLOT_Y, size: PLOT },
        workMs: workAvg,
        work: {
          trimmed: workTrimmed(0.25),   // load-proof headline number
          trimmed50: workTrimmed(0.5),
          min: workStat(0),
          p50: workStat(0.5),
          p95: workStat(0.95),
          avg: workAvg,
          frames: workFilled,
        },
        autoScale,
      };
    },
    readAnalyser() {
      const a = currentAnalysers();
      if (!a) return null;
      const L = new Float32Array(MAXN);
      const R = new Float32Array(MAXN);
      a[0].getFloatTimeDomainData(L);
      a[1].getFloatTimeDomainData(R);
      return { engineRate: ac.sampleRate, L: Array.from(L), R: Array.from(R) };
    },
    setRateMode(mode) {
      S.rateMode = String(mode);
      syncControlsFromState();
      applyRateMode();
      return desiredRate();
    },
    resetWorkStats,
  };

  /* ------------------------------------------------------------------ init */

  async function init() {
    layout();
    applyAnalyserSize();
    bindAudioEvents(dom.audio);
    bindControls();
    bindDragDrop();
    syncControlsFromState();
    updatePerfBadge();
    const scaleOut = document.querySelector('[data-out="renderScale"]');
    if (scaleOut) scaleOut.textContent = scaleLabel();
    dom.volume.value = '0.85';
    dom.audio.volume = 0.85;

    if (location.protocol === 'file:') {
      dom.hintNote.textContent = '浏览器不允许网页读取本地目录，请选择或拖入文件';
    } else {
      dom.hintNote.textContent = '已自动列出项目目录下的音频文件';
    }

    renderPlaylist();
    rafId = requestAnimationFrame(loop);

    const found = await loadServerTracks();
    if (found) {
      const first = tracks.findIndex((t) => /oscillo/i.test(t.name));
      loadTrack(first >= 0 ? first : 0, false);
      toast(`已找到 ${tracks.length} 个音频文件`);
    }

    const params = new URLSearchParams(location.search);
    if (params.has('demo')) {
      setDemo(true);
      if (!S.trigger) { S.trigger = true; syncControlsFromState(); }
    }
    if (params.has('track')) {
      const idx = Number(params.get('track'));
      if (Number.isFinite(idx) && tracks[idx]) loadTrack(idx, tracks.length > 0);
    }
    if (params.has('play') && tracks.length) play();

    // Some browsers need one gesture before the AudioContext may run.
    const unlock = () => { resumeContext(); window.removeEventListener('pointerdown', unlock); };
    window.addEventListener('pointerdown', unlock, { once: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
