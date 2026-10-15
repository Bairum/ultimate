/*
 * Adapted from React Bits' CrystalizedBall (https://reactbits.dev/animations/crystalized-ball, MIT): its glass ball,
 * electric rim and glowing dust, without the presets, the pointer interactions and their dust simulation. Here the dust
 * streams down into the ball from above, filling it as it arrives. Once `done` the ball condenses into a small bright orb
 * that drops to `drop`.
 */
import { Geometry, Mesh, Program, RenderTarget, Renderer, Texture, Triangle } from 'ogl'
import { useEffect, useRef } from 'react'

type Rgb = [number, number, number]

interface Palette {
  rim: Rgb
  rimHot: Rgb
  rimMid: Rgb
  rimDeep: Rgb
  spark: Rgb
  sparkGlow: Rgb
  haze: Rgb
  edge: Rgb
  tones: Rgb[]
}

interface Arc {
  start: number
  span: number
  curl: number
  life: number
  duration: number
  drift: number
  strength: number
}

/** The ball's look: React Bits' "frost" motion with "nebula"-like strands, toned down. */
const look = {
  strands: 6,
  crackle: 0.6,
  flares: 0.5,
  glow: 0.65,
  sparks: 0.45,
  fill: 0.55,
  depth: 0.6,
  sway: 0.5,
  twinkle: 0.5,
  haze: 0.7,
  dustSpeed: 0.8,
}
const MAX_STRANDS = 8
const MAX_ARCS = 4
const PARTICLES = 12000
const STATE_WIDTH = 256
const PIXEL_BUDGET = 4.5e6
/** Seconds the rim takes to form. */
const INTRO = 2.2
/** Most of the dust starts falling along 1 - exp(-t / FILL), in seconds; the rest trickles in, in cycles. */
const FILL = 4
const SETTLED = 0.8
const TRICKLE = 5
/** Seconds a grain takes to fall into the ball. */
const FALL = 1.8
/**
 * Seconds the finish takes: the first CONDENSE of it the ball shrinks to an orb of ORB its radius, then the orb drops,
 * its dust up to TAIL behind.
 */
export const DROP = 1.2
const CONDENSE = 0.45
const ORB = 0.1
const TAIL = 0.05
/** The ball's radius as a fraction of the shorter side, and its centre from the top. */
export const ballSize = { fraction: 0.14, min: 56, max: 150, top: 0.45 }
const WHITE: Rgb = [1, 1, 1]
const BLACK: Rgb = [0, 0, 0]

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)
const smooth = (edge0: number, edge1: number, value: number) => {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)
const mixColor = (a: number[], b: number[], t: number): Rgb =>
  a.map((v, i) => v + (b[i] - v) * t) as Rgb

const hexToRgb = (hex: string): Rgb => {
  const n = Number.parseInt(hex.replace('#', '').slice(0, 6), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
const toGamma = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)

const toOklab = (rgb: number[]): Rgb => {
  const [r, g, b] = rgb.map(toLinear)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

const fromOklab = ([L, a, b]: number[]): Rgb => {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3)
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3)
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3)
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => clamp(toGamma(clamp(v, 0, 1)), 0, 1)) as Rgb
}

const blend = (a: Rgb, b: Rgb, t: number): Rgb => fromOklab(mixColor(toOklab(a), toOklab(b), t))

const shift = (rgb: Rgb, hue: number, lightness: number, chroma: number): Rgb => {
  const [L, a, b] = toOklab(rgb)
  const c = Math.hypot(a, b) * chroma
  const h = Math.atan2(b, a) + (hue * Math.PI) / 180
  return fromOklab([clamp(L + lightness, 0, 1), c * Math.cos(h), c * Math.sin(h)])
}

const withLightness = (rgb: Rgb, hue: number, lightness: number, chroma: number): Rgb => {
  const [, a, b] = toOklab(rgb)
  const c = Math.max(Math.hypot(a, b) * chroma, 0.02)
  const h = Math.atan2(b, a) + (hue * Math.PI) / 180
  return fromOklab([clamp(lightness, 0, 1), c * Math.cos(h), c * Math.sin(h)])
}

const buildPalette = (color: Rgb, light: boolean): Palette => {
  if (light) {
    const ink = withLightness(color, 0, Math.min(toOklab(color)[0], 0.62), 1.15)
    return {
      rim: ink,
      rimHot: ink,
      rimMid: ink,
      rimDeep: withLightness(color, 0, 0.72, 0.8),
      spark: withLightness(color, 0, 0.6, 1.2),
      sparkGlow: withLightness(color, 0, 0.78, 0.8),
      haze: withLightness(color, 0, 0.8, 0.6),
      edge: withLightness(color, 0, 0.72, 0.8),
      tones: [
        withLightness(color, 0, 0.56, 1.1),
        withLightness(color, 16, 0.6, 1.05),
        withLightness(color, -16, 0.5, 1.1),
        withLightness(color, 0, 0.66, 0.9),
        withLightness(color, 0, 0.74, 0.7),
      ],
    }
  }
  return {
    rim: color,
    rimHot: mixColor(color, WHITE, 0.5),
    rimMid: mixColor(color, BLACK, 0.15),
    rimDeep: mixColor(color, BLACK, 0.45),
    spark: mixColor(color, WHITE, 0.45),
    sparkGlow: shift(color, 0, -0.15, 1),
    haze: mixColor(color, BLACK, 0.6),
    edge: shift(color, 0, -0.3, 0.9),
    tones: [
      shift(color, 0, -0.06, 1),
      shift(color, 16, -0.02, 1),
      shift(color, -16, -0.12, 1.05),
      shift(blend(color, WHITE, 0.25), 0, 0.04, 1),
      blend(color, WHITE, 0.7),
    ],
  }
}

const seeded = (start: number) => {
  let state = start >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const buildStrands = () => {
  const random = seeded(99)
  const bands = [
    [6, 12, 0.6, 1.6],
    [18, 34, 1.5, 3.5],
    [40, 70, 3, 7],
    [80, 130, 6, 12],
  ]
  const data = {
    harmonics: [] as number[],
    rates: [] as number[],
    phases: [] as number[],
    flareHarmonics: [] as number[],
    flareRates: [] as number[],
    flarePhases: [] as number[],
  }
  for (let s = 0; s < MAX_STRANDS; s++) {
    for (const [low, high, slow, fast] of bands) {
      data.harmonics.push(Math.round(low + random() * (high - low)))
      data.rates.push((slow + random() * (fast - slow)) * (random() < 0.5 ? -1 : 1))
      data.phases.push(random() * Math.PI * 2)
    }
    for (let j = 0; j < 3; j++) {
      data.flareHarmonics.push(4 + Math.floor(random() * 6))
      data.flareRates.push((0.4 + random() * 0.8) * (random() < 0.5 ? -1 : 1))
      data.flarePhases.push(random() * Math.PI * 2)
    }
    const lead = s === 0
    data.flareHarmonics.push(lead ? 0.75 : 0.95 + random() * 0.3)
    data.flareRates.push(lead ? 1.15 : 0.8 + random() * 0.2)
    data.flarePhases.push(lead ? 1 : 0.7 + random() * 0.25)
  }
  return data
}

/** Each grain's resting place in the ball (bottom-heavy, a band along the rim) and its tone, size and timing seeds. */
const buildDust = (count: number) => {
  const random = seeded(1337)
  const rows = Math.max(1, Math.ceil(count / STATE_WIDTH))
  const home = new Float32Array(STATE_WIDTH * rows * 4)
  const seed = new Float32Array(STATE_WIDTH * rows * 4)
  let k = 0
  let guard = 0
  while (k < count && guard < count * 80) {
    guard++
    let x: number
    let y: number
    let tone: number
    if (random() < 0.28) {
      const angle = random() * Math.PI * 2
      const radius = 0.87 + Math.sqrt(random()) * 0.105
      x = Math.cos(angle) * radius
      y = Math.sin(angle) * radius
      if (random() > smooth(-0.6, 0.3, -y)) continue
      const q = random()
      tone = q < 0.5 ? 3 : q < 0.8 ? 2 : 1
    } else {
      x = random() * 2 - 1
      y = random() * 2 - 1
      const radius = Math.hypot(x, y)
      if (radius > 0.975) continue
      const bowl = Math.pow(smooth(-0.25, 0.85, -y), 1.3)
      const band = smooth(0.66, 0.96, radius) * smooth(-0.7, 0.3, -y)
      const weight = Math.max(bowl, band * 0.9)
      if (random() > 0.012 + 0.988 * weight) continue
      if (weight < 0.12) tone = 4
      else {
        const q = random()
        tone = q < 0.32 ? 0 : q < 0.52 ? 1 : q < 0.8 ? 2 : 3
      }
    }
    const chord = Math.sqrt(Math.max(0, 0.95 - x * x - y * y))
    home[k * 4] = x
    home[k * 4 + 1] = y
    home[k * 4 + 2] = (random() * 2 - 1) * chord
    home[k * 4 + 3] = tone
    seed[k * 4] = tone === 4 ? 1.8 : random() < 0.22 ? 2.1 : 1.3
    seed[k * 4 + 1] = random()
    seed[k * 4 + 2] = 2.5 + random() * 3.5
    seed[k * 4 + 3] = 0.16 + random() * 0.26
    k++
  }
  return { home, seed, count: k, rows }
}

const glsl = (value: number) => value.toFixed(3)

const passVertex = `#version 300 es
in vec2 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0.0, 1.0);
}
`

const hashChunk = `
uint scramble(uint v) {
  v = v * 747796405u + 2891336453u;
  uint w = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  return (w >> 22u) ^ w;
}

float random(uint v) {
  return float(scramble(v)) * (1.0 / 4294967295.0);
}
`

/** A grain's place in the ball: settled into the bowl, sinking through its life, wobbling and swaying with the ball. */
const dustChunk = `
uniform float uDustTime;
uniform vec2 uTurn;
uniform float uFill;

vec3 settle(vec3 p, out float spread) {
  float bend = exp2((0.5 - uFill) * 1.8);
  float h = clamp((p.y + 1.0) * 0.5, 0.0, 1.0);
  float y = 2.0 * pow(h, bend) - 1.0;
  float from = sqrt(max(1.0 - p.y * p.y, 1e-4));
  float to = sqrt(max(1.0 - y * y, 0.0));
  spread = clamp(bend * pow(max(h, 1e-3), bend - 1.0) * to / from, 0.25, 1.0);
  return vec3(p.xz * (to / from), y).xzy;
}

vec3 drift(vec4 home, vec4 seed, uint id, out float life, out float spread) {
  vec3 p = settle(home.xyz, spread);
  float t = uDustTime;
  float u = fract(t / seed.z + seed.y);
  life = sin(3.14159265 * u);
  p.y -= seed.w * (u - 0.5);
  float wobble = 0.002 + 0.006 * random(id * 7u + 1u);
  float w1 = 0.8 + 2.4 * random(id * 7u + 2u);
  float w2 = 0.8 + 2.4 * random(id * 7u + 4u);
  p += wobble * vec3(sin(t * w1 + seed.y * 40.0), cos(t * w2 + seed.z * 30.0), sin(t * (w1 + w2) * 0.5 + seed.w * 20.0));
  float cy = cos(uTurn.x);
  float sy = sin(uTurn.x);
  p.xz = mat2(cy, -sy, sy, cy) * p.xz;
  float cx = cos(uTurn.y);
  float sx = sin(uTurn.y);
  p.yz = mat2(cx, -sx, sx, cx) * p.yz;
  return p;
}
`

const fieldFragment = `#version 300 es
precision highp float;

uniform vec2 uCenter;
uniform float uRadius;
uniform float uDpr;
uniform float uLine;
uniform float uTime;
uniform float uFrame;
uniform float uBins;
uniform float uStrands;
uniform float uCrackle;
uniform float uFlares;
uniform float uGlow;
uniform float uHaze;
uniform float uFill;
uniform float uPresence;
uniform float uUnfold;
uniform float uBloom;
uniform float uInside;
uniform float uCore;
uniform float uEncode;
uniform vec3 uRim;
uniform vec3 uRimHot;
uniform vec3 uRimMid;
uniform vec3 uRimDeep;
uniform vec3 uSpark;
uniform vec3 uSparkGlow;
uniform vec3 uHazeColor;
uniform vec3 uEdgeColor;
uniform vec4 uHarmonics[8];
uniform vec4 uRates[8];
uniform vec4 uPhases[8];
uniform vec4 uFlareHarmonics[8];
uniform vec4 uFlareRates[8];
uniform vec4 uFlarePhases[8];
uniform vec4 uArcs[4];

out vec4 fragColor;
${hashChunk}
const float PI = 3.14159265;
const float TAU = 6.28318531;
const vec4 AMPS = vec4(0.35, 0.3, 0.22, 0.13);

float bell(float d, float w) {
  float x = d / w;
  return exp(-x * x);
}

float pool(vec2 q) {
  float t = length(q - vec2(0.0, mix(-1.0, -0.66, uFill))) / mix(0.8, 1.35, uFill);
  return t < 0.6 ? mix(0.5, 0.22, t / 0.6) : mix(0.22, 0.0, clamp((t - 0.6) / 0.4, 0.0, 1.0));
}

void main() {
  vec2 p = gl_FragCoord.xy / uDpr - uCenter;
  float r = length(p);
  float R = uRadius;
  float theta = atan(p.y, p.x);
  float lift = p.y / max(r, 1e-3);
  float topDim = 1.0 - 0.35 * pow(max(lift, 0.0), 1.5);
  vec3 col = vec3(0.0);
  float hot = 0.0;
  uint frame = uint(uFrame);

  if (r < R) {
    vec2 q = p / R;
    float chord = sqrt(max(1.0 - dot(q, q), 0.0));
    float haze = pool(q) * (0.55 + 0.45 * chord);
    col += uHazeColor * haze * uHaze * uInside;
    float e = length(q - vec2(0.0, 0.2)) / 1.2;
    float edge = 0.5 * pow(smoothstep(0.62, 1.0, e), 1.4);
    col += uEdgeColor * edge * uInside * (0.5 + 0.5 * uHaze);
  }

  // Condensed, the ball is a lit orb: a soft core and its halo.
  col += (uRimHot * 0.9 * exp(-r * r / (R * R * 0.5)) + uRim * 0.3 * exp(-r * r / (R * R * 5.0))) * uCore;
  hot += exp(-r * r / (R * R * 0.5)) * uCore * 0.5;

  float dr = r - R;
  float halo = 1.0 - smoothstep(R * 0.05, R * 0.105, abs(dr - R * 0.0213));
  col += uRimDeep * 0.18 * halo * topDim * uGlow * uBloom;
  col += uRim * 0.12 * bell(dr + R * 0.0383, R * 0.032) * uGlow * uBloom;
  col += uRim * 0.32 * bell(dr, max(R * 0.0117, uLine)) * uPresence * uUnfold;

  float amp = R * 0.016 * (0.3 + 1.4 * uCrackle) * uUnfold;
  float jitterAmp = R * 0.0048 * (0.3 + 1.4 * uCrackle) * uUnfold;
  float flareAmp = R * 0.064 * (0.4 + 1.2 * uCrackle) * uFlares * 1.6 * uUnfold;

  if (abs(dr) < amp * 2.0 + flareAmp + R * 0.3) {
    float step = TAU / uBins;
    float binPos = (theta + PI) / step;
    float bin0 = floor(binPos);
    float binF = binPos - bin0;
    float th0 = bin0 * step - PI;
    float th1 = th0 + step;
    uint b0 = uint(mod(bin0, uBins));
    uint b1 = uint(mod(bin0 + 1.0, uBins));
    float gain = min(1.0, 2.4 / max(uStrands, 1.0));
    for (int k = 0; k < 8; k++) {
      if (float(k) >= uStrands) break;
      vec4 m = uHarmonics[k];
      vec4 lead = uRates[k] * uTime + uPhases[k];
      float wave0 = dot(AMPS, sin(m * th0 + lead));
      float wave1 = dot(AMPS, sin(m * th1 + lead));
      uint salt = uint(k) * 1013u + frame * 7919u;
      vec4 shape = uFlareHarmonics[k];
      vec4 look = uFlareRates[k];
      vec4 tone = uFlarePhases[k];
      float a = amp * shape.w;
      float off0 = a * wave0 + jitterAmp * (random(b0 + salt) - 0.5);
      float off1 = a * wave1 + jitterAmp * (random(b1 + salt) - 0.5);
      float rc = R + mix(off0, off1, binF);
      float grade = (off1 - off0) / (step * max(r, 1.0));
      float d = abs(r - rc) * inversesqrt(1.0 + grade * grade);
      float swell = 0.8 + 0.4 * (0.5 + 0.5 * sin(3.0 * theta + uTime * 0.7 + tone.x * 1.7));
      float width = uLine * look.w * swell;
      float core = exp(-d * d / (width * width));
      float sheath = exp(-d * d / (width * width * 3.0));
      float bright = tone.w * uPresence;
      col += (uRimHot * core * 0.8 + uRim * sheath * 0.32) * bright;
      hot += core * bright;
      vec3 fargs = shape.xyz * theta + look.xyz * uTime + tone.xyz;
      float flare = max(0.0, (sin(fargs.x) + sin(fargs.y) + sin(fargs.z)) / 3.0);
      flare = flare * flare * flareAmp;
      float dw = abs(r - rc - flare);
      float dm = abs(r - rc - flare * 0.6);
      float dn = abs(r - rc - flare * 0.25);
      vec3 glow = uRimDeep * (0.07 * bell(dw, R * 0.09) + 0.16 * bell(dw, R * 0.05));
      glow += uRimMid * 0.28 * bell(dm, R * 0.027) + uRim * 0.38 * bell(dn, R * 0.013);
      col += glow * gain * topDim * uGlow * uBloom;
    }
  }

  for (int i = 0; i < 4; i++) {
    vec4 arc = uArcs[i];
    if (arc.w <= 0.002) continue;
    float mid = arc.x + arc.y * 0.5;
    vec2 center = R * 0.93 * vec2(cos(mid), sin(mid));
    if (distance(p, center) > R * (abs(arc.y) * 0.6 + 0.1) + 12.0) continue;
    float ar = R * 0.955;
    vec2 a0 = ar * vec2(cos(arc.x), sin(arc.x));
    vec2 a2 = ar * vec2(cos(arc.x + arc.y), sin(arc.x + arc.y));
    vec2 a1 = R * (0.955 - arc.z) * vec2(cos(mid), sin(mid));
    float dmin = 1e5;
    float along = 0.0;
    vec2 prev = a0;
    for (int s = 1; s <= 10; s++) {
      float u = float(s) / 10.0;
      vec2 b = mix(mix(a0, a1, u), mix(a1, a2, u), u);
      vec2 pa = p - prev;
      vec2 ba = b - prev;
      float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-5), 0.0, 1.0);
      float dist = length(pa - ba * h);
      if (dist < dmin) {
        dmin = dist;
        along = (float(s) - 1.0 + h) / 10.0;
      }
      prev = b;
    }
    float taper = sqrt(max(sin(PI * along), 0.0));
    float arcWidth = uLine * (0.55 + 0.6 * taper);
    float arcCore = exp(-dmin * dmin / (arcWidth * arcWidth));
    float arcGlow = exp(-dmin * dmin / (arcWidth * arcWidth * 12.0));
    col += (uSpark * 0.95 * arcCore + uSparkGlow * 0.4 * arcGlow) * arc.w * taper;
    hot += arcCore * arc.w * taper * 0.6;
  }

  fragColor = vec4(col, hot) * uEncode;
}
`

/**
 * A grain: hidden until its turn, then falling from somewhere above (where the conversation was) into its place in the
 * ball, drawn in towards the middle as it drops. Once `uDrop` rises it follows the ball down, a little late, so the
 * dust trails behind it.
 */
const dustVertex = `#version 300 es
precision highp float;

in float aIndex;

uniform sampler2D tHome;
uniform sampler2D tSeed;
uniform vec2 uOrigin;
uniform vec2 uTarget;
uniform vec2 uViewport;
uniform float uSize;
uniform float uDpr;
uniform float uDepth;
uniform float uTwinkle;
uniform float uPointScale;
uniform float uEncode;
uniform float uClock;
uniform float uSky;
uniform float uSpread;
uniform float uDrop;
uniform vec3 uTones[5];
uniform vec3 uRimTone;

out vec3 vColor;
out float vSize;
${hashChunk}
${dustChunk}
void hide() {
  gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
  gl_PointSize = 0.0;
  vColor = vec3(0.0);
  vSize = 0.0;
}

void main() {
  ivec2 cell = ivec2(int(mod(aIndex, ${STATE_WIDTH}.0)), int(floor(aIndex / ${STATE_WIDTH}.0)));
  uint id = uint(aIndex);
  vec4 home = texelFetch(tHome, cell, 0);
  vec4 seed = texelFetch(tSeed, cell, 0);
  float life;
  float spread;
  vec3 p = drift(home, seed, id, life, spread);

  float order = random(id * 7u + 17u);
  float start;
  float stay = 1.0;
  if (order < ${glsl(SETTLED)}) {
    start = -${glsl(FILL)} * log(1.0 - order / ${glsl(SETTLED)} * 0.97);
  } else {
    float local = mod(uClock + random(id * 7u + 18u) * ${glsl(TRICKLE)}, ${glsl(TRICKLE)});
    start = uClock - local;
    stay = 1.0 - smoothstep(${glsl(TRICKLE * 0.7)}, ${glsl(TRICKLE)}, local);
    if (start < 0.0) {
      hide();
      return;
    }
  }
  float fallen = (uClock - start) / ${glsl(FALL)};
  if (fallen < 0.0) {
    hide();
    return;
  }
  float f = min(fallen, 1.0);
  float aloft = 1.0 - smoothstep(0.6, 1.0, f);
  vec2 from = vec2((random(id * 7u + 19u) * 2.0 - 1.0) * uSpread, mix(1.3, uSky, random(id * 7u + 20u)));
  p.xy = vec2(mix(from.x, p.x, smoothstep(0.0, 0.85, f)), mix(from.y, p.y, f * f));

  float landed = step(1.0, fallen);
  float inside = mix(1.0, 1.0 - smoothstep(0.955, 0.985, length(p.xy)), landed);
  float len = length(p);
  if (landed > 0.5 && len > 0.975) p *= 0.975 / len;
  float late = random(id * 7u + 21u) * ${glsl(TAIL)};
  float drop = clamp((uDrop - late - ${glsl(CONDENSE)}) / ${glsl(1 - CONDENSE)}, 0.0, 1.0);
  vec2 centre = mix(uOrigin, uTarget, drop * drop);
  float condensed = smoothstep(0.0, ${glsl(CONDENSE)}, uDrop);
  float radius = uSize * mix(1.0, ${glsl(ORB)}, condensed);

  float front = p.z * 0.5 + 0.5;
  float depthSize = mix(1.0, 0.7 + 0.6 * front, uDepth);
  float depthLight = mix(1.0, 0.35 + 0.8 * front, uDepth);
  float blink = sin(uDustTime * (2.0 + 6.0 * random(id * 7u + 5u)) + random(id * 7u + 6u) * 6.2831853);
  float twinkle = mix(1.0, smoothstep(-0.9, -0.6, blink), uTwinkle);
  float shine = mix(life, 1.0, aloft);
  float fade = smoothstep(0.04, 0.12, shine) * smoothstep(0.0, 0.25, f) * stay;
  float alpha = random(id * 7u + 9u) < 0.5 || home.w > 3.5 ? 1.0 : 0.6;

  float size = seed.x * uPointScale * (0.35 + 0.95 * shine) * depthSize * mix(1.0, 0.6, condensed);
  vec2 screen = centre + p.xy * radius;
  gl_Position = vec4(screen / uViewport * 2.0 - 1.0, 0.0, 1.0);
  float px = size * uDpr;
  gl_PointSize = px + 2.0;
  vSize = px;

  int tone = int(home.w + 0.5);
  float rimLit = smoothstep(0.8, 0.97, length(p.xy));
  vec3 color = uTones[tone] + uRimTone * rimLit * rimLit * 0.12;
  // Packed into the orb the dust dims, so the orb stays purple; grains still falling go out.
  float gone = (1.0 - smoothstep(0.88, 1.0, uDrop)) * mix(1.0, 0.3, condensed) * (1.0 - condensed * (1.0 - landed));
  vColor = color * alpha * fade * twinkle * depthLight * inside * sqrt(spread) * (1.0 + 0.5 * aloft) * gone * uEncode;
}
`

const dustFragment = `#version 300 es
precision highp float;

in vec3 vColor;
in float vSize;

out vec4 fragColor;

void main() {
  vec2 q = (gl_PointCoord - 0.5) * (vSize + 2.0);
  float cover = clamp(max(vSize * 0.5, 0.5) - length(q) + 0.5, 0.0, 1.0);
  if (cover <= 0.0) discard;
  fragColor = vec4(vColor * cover, 0.0);
}
`

const compositeFragment = `#version 300 es
precision highp float;

uniform sampler2D tScene;
uniform float uLight;
uniform float uDecode;

in vec2 vUv;
out vec4 fragColor;

vec3 soften(vec3 x) {
  vec3 over = max(x - 0.6, 0.0);
  return min(x, 0.6) + 0.4 * (1.0 - exp(-over / 0.4));
}

void main() {
  vec4 scene = texture(tScene, vUv) * uDecode;
  vec3 light = max(scene.rgb, 0.0);
  float peak = max(light.r, max(light.g, light.b));
  if (uLight > 0.5) {
    vec3 hue = light / max(peak, 1e-4);
    float cover = 1.0 - exp(-peak * 2.4);
    vec3 ink = hue * mix(0.92, 0.72, cover);
    float core = clamp(scene.a * 0.7, 0.0, 1.0) * cover;
    vec3 tint = mix(vec3(1.0), hue, 0.22);
    fragColor = vec4(tint * core + ink * cover * (1.0 - core), core + cover * (1.0 - core));
    return;
  }
  light += vec3(max(peak - 1.8, 0.0) * 0.25);
  vec3 shown = soften(light);
  fragColor = vec4(shown, max(shown.r, max(shown.g, shown.b)));
}
`

export interface CrystalProps {
  /** The rim's and the dust's colour, as `#rrggbb`. */
  color: string
  theme: 'dark' | 'light'
  /** The ball condenses into an orb that drops to `drop` and goes out there. */
  done: boolean
  /** Where it flows to: pixels above the container's bottom. */
  drop: number
  /** The orb has landed; without WebGL2 or with reduced motion, as soon as `done`. */
  onLand?: () => void
  className?: string
}

/**
 * A glass ball filling with dust that streams down into it from above, on a WebGL2 canvas filling the container. It
 * renders nothing without WebGL2; with reduced motion it shows the full ball, still.
 */
export function Crystal(props: CrystalProps) {
  const container = useRef<HTMLDivElement>(null)
  const settings = useRef(props)
  settings.current = props
  const drawn = useRef(false)
  const { done } = props
  useEffect(() => {
    if (done && !drawn.current) settings.current.onLand?.()
  }, [done])

  useEffect(() => {
    const element = container.current
    if (!element) return undefined
    const renderer = new Renderer({
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
    })
    const gl = renderer.gl
    if (!renderer.isWebgl2) {
      gl.getExtension('WEBGL_lose_context')?.loseContext()
      return undefined
    }
    const canvas = gl.canvas
    canvas.style.display = 'block'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    element.appendChild(canvas)

    const halfFloat =
      !!gl.getExtension('EXT_color_buffer_float') ||
      !!gl.getExtension('EXT_color_buffer_half_float')
    const encode = halfFloat ? 1 : 0.25
    const geometry = new Triangle(gl)
    const strands = buildStrands()
    const sceneTarget = new RenderTarget(gl, {
      width: 1,
      height: 1,
      depth: false,
      type: halfFloat ? WebGL2RenderingContext.HALF_FLOAT : gl.UNSIGNED_BYTE,
      format: gl.RGBA,
      internalFormat: halfFloat ? WebGL2RenderingContext.RGBA16F : gl.RGBA,
      minFilter: gl.NEAREST,
      magFilter: gl.NEAREST,
    })

    const arcData = Array.from({ length: MAX_ARCS * 4 }, () => 0)
    const fieldUniforms = {
      uCenter: { value: [0, 0] },
      uRadius: { value: 1 },
      uDpr: { value: 1 },
      uLine: { value: 0.6 },
      uTime: { value: 0 },
      uFrame: { value: 0 },
      uBins: { value: 420 },
      uStrands: { value: look.strands },
      uCrackle: { value: look.crackle },
      uFlares: { value: look.flares },
      uGlow: { value: look.glow },
      uHaze: { value: look.haze },
      uFill: { value: look.fill },
      uPresence: { value: 0 },
      uUnfold: { value: 0 },
      uBloom: { value: 0 },
      uInside: { value: 0 },
      uCore: { value: 0 },
      uEncode: { value: encode },
      uRim: { value: [1, 1, 1] },
      uRimHot: { value: [1, 1, 1] },
      uRimMid: { value: [1, 1, 1] },
      uRimDeep: { value: [1, 1, 1] },
      uSpark: { value: [1, 1, 1] },
      uSparkGlow: { value: [1, 1, 1] },
      uHazeColor: { value: [0, 0, 0] },
      uEdgeColor: { value: [0, 0, 0] },
      uHarmonics: { value: strands.harmonics },
      uRates: { value: strands.rates },
      uPhases: { value: strands.phases },
      uFlareHarmonics: { value: strands.flareHarmonics },
      uFlareRates: { value: strands.flareRates },
      uFlarePhases: { value: strands.flarePhases },
      uArcs: { value: arcData },
    }

    const data = buildDust(PARTICLES)
    const texture = (image: Float32Array) =>
      new Texture(gl, {
        image,
        width: STATE_WIDTH,
        height: data.rows,
        type: gl.FLOAT,
        format: gl.RGBA,
        internalFormat: WebGL2RenderingContext.RGBA32F,
        minFilter: gl.NEAREST,
        magFilter: gl.NEAREST,
        generateMipmaps: false,
        flipY: false,
      })
    const home = texture(data.home)
    const seed = texture(data.seed)
    const dustUniforms = {
      uDustTime: { value: 0 },
      uTurn: { value: [0, 0] },
      uFill: fieldUniforms.uFill,
      tHome: { value: home },
      tSeed: { value: seed },
      uOrigin: { value: [0, 0] },
      uTarget: { value: [0, 0] },
      uViewport: { value: [1, 1] },
      uSize: { value: 1 },
      uDpr: fieldUniforms.uDpr,
      uDepth: { value: look.depth },
      uTwinkle: { value: look.twinkle },
      uPointScale: { value: 1 },
      uEncode: { value: encode },
      uClock: { value: 0 },
      uSky: { value: 2 },
      uSpread: { value: 2 },
      uDrop: { value: 0 },
      uTones: { value: Array.from({ length: 15 }, () => 1) },
      uRimTone: { value: [1, 1, 1] },
    }
    const compositeUniforms = {
      tScene: { value: sceneTarget.texture },
      uLight: { value: 0 },
      uDecode: { value: 1 / encode },
    }

    const additive = (program: Program) => {
      program.setBlendFunc(gl.ONE, gl.ONE)
      return program
    }
    const pass = { transparent: true, depthTest: false, depthWrite: false }
    const fieldMesh = new Mesh(gl, {
      geometry,
      program: additive(
        new Program(gl, {
          vertex: passVertex,
          fragment: fieldFragment,
          uniforms: fieldUniforms,
          ...pass,
        }),
      ),
    })
    const indices = new Float32Array(data.count)
    for (let i = 0; i < data.count; i++) indices[i] = i
    const dustMesh = new Mesh(gl, {
      mode: gl.POINTS,
      geometry: new Geometry(gl, { aIndex: { size: 1, data: indices } }),
      program: additive(
        new Program(gl, {
          vertex: dustVertex,
          fragment: dustFragment,
          uniforms: dustUniforms,
          ...pass,
        }),
      ),
    })
    const compositeMesh = new Mesh(gl, {
      geometry,
      program: new Program(gl, {
        vertex: passVertex,
        fragment: compositeFragment,
        uniforms: compositeUniforms,
        depthTest: false,
        depthWrite: false,
      }),
    })

    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
    const random = seeded(913)
    const palettes = new Map<string, Palette>()
    let width = 1
    let height = 1
    let raf = 0
    let last = performance.now()
    let rimTime = 0
    let dustTime = 0
    /** Seconds since the dust started to fall; with reduced motion, long enough for all of it to have landed. */
    let clock = reducedMotion ? FILL * 8 : 0
    // Still, the ball never drops: `done` lands it at once.
    drawn.current = !reducedMotion
    let introClock = reducedMotion ? 1 : 0
    let drop = 0
    let landed = false
    let visible = true
    let nextArc = 0.3
    const arcs: Arc[] = []

    const resize = () => {
      width = Math.max(1, element.clientWidth)
      height = Math.max(1, element.clientHeight)
      renderer.dpr = Math.min(devicePixelRatio || 1, 2, Math.sqrt(PIXEL_BUDGET / (width * height)))
      renderer.setSize(width, height)
      sceneTarget.setSize(gl.canvas.width, gl.canvas.height)
      start()
    }

    const spawnArc = (angle: number, strength: number) => {
      if (arcs.length >= MAX_ARCS) return
      arcs.push({
        start: angle,
        span: (0.05 + random() * 0.07) * (random() < 0.5 ? -1 : 1),
        curl: 0.02 + random() * 0.04,
        life: 0,
        duration: 0.2 + random() * 0.2,
        drift: (random() - 0.5) * 0.3,
        strength,
      })
    }

    const frame = (now: number) => {
      raf = 0
      const s = settings.current
      const dt = Math.min(0.05, Math.max(1 / 240, (now - last) / 1000))
      last = now

      if (s.done) drop = Math.min(1, drop + dt / DROP)
      if (drop >= 0.92 && !landed) {
        landed = true
        s.onLand?.()
      }
      const condensed = smooth(0, CONDENSE, drop)
      const falling = clamp((drop - CONDENSE) / (1 - CONDENSE), 0, 1) ** 2

      if (!reducedMotion) {
        introClock = Math.min(1, introClock + dt / INTRO)
        clock += dt
        const step = dt * 2 * (1 + condensed)
        rimTime += step
        dustTime += dt * look.dustSpeed
        if (introClock > 0.55 && !s.done) {
          nextArc -= step * look.sparks * 2 * (0.6 + look.crackle * 0.6)
          if (nextArc <= 0) {
            const angle =
              random() < 0.7 ? Math.PI / 2 + (random() - 0.5) * 1.5 : random() * Math.PI * 2
            spawnArc(angle, 0.8)
            nextArc = 0.15 + random() * 0.6
          }
        }
        for (let i = arcs.length - 1; i >= 0; i--) {
          const arc = arcs[i]
          arc.life += step
          arc.start += arc.drift * step
          if (arc.life >= arc.duration) arcs.splice(i, 1)
        }
      }
      for (let i = 0; i < MAX_ARCS; i++) {
        const arc = arcs[i] as Arc | undefined
        arcData[i * 4] = arc ? arc.start : 0
        arcData[i * 4 + 1] = arc ? arc.span : 0
        arcData[i * 4 + 2] = arc ? arc.curl : 0
        arcData[i * 4 + 3] = arc ? Math.sin((Math.PI * arc.life) / arc.duration) * arc.strength : 0
      }

      const fade = (1 - 0.85 * condensed) * (1 - smooth(0.88, 1, drop))
      const presence = easeOut(smooth(0, 0.42, introClock)) * fade
      const unfold = easeOut(smooth(0, 0.32, introClock))
      const charge = Math.sin(Math.PI * smooth(0.22, 0.78, introClock)) * 0.35
      const light = s.theme === 'light'
      const key = `${s.color}:${s.theme}`
      let palette = palettes.get(key)
      if (!palette) {
        palette = buildPalette(hexToRgb(s.color), light)
        palettes.set(key, palette)
      }
      const size = clamp(Math.min(width, height) * ballSize.fraction, ballSize.min, ballSize.max)
      const origin = height * (1 - ballSize.top)
      const radius = size * (1 - (1 - ORB) * condensed)

      fieldUniforms.uCenter.value = [width / 2, origin + (s.drop - origin) * falling]
      fieldUniforms.uRadius.value = radius
      fieldUniforms.uDpr.value = renderer.dpr
      fieldUniforms.uLine.value = Math.max(0.6, radius * 0.0035)
      fieldUniforms.uTime.value = rimTime
      fieldUniforms.uFrame.value = Math.floor(rimTime * 24) % 100000
      fieldUniforms.uBins.value = clamp(Math.round((Math.PI * 2 * radius) / 2.6), 240, 900)
      fieldUniforms.uCrackle.value = look.crackle + charge
      fieldUniforms.uGlow.value = look.glow * (1 + charge) * (light ? 0.35 : 1)
      fieldUniforms.uHaze.value = look.haze * (light ? 0.6 : 1) * fade
      fieldUniforms.uPresence.value = presence
      fieldUniforms.uUnfold.value = unfold
      fieldUniforms.uBloom.value = presence * presence
      fieldUniforms.uInside.value = smooth(0.2, 0.95, introClock) * fade
      fieldUniforms.uCore.value = condensed * (1 - smooth(0.88, 1, drop))
      fieldUniforms.uRim.value = palette.rim
      fieldUniforms.uRimHot.value = palette.rimHot
      fieldUniforms.uRimMid.value = palette.rimMid
      fieldUniforms.uRimDeep.value = palette.rimDeep
      fieldUniforms.uSpark.value = palette.spark
      fieldUniforms.uSparkGlow.value = palette.sparkGlow
      fieldUniforms.uHazeColor.value = palette.haze
      fieldUniforms.uEdgeColor.value = palette.edge

      dustUniforms.uDustTime.value = dustTime
      dustUniforms.uTurn.value = [
        look.sway * 0.42 * Math.sin(dustTime * 0.23),
        look.sway * 0.12 * Math.sin(dustTime * 0.17 + 1.3),
      ]
      dustUniforms.uViewport.value = [width, height]
      dustUniforms.uOrigin.value = [width / 2, origin]
      dustUniforms.uTarget.value = [width / 2, s.drop]
      dustUniforms.uSize.value = size
      dustUniforms.uPointScale.value = Math.max(1, size / 491)
      dustUniforms.uClock.value = clock
      dustUniforms.uSky.value = (height - origin) / size
      dustUniforms.uSpread.value = Math.min(width / 2, 380) / size
      dustUniforms.uDrop.value = drop
      dustUniforms.uTones.value = palette.tones.flat()
      dustUniforms.uRimTone.value = palette.rim

      gl.clearColor(0, 0, 0, 0)
      renderer.render({ scene: fieldMesh, target: sceneTarget, clear: true })
      renderer.render({ scene: dustMesh, target: sceneTarget, clear: false })
      compositeUniforms.uLight.value = light ? 1 : 0
      renderer.render({ scene: compositeMesh, clear: true })

      if (visible && !reducedMotion && drop < 1) raf = requestAnimationFrame(frame)
    }

    const start = () => {
      if (raf || !visible) return
      last = performance.now()
      raf = requestAnimationFrame(frame)
    }
    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(element)
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting
      start()
    })
    intersectionObserver.observe(element)
    resize()

    return () => {
      visible = false
      cancelAnimationFrame(raf)
      resizeObserver.disconnect()
      intersectionObserver.disconnect()
      gl.getExtension('WEBGL_lose_context')?.loseContext()
      canvas.remove()
    }
  }, [])

  return <div aria-hidden="true" className={props.className} ref={container} />
}
