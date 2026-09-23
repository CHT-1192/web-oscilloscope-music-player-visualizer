/* ============================================================================
 *  shaders.js — the GLSL the energy renderer is made of
 *
 *  Kept apart from gl.js because GLSL is a different language with a different
 *  debug loop: a typo here is a compile error the driver reports, while a typo
 *  in gl.js is a JavaScript error. Each program states what it is for and, where
 *  it matters, what it deliberately does NOT do.
 *
 *  The model: E += exposure · Σ (1/v) · spot, E *= exp(-dt/τ), display =
 *  colour · (1 - exp(-E/E₀)), and — opt-in, after the tone map — a scatter of
 *  the emitted light for halation.
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
uniform vec2 uViewport;
uniform float uHalfWidth;        // Gaussian sigma, in pixels (the beam's own width)
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
  float sigma = uHalfWidth;
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

   Four mip levels, weighted, approximate the long-tailed point spread function
   for four texture fetches and no extra passes. */
/* The taps are AVERAGES over 2, 16, 64 and 256 pixel cells, and how they are
   weighted is the whole game. Weighting the narrow ones (the obvious "bloom"
   choice) gives a tight halo that hugs the trace and dies within one octave.
   Weighting the octaves EQUALLY gives a long, roughly 1/r skirt, which is the
   cloud in reference photos 2 and 3.

   The wide taps are gamma-lifted, and that is not decoration. A flat box average
   is a bad estimate of a 1/r tail: a thin trace inside a 256-px cell averages a
   few percent, so the far field came out two or three 8-bit levels above black —
   measured, on a dense passage, as +2.6/255 on average away from the ink. Nobody
   can see that, which is why 光晕 100 looked like nothing. pow(x, 0.75) puts the
   tail back in the visible band; it is monotone, so the profile still falls with
   distance, and every tap stays <= 1, so the cloud still adds at most uMix and
   never becomes a second image of the trace. */
const FRAG_HALO = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;          // tone-mapped frame, mipmapped
uniform sampler2D uNear;         // blurred mip 4  (~16 px cells)
uniform sampler2D uWide;         // blurred mip 6  (~64 px cells)
uniform sampler2D uFar;          // blurred mip 8  (~256 px cells)
uniform vec3 uColour;
uniform float uMix;              // halation amplitude; 0 = the pass is skipped
out vec4 outColour;

void main() {
  float l = texture(uSrc, vUv).a;
  float h = 0.34 * textureLod(uSrc, vUv, 1.0).a
          + 0.24 * texture(uNear, vUv).a
          + 0.22 * pow(texture(uWide, vUv).a, 0.75)
          + 0.20 * pow(texture(uFar, vUv).a, 0.75);
  float a = min(1.0, l + uMix * h);
  outColour = vec4(uColour * a, a);
}`;

/* Blur one mip level before anything samples it, and this is not optional: a
   single bilinear tap on a coarse level magnifies its texel lattice, and with a
   thin trace that lattice is a string of beads — a few bright texels separated
   by empty ones, each reconstructed as its own little dot. A 13-tap tent takes
   the lattice out. It runs at the level's own resolution, so it is cheap. */
const FRAG_BLUR = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
uniform float uLod;              // which mip level to read
uniform vec2 uStep;              // one texel of THAT level, in uv
out vec4 outColour;
void main() {
  float c = textureLod(uSrc, vUv, uLod).a * 4.0;
  float e = (textureLod(uSrc, vUv + vec2(uStep.x, 0.0), uLod).a
           + textureLod(uSrc, vUv - vec2(uStep.x, 0.0), uLod).a
           + textureLod(uSrc, vUv + vec2(0.0, uStep.y), uLod).a
           + textureLod(uSrc, vUv - vec2(0.0, uStep.y), uLod).a) * 2.0;
  float d = textureLod(uSrc, vUv + vec2(uStep.x, uStep.y), uLod).a
          + textureLod(uSrc, vUv - vec2(uStep.x, uStep.y), uLod).a
          + textureLod(uSrc, vUv + vec2(uStep.x, -uStep.y), uLod).a
          + textureLod(uSrc, vUv - vec2(uStep.x, -uStep.y), uLod).a;
  float o = textureLod(uSrc, vUv + vec2(uStep.x * 2.0, 0.0), uLod).a
          + textureLod(uSrc, vUv - vec2(uStep.x * 2.0, 0.0), uLod).a
          + textureLod(uSrc, vUv + vec2(0.0, uStep.y * 2.0), uLod).a
          + textureLod(uSrc, vUv - vec2(0.0, uStep.y * 2.0), uLod).a;
  outColour = vec4((c + e + d + o) / 20.0);
}`;

export {
  VERT_QUAD,
  FRAG_DECAY,
  FRAG_COPY,
  VERT_BEAM,
  FRAG_BEAM,
  FRAG_TONE,
  FRAG_HALO,
  FRAG_BLUR,
};
