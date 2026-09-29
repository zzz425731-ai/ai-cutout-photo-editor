// core/adjust.js — colour adjustment engine: WebGL2 single pass, CPU fallback with identical math.
//
//   applyAdjust(srcCanvas, params, { out?, docSize?:[W,H] }) → canvas (same size as src)
//   adjustIsIdentity(params) → bool        (true → callers can skip the pass entirely)
//   adjustKey(params) → string             (cache key)
//   FILTERS  { id: { name, params?, matrix?, split? } }   — panels may add presets
//   ADJUST_PARAMS  [{ key, label, min, max }]              — slider metadata
//   setAdjustBackend('auto'|'gl'|'cpu'), adjustBackend() → 'gl'|'cpu'
//
// params use the doc.adjust units: each -100..100 (sharpen/vignette/fade/grain 0..100),
// filter: FILTERS key, filterStrength 0..100.

import { uidOf } from './store.js';

export const ADJUST_PARAMS = [
  { key: 'exposure', label: '曝光', min: -100, max: 100 },
  { key: 'brightness', label: '亮度', min: -100, max: 100 },
  { key: 'contrast', label: '对比度', min: -100, max: 100 },
  { key: 'highlights', label: '高光', min: -100, max: 100 },
  { key: 'shadows', label: '阴影', min: -100, max: 100 },
  { key: 'saturation', label: '饱和度', min: -100, max: 100 },
  { key: 'vibrance', label: '自然饱和度', min: -100, max: 100 },
  { key: 'temperature', label: '色温', min: -100, max: 100 },
  { key: 'tint', label: '色调', min: -100, max: 100 },
  { key: 'sharpen', label: '锐化', min: 0, max: 100 },
  { key: 'vignette', label: '暗角', min: 0, max: 100 },
  { key: 'fade', label: '褪色', min: 0, max: 100 },
  { key: 'grain', label: '颗粒', min: 0, max: 100 },
];
const KEYS = ADJUST_PARAMS.map((p) => p.key);

/** Named filter presets. params are added (× strength) to the user's sliders. */
export const FILTERS = {
  none: { name: '原图' },
  fresh: { name: '清新', params: { brightness: 10, contrast: -8, vibrance: 22, temperature: -10, tint: -4, highlights: -12, shadows: 14 },
    split: { shadows: [-0.01, 0.01, 0.025], highlights: [0, 0.005, 0.01] } },
  warm: { name: '暖阳', params: { temperature: 32, tint: 4, vibrance: 12, contrast: 6, highlights: -8, shadows: 6 },
    split: { shadows: [0.01, 0, -0.02], highlights: [0.04, 0.02, -0.03] } },
  cool: { name: '冷调', params: { temperature: -32, tint: -2, contrast: 8, saturation: -6, highlights: -6 },
    split: { shadows: [-0.02, 0, 0.05], highlights: [-0.01, 0.01, 0.02] } },
  bw: { name: '黑白', params: { saturation: -100, contrast: 18, shadows: 6 },
    matrix: [[0.36, 0.52, 0.12, 0], [0.36, 0.52, 0.12, 0], [0.36, 0.52, 0.12, 0]] },
  vintage: { name: '复古', params: { fade: 32, contrast: -8, saturation: -28, temperature: 18, vignette: 28 },
    split: { shadows: [0.03, 0.01, -0.02], highlights: [0.04, 0.03, -0.03] } },
  film: { name: '胶片', params: { contrast: 12, fade: 18, saturation: -12, grain: 22, highlights: -10 },
    split: { shadows: [-0.02, 0.02, 0.035], highlights: [0.035, 0.012, -0.02] } },
  japan: { name: '日系', params: { exposure: 6, brightness: 16, contrast: -20, saturation: -16, temperature: -6, tint: -5, fade: 14, highlights: -14, shadows: 10 },
    split: { shadows: [0, 0.02, 0.03], highlights: [0.01, 0.01, 0.01] } },
  vivid: { name: '鲜艳', params: { vibrance: 32, saturation: 8, contrast: 14, sharpen: 18 } },
  cinematic: { name: '电影', params: { contrast: 16, saturation: -12, highlights: -16, shadows: 8, vignette: 30 },
    split: { shadows: [-0.04, 0.02, 0.05], highlights: [0.05, 0.02, -0.04] } },
  // added by the 调色 panel (data only): soft bright skin for people photos, warm and juicy for food
  portrait: { name: '人像', params: { exposure: 6, brightness: 12, contrast: -8, highlights: -14, shadows: 12, saturation: -8, vibrance: 12, temperature: 5, tint: 4 },
    split: { shadows: [0.005, 0, 0.012], highlights: [0.025, 0.012, 0.008] } },
  food: { name: '美食', params: { brightness: 6, contrast: 10, vibrance: 28, saturation: 6, temperature: 14, highlights: -10, shadows: 10, sharpen: 14 },
    split: { shadows: [0.015, 0.005, -0.01], highlights: [0.02, 0.01, -0.01] } },
};

const IDENT = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];

/** Combines user params + filter preset (× strength) into normalised engine values. */
export function effectiveParams(p = {}) {
  const f = FILTERS[p.filter] || FILTERS.none;
  const k = Math.max(0, Math.min(1, (p.filterStrength ?? 100) / 100));
  const e = {};
  for (const key of KEYS) {
    const v = (Number(p[key]) || 0) + (f.params?.[key] || 0) * k;
    e[key] = Math.max(-1.5, Math.min(1.5, v / 100));
  }
  const m = f.matrix || IDENT;
  e.matrix = IDENT.map((row, i) => row.map((v, j) => v + (m[i][j] - v) * k));
  const sp = f.split || { shadows: [0, 0, 0], highlights: [0, 0, 0] };
  e.splitS = sp.shadows.map((v) => v * k);
  e.splitH = sp.highlights.map((v) => v * k);
  return e;
}

export function adjustIsIdentity(p) {
  if (!p) return true;
  for (const key of KEYS) if (Number(p[key]) || 0) return false;
  const f = FILTERS[p.filter];
  if (f && p.filter !== 'none' && (p.filterStrength ?? 100) > 0 && (f.params || f.matrix || f.split)) return false;
  return true;
}

export function adjustKey(p) {
  if (adjustIsIdentity(p)) return 'id';
  return KEYS.map((k) => Number(p[k]) || 0).join(',') + '|' + (p.filter || 'none') + ':' + (p.filterStrength ?? 100);
}

// ---------------------------------------------------------------- shared per-pixel math (CPU)
const LW = [0.2126, 0.7152, 0.0722];
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function hash(x, y) {
  let h = (Math.imul(x >>> 0, 1973) + Math.imul(y >>> 0, 9277) + 26699) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h & 0xffff) / 65535;
}

function cpuAdjust(src, out, e, docW, docH) {
  const w = src.width, h = src.height;
  const sctx = src.getContext('2d', { willReadFrequently: true });
  const id = sctx.getImageData(0, 0, w, h);
  const s = id.data;
  const o = new Uint8ClampedArray(s.length);
  const expo = Math.pow(2, e.exposure * 0.9);
  const wbR = 1 + 0.14 * e.temperature + 0.04 * e.tint, wbG = 1 - 0.10 * e.tint, wbB = 1 - 0.14 * e.temperature + 0.04 * e.tint;
  const gam = Math.pow(2, -e.brightness * 0.8);
  const kc = e.contrast > 0 ? 1 + e.contrast * 0.9 : 1 + e.contrast * 0.65;
  const M = e.matrix;
  const sh = e.sharpen;
  for (let y = 0; y < h; y++) {
    const ym = Math.max(0, y - 1), yp = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let r = s[i] / 255, g = s[i + 1] / 255, b = s[i + 2] / 255;
      if (sh > 0) {
        const xm = Math.max(0, x - 1), xp = Math.min(w - 1, x + 1);
        const a1 = (y * w + xm) * 4, a2 = (y * w + xp) * 4, a3 = (ym * w + x) * 4, a4 = (yp * w + x) * 4;
        const br = (s[a1] + s[a2] + s[a3] + s[a4] + s[i]) / 1275, bg = (s[a1 + 1] + s[a2 + 1] + s[a3 + 1] + s[a4 + 1] + s[i + 1]) / 1275, bb = (s[a1 + 2] + s[a2 + 2] + s[a3 + 2] + s[a4 + 2] + s[i + 2]) / 1275;
        r += (r - br) * sh * 2.5; g += (g - bg) * sh * 2.5; b += (b - bb) * sh * 2.5;
      }
      // exposure + white balance
      r *= expo * wbR; g *= expo * wbG; b *= expo * wbB;
      // highlights / shadows
      let L = r * LW[0] + g * LW[1] + b * LW[2];
      const Lc = Math.max(0, Math.min(1, L));
      const dL = e.shadows * 1.6 * Lc * (1 - Lc) ** 3 + e.highlights * 1.6 * Lc ** 3 * (1 - Lc);
      r += dL; g += dL; b += dL;
      // brightness (gamma)
      r = Math.pow(Math.max(r, 0), gam); g = Math.pow(Math.max(g, 0), gam); b = Math.pow(Math.max(b, 0), gam);
      // contrast
      r = (r - 0.5) * kc + 0.5; g = (g - 0.5) * kc + 0.5; b = (b - 0.5) * kc + 0.5;
      // saturation + vibrance
      L = r * LW[0] + g * LW[1] + b * LW[2];
      const sat = Math.max(0, Math.min(1, Math.max(r, g, b) - Math.min(r, g, b)));
      const vib = e.vibrance > 0 ? e.vibrance * (1 - sat) * 1.3 : e.vibrance;
      const sf = Math.max(0, 1 + e.saturation + vib);
      r = L + (r - L) * sf; g = L + (g - L) * sf; b = L + (b - L) * sf;
      // colour matrix
      const r2 = M[0][0] * r + M[0][1] * g + M[0][2] * b + M[0][3];
      const g2 = M[1][0] * r + M[1][1] * g + M[1][2] * b + M[1][3];
      const b2 = M[2][0] * r + M[2][1] * g + M[2][2] * b + M[2][3];
      r = r2; g = g2; b = b2;
      // split toning
      L = Math.max(0, Math.min(1, r * LW[0] + g * LW[1] + b * LW[2]));
      const ws = (1 - L) * (1 - L), wh = L * L;
      r += e.splitS[0] * ws + e.splitH[0] * wh; g += e.splitS[1] * ws + e.splitH[1] * wh; b += e.splitS[2] * ws + e.splitH[2] * wh;
      // fade
      if (e.fade) {
        r += (r * 0.8 + 0.12 - r) * e.fade; g += (g * 0.8 + 0.12 - g) * e.fade; b += (b * 0.8 + 0.12 - b) * e.fade;
        L = r * LW[0] + g * LW[1] + b * LW[2];
        const q = e.fade * 0.25; r += (L - r) * q; g += (L - g) * q; b += (L - b) * q;
      }
      // vignette
      if (e.vignette) {
        const u = (x + 0.5) / w, v = (y + 0.5) / h;
        const dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
        const f = 1 - e.vignette * 0.85 * smooth(0.35, 1.0, Math.sqrt(dx * dx + dy * dy) / Math.SQRT2);
        r *= f; g *= f; b *= f;
      }
      // grain (doc-space noise)
      if (e.grain) {
        const n = (hash(Math.floor(((x + 0.5) / w) * docW), Math.floor(((y + 0.5) / h) * docH)) - 0.5) * e.grain * 0.22;
        r += n; g += n; b += n;
      }
      o[i] = r * 255 + 0.5; o[i + 1] = g * 255 + 0.5; o[i + 2] = b * 255 + 0.5; o[i + 3] = s[i + 3];
    }
  }
  out.getContext('2d').putImageData(new ImageData(o, w, h), 0, 0);
  return out;
}

// ---------------------------------------------------------------- WebGL2
const VS = `#version 300 es
in vec2 a_pos;
void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_tex;
uniform ivec2 u_size;
uniform vec2 u_docSize;
uniform float u_exposure, u_brightness, u_contrast, u_saturation, u_vibrance, u_temp, u_tint;
uniform float u_high, u_shadow, u_sharpen, u_vignette, u_fade, u_grain;
uniform mat3 u_mat;
uniform vec3 u_matOff, u_splitS, u_splitH;
out vec4 o;
const vec3 LW = vec3(0.2126, 0.7152, 0.0722);
vec4 tex(ivec2 p){ return texelFetch(u_tex, clamp(p, ivec2(0), u_size - 1), 0); }
float hash(uvec2 p){
  uint h = p.x * 1973u + p.y * 9277u + 26699u;
  h = (h ^ (h >> 16u)) * 0x45d9f3bu;
  h = (h ^ (h >> 16u)) * 0x45d9f3bu;
  h = h ^ (h >> 16u);
  return float(h & 0xffffu) / 65535.0;
}
void main(){
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 src = tex(p);
  vec3 c = src.rgb;
  if (u_sharpen > 0.0) {
    vec3 bl = (tex(p + ivec2(-1,0)).rgb + tex(p + ivec2(1,0)).rgb + tex(p + ivec2(0,-1)).rgb + tex(p + ivec2(0,1)).rgb + c) / 5.0;
    c += (c - bl) * u_sharpen * 2.5;
  }
  c *= exp2(u_exposure * 0.9) * vec3(1.0 + 0.14*u_temp + 0.04*u_tint, 1.0 - 0.10*u_tint, 1.0 - 0.14*u_temp + 0.04*u_tint);
  float L = dot(c, LW);
  float Lc = clamp(L, 0.0, 1.0);
  c += u_shadow * 1.6 * Lc * pow(1.0 - Lc, 3.0) + u_high * 1.6 * pow(Lc, 3.0) * (1.0 - Lc);
  c = pow(max(c, vec3(0.0)), vec3(exp2(-u_brightness * 0.8)));
  float kc = u_contrast > 0.0 ? 1.0 + u_contrast * 0.9 : 1.0 + u_contrast * 0.65;
  c = (c - 0.5) * kc + 0.5;
  L = dot(c, LW);
  float sat = clamp(max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)), 0.0, 1.0);
  float vib = u_vibrance > 0.0 ? u_vibrance * (1.0 - sat) * 1.3 : u_vibrance;
  c = vec3(L) + (c - vec3(L)) * max(0.0, 1.0 + u_saturation + vib);
  c = u_mat * c + u_matOff;
  L = clamp(dot(c, LW), 0.0, 1.0);
  c += u_splitS * (1.0 - L) * (1.0 - L) + u_splitH * L * L;
  if (u_fade != 0.0) {
    c += (c * 0.8 + 0.12 - c) * u_fade;
    L = dot(c, LW);
    c += (vec3(L) - c) * (u_fade * 0.25);
  }
  // image-space coords (texture was uploaded flipped, so row 0 is the image bottom)
  vec2 uv = vec2((float(p.x) + 0.5) / float(u_size.x), 1.0 - (float(p.y) + 0.5) / float(u_size.y));
  if (u_vignette != 0.0) {
    vec2 d = (uv - 0.5) * 2.0;
    c *= 1.0 - u_vignette * 0.85 * smoothstep(0.35, 1.0, length(d) / 1.41421356);
  }
  if (u_grain != 0.0) {
    float n = (hash(uvec2(floor(uv * u_docSize))) - 0.5) * u_grain * 0.22;
    c += n;
  }
  o = vec4(clamp(c, 0.0, 1.0), src.a);
}`;

let backendPref = 'auto';
let gl = null, glCanvas = null, prog = null, loc = null, glFailed = false;
// GPU context loss (GPU process crash/reset, e.g. under memory pressure): the context is dropped and a fresh
// one is built on the next pass (CPU fallback meanwhile). Only after MAX_GL_LOSSES losses does it stay on CPU.
const MAX_GL_LOSSES = 4;
let glLosses = 0, glRetryAt = 0;
const texCache = new Map(); // key → { tex, w, h }

export function setAdjustBackend(b) { backendPref = b; }
export function adjustBackend() { return backendPref === 'cpu' || !initGL() ? 'cpu' : 'gl'; }
/** { losses, failed, alive } — for tests/diagnostics. */
export function glState() { return { losses: glLosses, failed: glFailed, alive: !!gl && !gl.isContextLost() }; }

function dropGL() {
  texCache.clear(); // textures die with the context
  gl = null; glCanvas = null; prog = null; loc = null;
}
function onGLLost(ev) {
  if (ev.target !== glCanvas) return; // an older, already dropped context
  ev.preventDefault();
  glLosses++;
  dropGL();
  if (glLosses >= MAX_GL_LOSSES) { glFailed = true; console.warn('[adjust] WebGL keeps getting lost, using CPU from now on'); }
}

function initGL() {
  if (gl && gl.isContextLost()) { glLosses++; dropGL(); if (glLosses >= MAX_GL_LOSSES) glFailed = true; }
  if (gl) return true;
  if (glFailed) return false;
  if (glRetryAt && performance.now() < glRetryAt) return false;
  try {
    glCanvas = document.createElement('canvas');
    gl = glCanvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false, depth: false, stencil: false });
    if (!gl) throw new Error('no webgl2');
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
    loc = {};
    for (const n of ['u_tex', 'u_size', 'u_docSize', 'u_exposure', 'u_brightness', 'u_contrast', 'u_saturation', 'u_vibrance', 'u_temp', 'u_tint',
      'u_high', 'u_shadow', 'u_sharpen', 'u_vignette', 'u_fade', 'u_grain', 'u_mat', 'u_matOff', 'u_splitS', 'u_splitH']) loc[n] = gl.getUniformLocation(prog, n);
    glCanvas.addEventListener('webglcontextlost', onGLLost);
    gl.__maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    gl.__maxView = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    glRetryAt = 0;
    return true;
  } catch (err) {
    dropGL();
    if (glLosses > 0 && glLosses < MAX_GL_LOSSES) { glRetryAt = performance.now() + 1500; return false; } // GPU restarting: retry soon
    console.warn('[adjust] WebGL2 unavailable, using CPU:', err.message);
    glFailed = true;
    return false;
  }
}

/** Test hook: simulates a lost WebGL context (WEBGL_lose_context) and resolves once it was handled. */
export async function _loseGLForTest() {
  if (!initGL()) return false;
  const ext = gl.getExtension('WEBGL_lose_context');
  if (!ext) return false;
  const c = glCanvas;
  const lost = new Promise((r) => c.addEventListener('webglcontextlost', () => setTimeout(r, 0), { once: true }));
  ext.loseContext();
  await lost;
  return true;
}

function getTexture(src) {
  const key = uidOf(src) + '.' + (src.__v || 0) + '.' + src.width + 'x' + src.height;
  let t = texCache.get(key);
  if (t) { texCache.delete(key); texCache.set(key, t); return t.tex; }
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  texCache.set(key, { tex });
  while (texCache.size > 3) {
    const [k, v] = texCache.entries().next().value;
    gl.deleteTexture(v.tex); texCache.delete(k);
  }
  return tex;
}

function glAdjust(src, out, e, docW, docH) {
  const w = src.width, h = src.height;
  if (w > gl.__maxTex || h > gl.__maxTex || w > gl.__maxView[0] || h > gl.__maxView[1]) return null;
  if (glCanvas.width !== w || glCanvas.height !== h) { glCanvas.width = w; glCanvas.height = h; }
  gl.viewport(0, 0, w, h);
  gl.useProgram(prog);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, getTexture(src));
  gl.uniform1i(loc.u_tex, 0);
  gl.uniform2i(loc.u_size, w, h);
  gl.uniform2f(loc.u_docSize, docW, docH);
  gl.uniform1f(loc.u_exposure, e.exposure); gl.uniform1f(loc.u_brightness, e.brightness);
  gl.uniform1f(loc.u_contrast, e.contrast); gl.uniform1f(loc.u_saturation, e.saturation);
  gl.uniform1f(loc.u_vibrance, e.vibrance); gl.uniform1f(loc.u_temp, e.temperature);
  gl.uniform1f(loc.u_tint, e.tint); gl.uniform1f(loc.u_high, e.highlights);
  gl.uniform1f(loc.u_shadow, e.shadows); gl.uniform1f(loc.u_sharpen, e.sharpen);
  gl.uniform1f(loc.u_vignette, e.vignette); gl.uniform1f(loc.u_fade, e.fade); gl.uniform1f(loc.u_grain, e.grain);
  const M = e.matrix;
  gl.uniformMatrix3fv(loc.u_mat, false, [M[0][0], M[1][0], M[2][0], M[0][1], M[1][1], M[2][1], M[0][2], M[1][2], M[2][2]]);
  gl.uniform3f(loc.u_matOff, M[0][3], M[1][3], M[2][3]);
  gl.uniform3f(loc.u_splitS, ...e.splitS);
  gl.uniform3f(loc.u_splitH, ...e.splitH);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  if (gl.isContextLost()) return null;
  const octx = out.getContext('2d');
  octx.globalCompositeOperation = 'copy';
  octx.drawImage(glCanvas, 0, 0);
  octx.globalCompositeOperation = 'source-over';
  return out;
}

/**
 * Applies params to src (any canvas) and returns a canvas of the same size.
 * opts.out: canvas to write into (resized if needed). opts.docSize: [W,H] for doc-space grain.
 */
export function applyAdjust(src, params, opts = {}) {
  const w = src.width, h = src.height;
  let out = opts.out;
  if (!out) { out = document.createElement('canvas'); }
  if (out.width !== w || out.height !== h) { out.width = w; out.height = h; }
  if (adjustIsIdentity(params)) {
    const ctx = out.getContext('2d');
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(src, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    return out;
  }
  const e = effectiveParams(params);
  const [dw, dh] = opts.docSize || [w, h];
  if (backendPref !== 'cpu' && initGL()) {
    try {
      const r = glAdjust(src, out, e, dw, dh);
      if (r) return r;
    } catch (err) {
      console.warn('[adjust] GL pass failed, falling back to CPU:', err.message);
    }
  }
  return cpuAdjust(src, out, e, dw, dh);
}
