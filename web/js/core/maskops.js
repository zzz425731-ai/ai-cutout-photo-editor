// core/maskops.js — CPU operations on 8-bit single-channel masks (Uint8Array, row-major w×h).
//   morph(src, w, h, r)            r>0 dilate / r<0 erode with an octagonal (≈disc) structuring element
//   blurMask(src, w, h, sigma)     gaussian (3 box passes), clamp-to-edge (image borders never fade)
//   edgeMask(src, w, h, shift, feather) → shift then feather (feather px ≈ 2σ)
//   distanceOutside(bin, w, h)     squared Euclidean distance to the nearest "inside" pixel (Float32Array)
//   subRect(...) / putRect(...)    helpers for partial updates

/** 1D running min/max (van Herk / Gil-Werman) on a strided line, radius r, neutral padding. */
function lineMorph(src, dst, start, stride, len, r, isMax, pad, g, hh) {
  const k = 2 * r + 1;
  const n = len + 2 * r;
  const neutral = isMax ? 0 : 255;
  for (let i = 0; i < n; i++) {
    const j = i - r;
    pad[i] = j >= 0 && j < len ? src[start + j * stride] : neutral;
  }
  if (isMax) {
    for (let i = 0; i < n; i++) g[i] = i % k === 0 ? pad[i] : (pad[i] > g[i - 1] ? pad[i] : g[i - 1]);
    for (let i = n - 1; i >= 0; i--) hh[i] = (i === n - 1 || (i + 1) % k === 0) ? pad[i] : (pad[i] > hh[i + 1] ? pad[i] : hh[i + 1]);
    for (let j = 0; j < len; j++) { const a = hh[j], b = g[j + 2 * r]; dst[start + j * stride] = a > b ? a : b; }
  } else {
    for (let i = 0; i < n; i++) g[i] = i % k === 0 ? pad[i] : (pad[i] < g[i - 1] ? pad[i] : g[i - 1]);
    for (let i = n - 1; i >= 0; i--) hh[i] = (i === n - 1 || (i + 1) % k === 0) ? pad[i] : (pad[i] < hh[i + 1] ? pad[i] : hh[i + 1]);
    for (let j = 0; j < len; j++) { const a = hh[j], b = g[j + 2 * r]; dst[start + j * stride] = a < b ? a : b; }
  }
}

function passH(src, dst, w, h, r, isMax, bufs) {
  for (let y = 0; y < h; y++) lineMorph(src, dst, y * w, 1, w, r, isMax, bufs.pad, bufs.g, bufs.h);
}
function passV(src, dst, w, h, r, isMax, bufs) {
  for (let x = 0; x < w; x++) lineMorph(src, dst, x, w, h, r, isMax, bufs.pad, bufs.g, bufs.h);
}
function passDiag(src, dst, w, h, r, isMax, bufs) { // direction (1,1)
  for (let x0 = 0; x0 < w; x0++) lineMorph(src, dst, x0, w + 1, Math.min(w - x0, h), r, isMax, bufs.pad, bufs.g, bufs.h);
  for (let y0 = 1; y0 < h; y0++) lineMorph(src, dst, y0 * w, w + 1, Math.min(w, h - y0), r, isMax, bufs.pad, bufs.g, bufs.h);
}
function passAnti(src, dst, w, h, r, isMax, bufs) { // direction (-1,1)
  for (let x0 = 0; x0 < w; x0++) lineMorph(src, dst, x0, w - 1, Math.min(x0 + 1, h), r, isMax, bufs.pad, bufs.g, bufs.h);
  for (let y0 = 1; y0 < h; y0++) lineMorph(src, dst, y0 * w + (w - 1), w - 1, Math.min(w, h - y0), r, isMax, bufs.pad, bufs.g, bufs.h);
}

/** Dilate (r>0) or erode (r<0) by |r| px with an octagon ≈ disc. Returns a new array. */
export function morph(src, w, h, r) {
  // Interpolate adjacent integer-radius results. Rounding even a tiny shrink
  // up to a whole pixel used to erase one-pixel hairs outright.
  const radius = Math.abs(r), low = Math.floor(radius), mix = radius - low;
  if (mix > 1e-6) {
    const sign = Math.sign(r);
    const a = low ? morph(src, w, h, sign * low) : src;
    const b = morph(src, w, h, sign * (low + 1));
    for (let i = 0; i < b.length; i++) b[i] = Math.round(a[i] + (b[i] - a[i]) * mix);
    return b;
  }
  r = Math.sign(r) * low;
  if (!r) return src.slice();
  const isMax = r > 0;
  const R = Math.abs(r);
  const L = Math.max(w, h) + 2 * R + 2;
  const bufs = { pad: new Uint8Array(L), g: new Uint8Array(L), h: new Uint8Array(L) };
  let a, t;
  if (R < 3) { a = R; t = 0; } else { t = Math.floor((R - Math.round(R * 0.414)) / 2); a = R - 2 * t; }
  let cur = src.slice();
  let tmp = new Uint8Array(src.length);
  if (a > 0) {
    passH(cur, tmp, w, h, a, isMax, bufs); [cur, tmp] = [tmp, cur];
    passV(cur, tmp, w, h, a, isMax, bufs); [cur, tmp] = [tmp, cur];
  }
  if (t > 0) {
    passDiag(cur, tmp, w, h, t, isMax, bufs); [cur, tmp] = [tmp, cur];
    passAnti(cur, tmp, w, h, t, isMax, bufs); [cur, tmp] = [tmp, cur];
  }
  return cur;
}

function boxSizes(sigma, n) {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const sizes = [];
  for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes.map((s) => (s - 1) / 2);
}

function boxH(src, dst, w, h, r) {
  const iarr = 1 / (r + r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const fv = src[row], lv = src[row + w - 1];
    let val = (r + 1) * fv;
    for (let j = 0; j < r; j++) val += src[row + Math.min(j, w - 1)];
    for (let x = 0; x < w; x++) {
      val += src[row + Math.min(x + r, w - 1)] - (x - r - 1 >= 0 ? src[row + x - r - 1] : fv);
      dst[row + x] = val * iarr;
    }
    void lv;
  }
}
function boxV(src, dst, w, h, r) {
  const iarr = 1 / (r + r + 1);
  for (let x = 0; x < w; x++) {
    const fv = src[x];
    let val = (r + 1) * fv;
    for (let j = 0; j < r; j++) val += src[Math.min(j, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      val += src[Math.min(y + r, h - 1) * w + x] - (y - r - 1 >= 0 ? src[(y - r - 1) * w + x] : fv);
      dst[y * w + x] = val * iarr;
    }
  }
}

/** Gaussian blur (σ px) of an 8-bit mask, clamp-to-edge. Returns a new Uint8Array. */
export function blurMask(src, w, h, sigma) {
  if (!(sigma > 0.25)) return src.slice();
  const a = Float32Array.from(src);
  const b = new Float32Array(src.length);
  for (const r0 of boxSizes(sigma, 3)) {
    const r = Math.max(0, Math.round(r0));
    if (!r) continue;
    boxH(a, b, w, h, r);
    boxV(b, a, w, h, r);
  }
  const out = new Uint8Array(src.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + 0.5;
  return out;
}

/** shift (px, +expand / −shrink) then feather (px; σ = feather/2). */
export function edgeMask(src, w, h, shift = 0, feather = 0) {
  let m = shift ? morph(src, w, h, shift) : src;
  if (feather > 0) m = blurMask(m, w, h, feather / 2);
  return m === src ? src.slice() : m;
}

/** Margin (px) that a partial edgeMask update needs around a dirty rect. */
export function edgeMargin(shift, feather) {
  return Math.ceil(Math.abs(shift) + (feather > 0 ? feather * 1.6 : 0) + 3);
}

// ---------------------------------------------------------------- Euclidean distance transform
const INF = 1e20;
function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/** bin: Uint8Array (nonzero = inside). Returns Float32Array of squared distance to the nearest inside pixel. */
export function distanceOutside(bin, w, h) {
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), z = new Float64Array(n + 1);
  const v = new Int32Array(n);
  const grid = new Float32Array(w * h);
  for (let i = 0; i < grid.length; i++) grid[i] = bin[i] ? 0 : INF;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = grid[row + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) grid[row + x] = d[x];
  }
  return grid;
}

// ---------------------------------------------------------------- rect helpers
export function clampRect(r, w, h) {
  const x = Math.max(0, Math.floor(r.x)), y = Math.max(0, Math.floor(r.y));
  const x2 = Math.min(w, Math.ceil(r.x + r.w)), y2 = Math.min(h, Math.ceil(r.y + r.h));
  return { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
}
export function expandRect(r, m) { return { x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m }; }

export function subRect(src, w, r) {
  const out = new Uint8Array(r.w * r.h);
  for (let y = 0; y < r.h; y++) out.set(src.subarray((r.y + y) * w + r.x, (r.y + y) * w + r.x + r.w), y * r.w);
  return out;
}
/** Copies region `inner` (absolute coords) from a sub-array covering `outer` into dst (full w). */
export function putRect(dst, w, sub, outer, inner) {
  for (let y = inner.y; y < inner.y + inner.h; y++) {
    const so = (y - outer.y) * outer.w + (inner.x - outer.x);
    dst.set(sub.subarray(so, so + inner.w), y * w + inner.x);
  }
}

/** Writes alpha values into a canvas (RGB = color, default black) — whole canvas or a rect. */
export function alphaToCanvas(alpha, w, h, canvas, rect = null, rgb = [0, 0, 0]) {
  const r = rect || { x: 0, y: 0, w, h };
  if (r.w <= 0 || r.h <= 0) return canvas;
  const ctx = canvas.getContext('2d');
  const id = ctx.createImageData(r.w, r.h);
  const d = id.data;
  const [cr, cg, cb] = rgb;
  let j = 0;
  for (let y = r.y; y < r.y + r.h; y++) {
    let i = y * w + r.x;
    for (let x = 0; x < r.w; x++, i++, j += 4) { d[j] = cr; d[j + 1] = cg; d[j + 2] = cb; d[j + 3] = alpha[i]; }
  }
  ctx.putImageData(id, r.x, r.y);
  return canvas;
}

/** Reads the alpha channel of canvas (rect) into dst (full w) or a new array. */
export function canvasAlpha(canvas, rect = null, dst = null) {
  const w = canvas.width, h = canvas.height;
  const r = rect || { x: 0, y: 0, w, h };
  const out = dst || new Uint8Array(w * h);
  if (r.w <= 0 || r.h <= 0) return out;
  const d = canvas.getContext('2d').getImageData(r.x, r.y, r.w, r.h).data;
  let j = 3;
  for (let y = r.y; y < r.y + r.h; y++) {
    let i = y * w + r.x;
    for (let x = 0; x < r.w; x++, i++, j += 4) out[i] = d[j];
  }
  return out;
}
