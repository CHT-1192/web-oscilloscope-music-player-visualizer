#!/usr/bin/env node
'use strict';

/* ============================================================================
    test/sections/render-synth.js — the page-side instrumentation the render
    scenes drive the analyser with.

    Injected with addInitScript before the app boots. It replaces the analyser
    data with a synthetic XY path: a square traced slowly with one fast diagonal
    retrace across its middle, plus the modes the dose and halo checks need
    (line, uniform, stationary, dense). The retrace is what makes "no retrace
    line" measurable, so this file is the reason those checks can exist at all.
   ========================================================================== */

const SYNTH = `
  // A square traced slowly, then a fast diagonal retrace through its centre.
  // __synthF = share of the period spent on the retrace. With no hold phase the
  // retrace / mean-beam-speed ratio is exactly 1.98 / (f * 7.58): perimeter 5.6
  // plus diagonal 1.98 units per period.
  window.__synthF = 0.005;
  window.__synthPoint = function (t) {
    const f = window.__synthF;
    if (t < 1 - f) {                       // slow stroke: square perimeter
      const u = t / (1 - f);
      const k = Math.min(3.999, u * 4);
      const side = Math.floor(k), g = k - side;
      const a = -0.7 + 1.4 * g;
      if (side === 0) return [a, -0.7];
      if (side === 1) return [0.7, a];
      if (side === 2) return [-a, 0.7];
      return [-0.7, -a];
    }
    const u = (t - (1 - f)) / f;           // fast diagonal retrace through the centre
    return [-0.7 + 1.4 * u, -0.7 + 1.4 * u];
  };

  window.__glow = { shadowBlur: 0, shadowColor: 0, lighter: 0, filter: 0, closePathCalls: 0 };

  // Watch for anything that would produce a halo / bloom.
  (function () {
    const proto = CanvasRenderingContext2D.prototype;
    const watch = {
      shadowBlur: (v) => Number(v) > 0,
      shadowColor: (v) => !!v && v !== 'rgba(0, 0, 0, 0)' && v !== 'transparent',
      filter: (v) => !!v && v !== 'none',
    };
    for (const prop of Object.keys(watch)) {
      const d = Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.set) continue;
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: d.enumerable,
        get: d.get,
        set: function (v) {
          if (watch[prop](v)) window.__glow[prop]++;
          return d.set.call(this, v);
        },
      });
    }
    const gco = Object.getOwnPropertyDescriptor(proto, 'globalCompositeOperation');
    Object.defineProperty(proto, 'globalCompositeOperation', {
      configurable: true,
      enumerable: gco.enumerable,
      get: gco.get,
      set: function (v) {
        if (String(v).toLowerCase() === 'lighter') window.__glow.lighter++;
        return gco.set.call(this, v);
      },
    });
    // closePath on the beam path would create a return trace
    const cp = proto.closePath;
    proto.closePath = function () { window.__glow.closePathCalls++; return cp.apply(this, arguments); };
  })();

  // Tag the two splitter-fed analysers as X (output 0) and Y (output 1) so the
  // synthetic signal can be delivered through the app's real audio pipeline.
  (function () {
    const origConnect = ChannelSplitterNode.prototype.connect;
    ChannelSplitterNode.prototype.connect = function (dest, out, inp) {
      try {
        if (dest && typeof dest.getFloatTimeDomainData === 'function' && (out === 0 || out === 1)) dest.__ch = out;
      } catch (e) { /* ignore */ }
      return origConnect.call(this, dest, out, inp);
    };

    const origFloat = AnalyserNode.prototype.getFloatTimeDomainData;
    AnalyserNode.prototype.getFloatTimeDomainData = function (arr) {
      if (!window.__synthOn) return origFloat.call(this, arr);
      const ch = this.__ch === 1 ? 1 : 0;
      /* The renderer draws the FIRST winSize() samples of an analyser buffer
         that is 2 x winSize long, so one period has to fit in half the array.
         Hard-coding 4096 here quietly made the whole synthetic suite depend on
         the default window: at a 2048-sample window the retrace (the last 0.5 %
         of the period) fell outside the drawn half and every measurement went
         to zero. Tie the period to the buffer instead. */
      const P = arr.length / 2;
      for (let i = 0; i < arr.length; i++) {
        const p = window.__synthPoint((i % P) / P);
        arr[i] = ch === 0 ? p[0] : p[1];
      }
    };
  })();

  window.__measure = function (cx, cy, halfW, halfH) {
    const c = window.__scope.state.canvas;
    const size = window.__scope.state.canvas;
    const x = Math.max(0, Math.round(cx - halfW));
    const y = Math.max(0, Math.round(cy - halfH));
    const w = Math.min(size.w - x, Math.round(halfW * 2));
    const h = Math.min(size.h - y, Math.round(halfH * 2));
    if (w <= 0 || h <= 0) return { max: -1, mean: -1 };
    const d = window.__scope.readTrace(x, y, w, h);
    let max = 0, sum = 0, n = 0;
    for (let i = 3; i < d.length; i += 4) { if (d[i] > max) max = d[i]; sum += d[i]; n++; }
    return { max, mean: n ? sum / n : 0 };
  };

  window.__plotCenter = function () {
    const c = window.__scope.state.canvas;
    const W = c.w, H = c.h;
    const PLOT = Math.min(W, H) * 0.9;
    const cx = (W - PLOT) / 2 + PLOT / 2;
    const cy = (H - PLOT) / 2 + PLOT / 2;
    return { W, H, PLOT, cx, cy };
  };
`;

module.exports = { SYNTH };
