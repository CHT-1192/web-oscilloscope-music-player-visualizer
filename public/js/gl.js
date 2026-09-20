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
 *  What it deliberately does NOT do: no blur, no bloom pass. The additive step
 *  happens on the pixel the beam actually hits, spread only by the beam's own
 *  Gaussian spot, and that spot's sigma is the caller's business. With a constant
 *  sigma (the default) brightness never bleeds into a pixel the beam did not
 *  illuminate, which is what keeps "no glow" true even though the accumulation is
 *  additive.
 *
 *  The one exception is opt-in and physical rather than cosmetic: a real tube's
 *  spot SWELLS with beam current (space charge, and a finite cathode), so a beam
 *  that dwells writes a disc instead of a point — the saturated core plus the
 *  skirt around it is the halo you see on an analog scope. That is a per-instance
 *  sigma (`aSwell`, 1 = the line width), still a Gaussian whose tail is
 *  subtracted so it reaches exactly zero at 3σ: the halo stays inside the spot
 *  and never becomes an unbounded tail. The caller defaults it to 1.
 *
 *  Everything above is GPU-side; the CPU uploads one instance record per
 *  segment (6 floats) and issues three draw calls per frame.
 * ========================================================================== */

const VERT_QUAD = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG_DECAY = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uAcc;
uniform float uKeep;
out vec4 outColour;
void main() {
  outColour = vec4(texture(uAcc, vUv).r * uKeep, 0.0, 0.0, 1.0);
}`;

const FRAG_COPY = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uAcc;
out vec4 outColour;
void main() {
  outColour = vec4(texture(uAcc, vUv).r, 0.0, 0.0, 1.0);
}`;

const VERT_BEAM = `#version 300 es
in vec2 aCorner;                 // the unit quad, 6 vertices, shared by all instances
in vec2 aP0;                     // segment start, device pixels
in vec2 aP1;                     // segment end
in float aEnergy;                // exposure for this segment (∝ 1/speed, 0 = blanked)
in float aSwell;                 // spot sigma for this segment, in multiples of uHalfWidth
uniform vec2 uViewport;
uniform float uHalfWidth;        // base Gaussian sigma, in pixels (the line width)
uniform float uExposure;         // energy per unit of 1/v, per frame
out vec2 vPos;                   // pixel position
out vec2 vA;                     // segment start
out vec2 vB;                     // segment end
out float vEnergy;
out float vSigma;

vec2 toClip(vec2 p) {
  return vec2(p.x / uViewport.x * 2.0 - 1.0, 1.0 - p.y / uViewport.y * 2.0);
}

void main() {
  vec2 seg = aP1 - aP0;
  float len = max(length(seg), 0.0001);
  vec2 dir = seg / len;
  vec2 nrm = vec2(-dir.y, dir.x);
  float sigma = uHalfWidth * max(aSwell, 0.05);
  float reach = sigma * 3.0;                          // ~3σ covers the spot
  vec2 along = dir * (len * 0.5 + reach);
  vec2 across = nrm * reach;
  vec2 centre = (aP0 + aP1) * 0.5;
  vec2 p = centre + along * aCorner.x + across * aCorner.y;

  vPos = p;
  vA = aP0;
  vB = aP1;
  vEnergy = aEnergy;
  vSigma = sigma;
  gl_Position = vec4(toClip(p), 0.0, 1.0);
}`;

const FRAG_BEAM = `#version 300 es
precision highp float;
in vec2 vPos;
in vec2 vA;
in vec2 vB;
in float vEnergy;
in float vSigma;
out vec4 outColour;

/* Distance from a point to a segment, and where along it the closest point is:
   the spot is a Gaussian centred on the beam, so the deposit across the line
   follows that profile and the ends fade the way a real spot's do. */
uniform float uExposure;

void main() {
  vec2 ab = vB - vA;
  float len2 = max(dot(ab, ab), 0.0001);
  float t = clamp(dot(vPos - vA, ab) / len2, 0.0, 1.0);
  vec2 closest = vA + ab * t;
  float d = length(vPos - closest);
  /* Gaussian, but with the tail SUBTRACTED so it reaches exactly zero at 3σ of
     THIS instance's sigma — the quad's edge. A phosphor spot does have Gaussian
     wings, but an additive tail that never reaches zero is an unbounded halo, and
     "brightness never bleeds into a pixel the beam did not illuminate" is a hard
     requirement here. Swelling sigma (the opt-in halo) widens the spot; it never
     gives it a tail. */
  float g = exp(-(d * d) / (2.0 * vSigma * vSigma)) - 0.011109;   // exp(-4.5)
  outColour = vec4(vEnergy * uExposure * max(g, 0.0), 0.0, 0.0, 1.0);
}`;

const FRAG_TONE = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uAcc;
uniform vec3 uColour;
uniform float uE0;
out vec4 outColour;
void main() {
  float e = texture(uAcc, vUv).r;
  // Saturating, not clipping: linear while the phosphor is dim, asymptotic as it
  // approaches full brightness.
  float a = 1.0 - exp(-max(e, 0.0) / uE0);
  outColour = vec4(uColour * a, a);          // premultiplied, for compositing
}`;

/* ------------------------------------------------------------------ halation
   Light generated in the phosphor does not all leave where it was made: it
   scatters sideways in the powder and then bounces inside the glass, so a bright
   trace sits inside a wide, dim cloud. That cloud is what a photograph of a real
   scope shows around the whole figure (reference photos 2 and 3), and it is NOT
   a property of the beam.

   Which is exactly why it has to happen HERE and not in the beam pass. Applied
   to the energy buffer, a dwell deposits thousands of times the energy that
   saturates the tone map, so any halo term is itself saturated out to its own
   cutoff — the result is a flat disc with a hard edge, which is what the first
   attempt produced. Halation scatters light that has ALREADY been emitted, i.e.
   the bounded luminance, and then it can never exceed its own amplitude.

   Five mip levels, weighted, approximate the long-tailed point spread function
   for five texture fetches and no extra passes. Sum of weights = 1, so the cloud
   adds at most uMix to any pixel. */
/* The taps are AVERAGES over 8, 16, 32, 64, 128 and 256 pixels, and how they are
   weighted is the whole game. Weighting the narrow ones (the obvious "bloom"
   choice) gives a tight halo that hugs the trace and dies within one octave.
   Weighting them EQUALLY gives each octave the same contribution, which is what
   a long-tailed, roughly 1/r glare looks like: a bright core, then a skirt that
   keeps going out to a sixth of the screen. That is the cloud in reference
   photos 2 and 3, and it is a convolution — its far field is the local average
   luminance, which is why the cloud is obvious around a dense figure and nearly
   invisible around one thin line. Nothing here rescales that away: the taps sum
   to 1 and every tap is <= 1, so the cloud adds at most uMix and never becomes a
   second image of the trace. */
const FRAG_HALO = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;          // tone-mapped frame, mipmapped
uniform vec3 uColour;
uniform float uMix;              // halation amplitude; 0 = the pass is skipped
out vec4 outColour;
const float W0 = 0.22, W1 = 0.20, W2 = 0.18, W3 = 0.16, W4 = 0.14, W5 = 0.10;
void main() {
  float l = texture(uSrc, vUv).a;
  float h = W0 * textureLod(uSrc, vUv, 3.0).a
          + W1 * textureLod(uSrc, vUv, 4.0).a
          + W2 * textureLod(uSrc, vUv, 5.0).a
          + W3 * textureLod(uSrc, vUv, 6.0).a
          + W4 * textureLod(uSrc, vUv, 7.0).a
          + W5 * textureLod(uSrc, vUv, 8.0).a;
  float a = min(1.0, l + uMix * h);
  outColour = vec4(uColour * a, a);
}`;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

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
    seg[0] = 10; seg[1] = 32; seg[2] = 54; seg[3] = 32; seg[4] = 1; seg[5] = 1;
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

  let progDecay, progCopy, progBeam, progTone, progHalo;
  try {
    progDecay = program(gl, VERT_QUAD, FRAG_DECAY);
    progCopy = program(gl, VERT_QUAD, FRAG_COPY);
    progBeam = program(gl, VERT_BEAM, FRAG_BEAM);
    progTone = program(gl, VERT_QUAD, FRAG_TONE);
    progHalo = program(gl, VERT_QUAD, FRAG_HALO);
  } catch (e) {
    return null;                                  // shader trouble: fall back
  }

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);

  const MAX_SEG = 32768;
  const segBuf = gl.createBuffer();
  const segData = new Float32Array(MAX_SEG * 6);   // x0,y0,x1,y1,energy,swell
  gl.bindBuffer(gl.ARRAY_BUFFER, segBuf);
  gl.bufferData(gl.ARRAY_BUFFER, segData.byteLength, gl.DYNAMIC_DRAW);

  const target = { tex: null, fbo: null, w: 0, h: 0 };
  const display = { tex: null, fbo: null, w: 0, h: 0 };
  const scratch = { tex: null, fbo: null, w: 0, h: 0 };
  const haloIn = { tex: null, fbo: null, w: 0, h: 0 };

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

  /** Add this frame's beam energy. `n` segments of 6 floats:
   *  x0,y0,x1,y1,energy,swell. */
  function deposit(n) {
    if (!n) return;
    state.segments = n;
    gl.bindBuffer(gl.ARRAY_BUFFER, segBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, segData, 0, n * 6);

    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.w, target.h);
    gl.useProgram(progBeam.p);
    const stride = 6 * 4;
    const p0 = gl.getAttribLocation(progBeam.p, 'aP0');
    const p1 = gl.getAttribLocation(progBeam.p, 'aP1');
    const en = gl.getAttribLocation(progBeam.p, 'aEnergy');
    const sw = gl.getAttribLocation(progBeam.p, 'aSwell');
    gl.enableVertexAttribArray(p0);
    gl.vertexAttribPointer(p0, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(p0, 1);
    gl.enableVertexAttribArray(p1);
    gl.vertexAttribPointer(p1, 2, gl.FLOAT, false, stride, 8);
    gl.vertexAttribDivisor(p1, 1);
    gl.enableVertexAttribArray(en);
    gl.vertexAttribPointer(en, 1, gl.FLOAT, false, stride, 16);
    gl.vertexAttribDivisor(en, 1);
    gl.enableVertexAttribArray(sw);
    gl.vertexAttribPointer(sw, 1, gl.FLOAT, false, stride, 20);
    gl.vertexAttribDivisor(sw, 1);

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

  /** Add the halation cloud on top of the tone-mapped frame. */
  function addHalo(from) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, display.fbo);
    gl.viewport(0, 0, display.w, display.h);
    gl.disable(gl.BLEND);
    gl.useProgram(progHalo.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, from.tex);
    gl.uniform1i(progHalo.uniforms.uSrc, 0);
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
    setHalo(v) { state.halo = clamp01(v); },
    dispose() {
      for (const t of [target, display, scratch, haloIn]) {
        if (t.tex) gl.deleteTexture(t.tex);
        if (t.fbo) gl.deleteFramebuffer(t.fbo);
      }
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
