/* ============================================================================
 *  gl.js — energy-accumulation renderer (WebGL2)
 *
 *  A real CRT's brightness is not a per-frame alpha: a phosphor integrates the
 *  energy the beam deposits and then decays exponentially. This module renders
 *  that directly, which is the model the Canvas-2D path only approximates:
 *
 *      E(x,y) += exposure · Σ_segments  1/v · spot(x,y)      (additive, per pixel)
 *      E(x,y) *= exp(-dt/τ)                                  (真 decay, once per frame)
 *      display = colour · (1 - exp(-E/E₀))                   (saturating tone map)
 *
 *  Three consequences the 8-bit path could not have:
 *    · brightness ∝ 1/v holds exactly, because energy adds — no bucket ladder;
 *    · deposits below 1/255 are not rounded away, so there is no quantisation
 *      floor and therefore no "residue" to scrub;
 *    · the tone map saturates smoothly instead of clipping, so overlapping
 *      passes brighten and then stop, like a phosphor.
 *
 *  What it deliberately does NOT do: no blur, no bloom pass, and no widening
 *  with the dose. The additive step happens on the pixel the beam actually hits,
 *  spread only by the beam's own Gaussian spot, and that spot has ONE sigma for
 *  every segment: on a real tube the spot size is set by the beam current and the
 *  focus, not by how fast the beam happens to be moving at that sample. What
 *  varies with writing speed is brightness per unit length, i.e. the energy
 *  below. (Varying sigma with the dose was tried: adjacent samples have different
 *  doses, so the trace came out beaded like a string of little dots.)
 *
 *  So brightness never bleeds into a pixel the beam did not illuminate, which is
 *  what keeps "no glow" true even though the accumulation is additive. The halo
 *  is opt-in and lives in a separate pass AFTER the tone map, because it is a
 *  scatter of light the phosphor has already emitted — see FRAG_HALO.
 *
 *  Everything above is GPU-side; the CPU uploads one instance record per
 *  segment (5 floats) and issues three draw calls per frame.
 * ========================================================================== */

import * as shaders from './shaders.js';

const {
  FRAG_BEAM,
  FRAG_BLUR,
  FRAG_COPY,
  FRAG_DECAY,
  FRAG_HALO,
  FRAG_TONE,
  VERT_BEAM,
  VERT_QUAD,
} = shaders;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(`shader: ${log}`);
  }
  return s;
}

function program(gl, vsSrc, fsSrc) {
  const p = gl.createProgram();
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc);
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(`link: ${log}`);
  }
  const uniforms = {};
  for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
    const info = gl.getActiveUniform(p, i);
    uniforms[info.name] = gl.getUniformLocation(p, info.name);
  }
  return { p, uniforms };
}

/** Does this machine actually render the energy path?
 *
 *  Asking for EXT_color_buffer_float is not enough: a driver can advertise it and
 *  still discard every draw into a float target, which looks exactly like "the
 *  scope stopped drawing" — an empty graticule and no trace. So this draws one
 *  segment on a throwaway canvas, reads the frame back and requires light. The
 *  real canvas is only committed to WebGL if that works, because a canvas hands
 *  out one context kind for its whole life and there is no way back to 2D.
 */
export function probeGL() {
  let r = null;
  let canvas = null;
  try {
    canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    r = createGL(canvas);
    if (!r) return false;
    r.resize(64, 64);
    r.setColour(1, 1, 1);
    r.setExposure(1);
    r.setSigma(1.5);
    r.setTau(1);
    const seg = r.segData;
    seg[0] = 10; seg[1] = 32; seg[2] = 54; seg[3] = 32; seg[4] = 1;
    r.decay(1 / 60);
    r.deposit(1);
    r.present();
    const px = r.readPixels(0, 0, 64, 64);
    let lit = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 0) lit++;
    return lit > 0;
  } catch (e) {
    return false;
  } finally {
    if (r) r.dispose();
  }
}

/** Create the renderer, or return null so the caller can stay on Canvas-2D.
 *  WebGL2 only: WebGL1 would need instancing and float-render extensions, and
 *  every browser this project targets has had WebGL2 for years. Failing to get a
 *  float render target is a hard "no" — a 16-bit integer buffer would reintroduce
 *  exactly the quantisation floor this is here to remove. */
export function createGL(canvas) {
  let gl = null;
  try {
    gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
  } catch (e) { /* no WebGL2 at all */ }
  if (!gl) return null;
  if (!gl.getExtension('EXT_color_buffer_float')) return null;

  /* A lost context turns every draw into a no-op — the same silent blank screen
     the probe exists to prevent, except it can happen long after startup. There
     is no way back to a 2D context on this canvas, so the honest thing is to say
     so rather than look broken. Restoring the GPU resources in place is not
     implemented; the app keeps running and the user reloads. */
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    state.lost = true;
  }, false);

  let progDecay, progCopy, progBeam, progTone, progHalo, progBlur;
  try {
    progDecay = program(gl, VERT_QUAD, FRAG_DECAY);
    progCopy = program(gl, VERT_QUAD, FRAG_COPY);
    progBeam = program(gl, VERT_BEAM, FRAG_BEAM);
    progTone = program(gl, VERT_QUAD, FRAG_TONE);
    progHalo = program(gl, VERT_QUAD, FRAG_HALO);
    progBlur = program(gl, VERT_QUAD, FRAG_BLUR);
  } catch (e) {
    return null;                                  // shader trouble: fall back
  }

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);

  const MAX_SEG = 32768;
  const segBuf = gl.createBuffer();
  const segData = new Float32Array(MAX_SEG * 5);   // x0,y0,x1,y1,energy
  gl.bindBuffer(gl.ARRAY_BUFFER, segBuf);
  gl.bufferData(gl.ARRAY_BUFFER, segData.byteLength, gl.DYNAMIC_DRAW);

  const target = { tex: null, fbo: null, w: 0, h: 0 };
  const display = { tex: null, fbo: null, w: 0, h: 0 };
  const scratch = { tex: null, fbo: null, w: 0, h: 0 };
  const haloIn = { tex: null, fbo: null, w: 0, h: 0 };
  const haloNear = { tex: null, fbo: null, w: 0, h: 0 };
  const haloWide = { tex: null, fbo: null, w: 0, h: 0 };
  const haloFar = { tex: null, fbo: null, w: 0, h: 0 };

  /** Allocate without destroying anything: a resize has to COPY the old
   *  accumulation first, and deleting it up front is how the picture got wiped
   *  (the console said `tex is already deleted`). */
  function allocTexture(w, h, internal, format, type, mip) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER,
      mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    /* Asking for the extension is not the same as the driver being able to render
       to a float target. If the framebuffer is incomplete every draw is silently
       discarded, which looks exactly like "the scope stopped drawing". */
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      throw new Error(`float render target incomplete (0x${status.toString(16)})`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);        // also avoids the lazy-init warning
    return { tex, fbo, w, h };
  }

  function adopt(t, next) {
    if (t.tex) gl.deleteTexture(t.tex);
    if (t.fbo) gl.deleteFramebuffer(t.fbo);
    t.tex = next.tex;
    t.fbo = next.fbo;
    t.w = next.w;
    t.h = next.h;
  }

  const makeTarget = (w, h) => allocTexture(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT);
  const makeDisplay = (w, h) => allocTexture(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
  /* Only allocated when 光晕 is first switched on: with it off the render path is
     byte for byte what it was, one full-screen pass cheaper. */
  const makeHaloSrc = (w, h) => allocTexture(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, true);
  const makeHaloBlur = (w, h) => allocTexture(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);

  const state = {
    ok: true,
    width: 0,
    height: 0,
    colour: [0.24, 1.0, 0.61],
    exposure: 0.45,        // per unit 1/v, per frame
    e0: 1,                 // energy that tone-maps to ~63% brightness
    sigma: 1.0,            // beam spot sigma, in device pixels
    halo: 0,               // halation amplitude (0 = pass skipped)
    tau: 0.02,             // phosphor time constant, seconds
    segments: 0,
    lost: false,
    /** Frame-time bookkeeping, so a stalled tab decays by real time rather than
     *  by "one step". */
    last: 0,
    frames: 0,
  };

  function bindQuad(prog, loc) {
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    /* Dividers are per attribute LOCATION and outlive the program that set them,
       so a fullscreen pass can inherit divisor 1 from the instanced beam pass —
       which turns its six vertices into one value and draws garbage. */
    gl.vertexAttribDivisor(loc, 0);
  }

  /** Copy the previous accumulation into a fresh target, scaled — a resize must
   *  not eat the picture (the Canvas path had to do the same by hand). */
  function resize(w, h) {
    if (w < 1 || h < 1) return;
    if (target.w === w && target.h === h) return;
    const hadContent = !!target.tex;
    const next = makeTarget(w, h);
    const nextDisplay = makeDisplay(w, h);
    if (hadContent) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, next.fbo);
      gl.viewport(0, 0, w, h);
      gl.disable(gl.BLEND);
      gl.useProgram(progCopy.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, target.tex);      // the OLD one, still alive
      gl.uniform1i(progCopy.uniforms.uAcc, 0);
      bindQuad(progCopy, gl.getAttribLocation(progCopy.p, 'aPos'));
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    adopt(target, next);                                 // frees the old, after the copy
    adopt(display, nextDisplay);
    if (scratch.tex && (scratch.w !== w || scratch.h !== h)) adopt(scratch, makeTarget(w, h));
    if (haloIn.tex && (haloIn.w !== w || haloIn.h !== h)) adopt(haloIn, makeHaloSrc(w, h));
    if (haloNear.tex && (haloNear.w !== w || haloNear.h !== h)) adopt(haloNear, makeHaloBlur(w, h));
    if (haloWide.tex && (haloWide.w !== w || haloWide.h !== h)) adopt(haloWide, makeHaloBlur(w, h));
    if (haloFar.tex && (haloFar.w !== w || haloFar.h !== h)) adopt(haloFar, makeHaloBlur(w, h));
    state.width = w;
    state.height = h;
  }

  function clear() {
    if (!target.fbo) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.w, target.h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** One frame's worth of phosphor decay, by real elapsed time. */
  function decay(dt) {
    if (!scratch.tex || scratch.w !== target.w || scratch.h !== target.h) {
      adopt(scratch, makeTarget(target.w, target.h));
    }
    const keep = state.tau > 0 ? Math.exp(-dt / state.tau) : 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, scratch.fbo);
    gl.viewport(0, 0, target.w, target.h);
    gl.disable(gl.BLEND);
    gl.useProgram(progDecay.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.tex);
    gl.uniform1i(progDecay.uniforms.uAcc, 0);
    gl.uniform1f(progDecay.uniforms.uKeep, keep);
    bindQuad(progDecay, gl.getAttribLocation(progDecay.p, 'aPos'));
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    const t = target.tex; target.tex = scratch.tex; scratch.tex = t;
    const f = target.fbo; target.fbo = scratch.fbo; scratch.fbo = f;
    const w = target.w; target.w = scratch.w; scratch.w = w;
    const h = target.h; target.h = scratch.h; scratch.h = h;
  }

  /** Add this frame's beam energy. `n` segments of 5 floats: x0,y0,x1,y1,energy. */
  function deposit(n) {
    if (!n) return;
    state.segments = n;
    gl.bindBuffer(gl.ARRAY_BUFFER, segBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, segData, 0, n * 5);

    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.w, target.h);
    gl.useProgram(progBeam.p);
    const stride = 5 * 4;
    const p0 = gl.getAttribLocation(progBeam.p, 'aP0');
    const p1 = gl.getAttribLocation(progBeam.p, 'aP1');
    const en = gl.getAttribLocation(progBeam.p, 'aEnergy');
    gl.enableVertexAttribArray(p0);
    gl.vertexAttribPointer(p0, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(p0, 1);
    gl.enableVertexAttribArray(p1);
    gl.vertexAttribPointer(p1, 2, gl.FLOAT, false, stride, 8);
    gl.vertexAttribDivisor(p1, 1);
    gl.enableVertexAttribArray(en);
    gl.vertexAttribPointer(en, 1, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(en, 1);

    bindQuad(progBeam, gl.getAttribLocation(progBeam.p, 'aCorner'));
    gl.uniform2f(progBeam.uniforms.uViewport, target.w, target.h);
    gl.uniform1f(progBeam.uniforms.uHalfWidth, state.sigma);
    gl.uniform1f(progBeam.uniforms.uExposure, state.exposure);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);        // energy ADDS — this is the model
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
    gl.disable(gl.BLEND);
  }

  /** Tone-map the energy buffer into `dest`. */
  function toneMap(dest) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, dest.fbo);
    gl.viewport(0, 0, dest.w, dest.h);
    gl.disable(gl.BLEND);
    gl.useProgram(progTone.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.tex);
    gl.uniform1i(progTone.uniforms.uAcc, 0);
    gl.uniform3f(progTone.uniforms.uColour, state.colour[0], state.colour[1], state.colour[2]);
    gl.uniform1f(progTone.uniforms.uE0, state.e0);
    bindQuad(progTone, gl.getAttribLocation(progTone.p, 'aPos'));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /** Blur one mip level of `from` into a target of that level's own size. */
  function blurLevel(from, into, lod) {
    if (!into.tex || into.w !== Math.max(1, from.w >> lod) || into.h !== Math.max(1, from.h >> lod)) {
      adopt(into, makeHaloBlur(Math.max(1, from.w >> lod), Math.max(1, from.h >> lod)));
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, into.fbo);
    gl.viewport(0, 0, into.w, into.h);
    gl.disable(gl.BLEND);
    gl.useProgram(progBlur.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, from.tex);
    gl.uniform1i(progBlur.uniforms.uSrc, 0);
    gl.uniform1f(progBlur.uniforms.uLod, lod);
    gl.uniform2f(progBlur.uniforms.uStep, 1 / Math.max(1, from.w >> lod), 1 / Math.max(1, from.h >> lod));
    bindQuad(progBlur, gl.getAttribLocation(progBlur.p, 'aPos'));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /** Add the halation cloud on top of the tone-mapped frame. */
  function addHalo(from) {
    blurLevel(from, haloNear, 4);
    blurLevel(from, haloWide, 6);
    blurLevel(from, haloFar, 8);
    gl.bindFramebuffer(gl.FRAMEBUFFER, display.fbo);
    gl.viewport(0, 0, display.w, display.h);
    gl.disable(gl.BLEND);
    gl.useProgram(progHalo.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, from.tex);
    gl.uniform1i(progHalo.uniforms.uSrc, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, haloNear.tex);
    gl.uniform1i(progHalo.uniforms.uNear, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, haloWide.tex);
    gl.uniform1i(progHalo.uniforms.uWide, 2);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, haloFar.tex);
    gl.uniform1i(progHalo.uniforms.uFar, 3);
    gl.uniform3f(progHalo.uniforms.uColour, state.colour[0], state.colour[1], state.colour[2]);
    gl.uniform1f(progHalo.uniforms.uMix, state.halo);
    bindQuad(progHalo, gl.getAttribLocation(progHalo.p, 'aPos'));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /** Tone-map the energy buffer to the display target, then blit it to the
   *  canvas. The display target exists so a test can read the frame back at any
   *  time without preserveDrawingBuffer. With 光晕 on, the tone map goes to a
   *  scratch instead so the halo pass has a luminance texture to scatter. */
  function present() {
    if (state.halo > 0) {
      if (!haloIn.tex || haloIn.w !== display.w || haloIn.h !== display.h) {
        adopt(haloIn, makeHaloSrc(display.w, display.h));
      }
      toneMap(haloIn);
      gl.bindTexture(gl.TEXTURE_2D, haloIn.tex);
      gl.generateMipmap(gl.TEXTURE_2D);
      addHalo(haloIn);
    } else {
      toneMap(display);
    }

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, display.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, display.w, display.h, 0, 0, display.w, display.h,
      gl.COLOR_BUFFER_BIT, gl.NEAREST);
    state.frames++;
  }

  /** The frame as RGBA bytes — the same shape a 2D canvas would give, so the
   *  caller does not have to care which renderer is running. */
  function readPixels(x, y, w, h, out) {
    const buf = out || new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, display.fbo);
    gl.readPixels(x, display.h - y - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return buf;
  }

  return {
    state,
    resize,
    clear,
    decay,
    deposit,
    present,
    readPixels,
    /** Segment scratch, exposed so the caller fills it without a copy. */
    segData,
    maxSegments: MAX_SEG,
    setColour(r, g, b) { state.colour = [r, g, b]; },
    setExposure(v) { state.exposure = v; },
    setSigma(v) { state.sigma = Math.max(0.5, v); },
    setTau(v) { state.tau = Math.max(0, v); },
    /** Halation amplitude. The ceiling is 3 rather than 1 because the wide taps
     *  are averages: at 1 the cloud peaked 2.6/255 above the ink on a dense
     *  passage, which is below what anyone can see. */
    setHalo(v) { state.halo = Math.max(0, Math.min(3, v)); },
    dispose() {
      for (const t of [target, display, scratch, haloIn, haloNear, haloWide, haloFar]) {
        if (t.tex) gl.deleteTexture(t.tex);
        if (t.fbo) gl.deleteFramebuffer(t.fbo);
      }
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
