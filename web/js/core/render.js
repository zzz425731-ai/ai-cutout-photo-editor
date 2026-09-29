// core/render.js — renders a document to a canvas at any scale (preview ≤1, export =1).
//
//   renderDoc(doc, { scale=1, showOriginal=false, target?, noLayers=false, maskView=false, inspection=null }) → canvas
//     maskView: photo + translucent red over the removed area (used while brushing the mask)
//     inspection: preview-only 'black'|'white'|'green' backgrounds or 'alpha' grayscale mask;
//       hides layers/effects without changing the document or normal export.
//   effectiveMask(doc, scale) → { arr: Uint8Array, canvas, w, h }   (mask after 收缩/扩展 + 羽化)
//   clearRenderCache()
//   prewarm(doc, scale) → Promise<bool>   computes the slow full-resolution mask stages (收缩/扩展, 羽化,
//     描边 distance field) in a worker and stores them in the cache, so a following renderDoc at that scale
//     is fast. Used by the viewport's full-quality refine and by exportDoc. Never required for correctness.
//
// All intermediates are cached by (plane id, plane version, params, output size). Masks are
// updated partially using the dirty rects recorded by store.bump()/commitRegion(), so brushing on
// a 12 MP photo only recomputes the touched area.

import { uidOf, dirtySince, bumpCanvas, unionRect } from './store.js';
import { applyAdjust, adjustIsIdentity, adjustKey } from './adjust.js';
import { edgeMask, edgeMargin, blurMask, distanceOutside, alphaToCanvas, canvasAlpha, clampRect, expandRect, subRect, putRect } from './maskops.js';
import { createCanvas, resizeCanvas } from './io.js';
import { drawLayers } from '../layers/render-layers.js';

// ---------------------------------------------------------------- LRU cache
const cache = new Map();
let cacheBytes = 0;
const MAX_CACHE_BYTES = 600 * 1024 * 1024; // keeps the tab light on PCs with little free RAM

function cget(key) {
  const e = cache.get(key);
  if (e) { cache.delete(key); cache.set(key, e); }
  return e;
}
function cset(key, e, bytes) {
  const old = cache.get(key);
  if (old) { cacheBytes -= old.bytes || 0; cache.delete(key); }
  e.bytes = bytes;
  cache.set(key, e);
  cacheBytes += bytes;
  while (cacheBytes > MAX_CACHE_BYTES && cache.size > 1) {
    const [k, v] = cache.entries().next().value;
    if (k === key) break;
    cache.delete(k); cacheBytes -= v.bytes || 0;
  }
  return e;
}
export function clearRenderCache() { cache.clear(); cacheBytes = 0; }
export function renderCacheInfo() { return { entries: cache.size, bytes: cacheBytes }; }

const ver = (c) => c.__v || 0;

// ---------------------------------------------------------------- RGB planes
/** Plane scaled to w×h (the plane itself when w×h is its size). Partially updated on bump(rect). */
function scaledPlane(c, w, h) {
  if (c.width === w && c.height === h) return c;
  const key = `sp${uidOf(c)}@${w}x${h}`;
  let e = cget(key);
  const v = ver(c);
  if (e && e.v === v) return e.canvas;
  const d = e ? dirtySince(c, e.v) : null;
  if (e && d && d !== 'clean') {
    const kx = w / c.width, ky = h / c.height;
    const r = clampRect({ x: Math.floor(d.x * kx) - 1, y: Math.floor(d.y * ky) - 1, w: Math.ceil(d.w * kx) + 3, h: Math.ceil(d.h * ky) + 3 }, w, h);
    if (r.w > 0 && r.h > 0) {
      const ctx = e.canvas.getContext('2d');
      ctx.save();
      ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
      ctx.clearRect(r.x, r.y, r.w, r.h);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      const sx = r.x / kx, sy = r.y / ky;
      ctx.drawImage(c, sx, sy, r.w / kx, r.h / ky, r.x, r.y, r.w, r.h);
      ctx.restore();
    }
  } else if (!e || d !== 'clean') {
    const canvas = resizeCanvas(c, w, h, { willRead: false });
    if (e) { const ctx = e.canvas.getContext('2d'); ctx.globalCompositeOperation = 'copy'; ctx.drawImage(canvas, 0, 0); ctx.globalCompositeOperation = 'source-over'; }
    else e = cset(key, { canvas }, w * h * 4);
  }
  e.v = v;
  e.canvas.__v = (e.canvas.__v || 0) + 1; // lets the GL texture cache notice the change
  return e.canvas;
}

/** Adjusted (colour-graded) plane at w×h. */
function adjustedPlane(c, params, w, h, doc) {
  const sp = scaledPlane(c, w, h);
  if (adjustIsIdentity(params)) return sp;
  const key = `adj${uidOf(c)}@${w}x${h}`;
  const k = adjustKey(params);
  let e = cget(key);
  const v = ver(c) + ':' + ver(sp);
  if (e && e.v === v && e.k === k) return e.canvas;
  if (!e) e = cset(key, { canvas: createCanvas(w, h) }, w * h * 4);
  applyAdjust(sp, params, { out: e.canvas, docSize: [doc.width, doc.height] });
  e.v = v; e.k = k;
  e.canvas.__v = (e.canvas.__v || 0) + 1;
  return e.canvas;
}

/** Read source colours once; brushes update only their dirty rectangle in this CPU cache. */
function rgbFull(c) {
  const key = `rgb${uidOf(c)}`;
  const w = c.width, h = c.height, v = ver(c);
  let e = cget(key);
  if (e && e.v === v) return e.arr;
  const d = e ? dirtySince(c, e.v) : null;
  const ctx = c.getContext('2d');
  if (e && d && d !== 'clean') {
    const r = clampRect(d, w, h);
    if (r.w && r.h) {
      const patch = ctx.getImageData(r.x, r.y, r.w, r.h).data;
      for (let y = 0; y < r.h; y++) e.arr.set(patch.subarray(y * r.w * 4, (y + 1) * r.w * 4), ((r.y + y) * w + r.x) * 4);
    }
  } else if (!e || d !== 'clean') {
    const arr = ctx.getImageData(0, 0, w, h).data;
    if (e) e.arr = arr; else e = cset(key, { arr }, arr.byteLength);
  }
  e.v = v;
  return e.arr;
}

/**
 * Area-weighted unpremultiplied subject colours. Weight RGB by the original mask BEFORE reducing
 * it: independently resizing the opaque photo mixes discarded white/coloured background into hairs.
 * out initially contains the ordinary scaled photo, so pixels with no retained subject still have
 * their original colour when the user expands the edge or paints a removed area back in.
 */
function downscaleSubjectRegion(src, mask, W, H, out, w, h, r) {
  const kx = W / w, ky = H / h, columns = [];
  for (let x = r.x; x < r.x + r.w; x++) {
    const left = x * kx, right = Math.min(W, (x + 1) * kx);
    columns.push({ left, right, x0: Math.floor(left), x1: Math.ceil(right) });
  }
  for (let y = r.y; y < r.y + r.h; y++) {
    const top = y * ky, bottom = Math.min(H, (y + 1) * ky);
    for (let x = r.x; x < r.x + r.w; x++) {
      const { left, right, x0, x1 } = columns[x - r.x];
      let alpha = 0, red = 0, green = 0, blue = 0;
      for (let yy = Math.floor(top); yy < Math.ceil(bottom); yy++) {
        const row = yy * W, wy = Math.min(bottom, yy + 1) - Math.max(top, yy);
        for (let xx = x0; xx < x1; xx++) {
          const i = row + xx, p = i * 4;
          if (!mask[i] || !src[p + 3]) continue;
          const a = mask[i] * src[p + 3] * wy * (Math.min(right, xx + 1) - Math.max(left, xx));
          alpha += a; red += src[p] * a; green += src[p + 1] * a; blue += src[p + 2] * a;
        }
      }
      if (alpha > 0) {
        const p = ((y - r.y) * r.w + x - r.x) * 4;
        out[p] = Math.round(red / alpha);
        out[p + 1] = Math.round(green / alpha);
        out[p + 2] = Math.round(blue / alpha);
      }
    }
  }
}

function subjectPlane(c, mask, w, h) {
  if (c.width === w && c.height === h) return c; // full-resolution RGB stays lossless
  const key = `subrgb${uidOf(c)}:${uidOf(mask)}@${w}x${h}`;
  const cv = ver(c), mv = ver(mask);
  let e = cget(key);
  if (e && e.cv === cv && e.mv === mv) return e.canvas;
  let r = { x: 0, y: 0, w, h };
  if (e) {
    const cd = dirtySince(c, e.cv), md = dirtySince(mask, e.mv);
    if (cd && md) {
      const d = cd === 'clean' ? md : md === 'clean' ? cd : unionRect(cd, md);
      if (d !== 'clean') r = mapDirty(d, c, w, h, 0);
    }
  } else e = cset(key, { canvas: createCanvas(w, h) }, w * h * 4);
  if (r.w && r.h) {
    const original = scaledPlane(c, w, h).getContext('2d').getImageData(r.x, r.y, r.w, r.h);
    downscaleSubjectRegion(rgbFull(c), maskFull(mask).arr, c.width, c.height, original.data, w, h, r);
    e.canvas.getContext('2d').putImageData(original, r.x, r.y);
    bumpCanvas(e.canvas, r);
  }
  e.cv = cv; e.mv = mv;
  return e.canvas;
}

// ---------------------------------------------------------------- masks
function maskFull(mask) {
  const key = `mf${uidOf(mask)}`;
  const W = mask.width, H = mask.height;
  let e = cget(key);
  const v = ver(mask);
  if (e && e.v === v) return e;
  const d = e ? dirtySince(mask, e.v) : null;
  if (e && d && d !== 'clean') {
    const r = clampRect(d, W, H);
    canvasAlpha(mask, r, e.arr);
  } else if (!e || d !== 'clean') {
    const arr = canvasAlpha(mask);
    if (e) e.arr = arr; else e = cset(key, { arr, w: W, h: H }, W * H);
  }
  e.v = v;
  return e;
}

/** Area-average downscale of a region of an alpha array. r in destination coords. */
function downscaleRegion(src, W, H, dst, w, h, r) {
  const kx = W / w, ky = H / h;
  // Fractional pixel coverage matters for hair: a 1 px line in the middle of 3 px should
  // become two equally soft pixels at 2 px, rather than jumping to one side.
  const columns = [];
  for (let x = r.x; x < r.x + r.w; x++) {
    const left = x * kx, right = Math.min(W, (x + 1) * kx);
    const x0 = Math.floor(left), x1 = Math.ceil(right);
    columns.push({ x0, x1, first: Math.min(right, x0 + 1) - left, last: right - (x1 - 1) });
  }
  const invArea = 1 / (kx * ky);
  for (let y = r.y; y < r.y + r.h; y++) {
    const top = y * ky, bottom = Math.min(H, (y + 1) * ky);
    const y0 = Math.floor(top), y1 = Math.ceil(bottom);
    for (let x = r.x; x < r.x + r.w; x++) {
      const { x0, x1, first, last } = columns[x - r.x];
      let sum = 0;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * W;
        let rowSum = src[row + x0] * first;
        if (x1 > x0 + 1) {
          for (let xx = x0 + 1; xx < x1 - 1; xx++) rowSum += src[row + xx];
          rowSum += src[row + x1 - 1] * last;
        }
        sum += rowSum * (Math.min(bottom, yy + 1) - Math.max(top, yy));
      }
      dst[y * w + x] = Math.min(255, Math.round(sum * invArea));
    }
  }
}

/** Raw mask alpha at w×h; returns { arr, v, dirty } where dirty = rect changed since `sinceV` (dest coords). */
function maskScaled(mask, w, h) {
  const full = maskFull(mask);
  if (w === mask.width && h === mask.height) return full.arr;
  const key = `ms${uidOf(mask)}@${w}x${h}`;
  let e = cget(key);
  const v = ver(mask);
  if (e && e.v === v) return e.arr;
  const d = e ? dirtySince(mask, e.v) : null;
  const W = mask.width, H = mask.height;
  if (e && d && d !== 'clean') {
    const kx = w / W, ky = h / H;
    const r = clampRect({ x: Math.floor(d.x * kx) - 1, y: Math.floor(d.y * ky) - 1, w: Math.ceil(d.w * kx) + 3, h: Math.ceil(d.h * ky) + 3 }, w, h);
    downscaleRegion(full.arr, W, H, e.arr, w, h, r);
  } else if (!e || d !== 'clean') {
    if (!e) e = cset(key, { arr: new Uint8Array(w * h) }, w * h);
    downscaleRegion(full.arr, W, H, e.arr, w, h, { x: 0, y: 0, w, h });
  }
  e.v = v;
  return e.arr;
}

function mapDirty(d, mask, w, h, margin) {
  const kx = w / mask.width, ky = h / mask.height;
  return clampRect(expandRect({ x: Math.floor(d.x * kx) - 1, y: Math.floor(d.y * ky) - 1, w: Math.ceil(d.w * kx) + 3, h: Math.ceil(d.h * ky) + 3 }, margin), w, h);
}

/**
 * Mask after edge settings, at w×h. shiftPx/featherPx are in output pixels.
 * Returns the cache entry { arr, canvas, w, h }.
 */
function edgeParams(shiftPx, featherPx) {
  const sh = Math.round(shiftPx * 1000) / 1000;
  const fe = featherPx < 0.3 ? 0 : Math.round(featherPx * 4) / 4;
  return { sh, fe, p: `${sh},${fe}` };
}

function maskAt(mask, w, h, shiftPx, featherPx, slot) {
  const { sh, fe, p } = edgeParams(shiftPx, featherPx);
  const key = `em${uidOf(mask)}@${w}x${h}:${slot}`;
  const v = ver(mask);
  let e = cget(key);
  if (e && e.v === v && e.p === p) return e;
  const Ms = maskScaled(mask, w, h);
  const d = e && e.p === p ? dirtySince(mask, e.v) : null;
  const identity = !sh && !fe;
  if (e && d && d !== 'clean') {
    const m = edgeMargin(sh, fe);
    const inner = mapDirty(d, mask, w, h, identity ? 0 : m);
    if (inner.w > 0 && inner.h > 0) {
      if (identity) {
        if (e.arr !== Ms) putRect(e.arr, w, subRect(Ms, w, inner), inner, inner);
      } else {
        const outer = clampRect(expandRect(inner, m), w, h);
        const res = edgeMask(subRect(Ms, w, outer), outer.w, outer.h, sh, fe);
        putRect(e.arr, w, res, outer, inner);
      }
      alphaToCanvas(e.arr, w, h, e.canvas, inner);
    }
  } else if (!e || e.p !== p || d !== 'clean') {
    const arr = identity ? Ms.slice() : edgeMask(Ms, w, h, sh, fe);
    if (!e) e = cset(key, { canvas: createCanvas(w, h), w, h }, w * h * 5);
    e.arr = arr;
    alphaToCanvas(arr, w, h, e.canvas);
  }
  e.v = v; e.p = p;
  return e;
}

/** Effective mask (after 收缩/扩展 + 羽化) of doc at scale. */
export function effectiveMask(doc, scale = 1) {
  if (!doc.mask) return null;
  return effectiveMaskWH(doc, Math.max(1, Math.round(doc.width * scale)), Math.max(1, Math.round(doc.height * scale)));
}
/** Same at an exact output size (renderDoc's w×h — w/W alone can round h differently by 1 px). */
function effectiveMaskWH(doc, w, h) {
  const sx = w / doc.width;
  return maskAt(doc.mask, w, h, (doc.edge?.shift || 0) * sx, (doc.edge?.feather || 0) * sx, 'fx');
}

const strokeSigma = (sx) => Math.max(0.6, 2 * sx);

function strokeCanvas(doc, em, w, h, sx) {
  const st = doc.fx.stroke;
  const key = `st${uidOf(doc.mask)}@${w}x${h}`;
  const v = ver(doc.mask) + ':' + em.p;
  let e = cget(key);
  if (!e) e = cset(key, { canvas: createCanvas(w, h) }, w * h * 8);
  if (e.v !== v) {
    const soft = blurMask(em.arr, w, h, strokeSigma(sx));
    const bin = new Uint8Array(soft.length);
    for (let i = 0; i < soft.length; i++) bin[i] = soft[i] > 110 ? 1 : 0;
    e.d2 = distanceOutside(bin, w, h);
    e.v = v; e.style = null;
  }
  const width = Math.max(0.5, st.width * sx);
  const style = width.toFixed(2) + st.color;
  if (e.style !== style) {
    const a = new Uint8Array(w * h);
    const d2 = e.d2;
    for (let i = 0; i < a.length; i++) {
      const t = width - Math.sqrt(d2[i]) + 0.5;
      a[i] = t >= 1 ? 255 : t <= 0 ? 0 : t * 255 + 0.5;
    }
    alphaToCanvas(a, w, h, e.canvas, null, hexToRgb(st.color));
    e.style = style;
  }
  return e.canvas;
}

// ---------------------------------------------------------------- async prewarm (worker)
let worker = null, workerSeq = 0;
const jobs = new Map();
function maskWorker() {
  if (worker === false) return null;
  if (!worker) {
    try {
      worker = new Worker(new URL('./mask-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        const j = jobs.get(e.data.id);
        if (!j) return;
        jobs.delete(e.data.id);
        if (e.data.error) j.reject(new Error(e.data.error)); else j.resolve(e.data.out);
      };
      worker.onerror = () => {
        for (const j of jobs.values()) j.reject(new Error('mask worker failed'));
        jobs.clear();
        try { worker.terminate(); } catch { /* ignore */ }
        worker = false; // fall back to the synchronous path for the rest of the session
      };
    } catch {
      worker = false;
      return null;
    }
  }
  return worker;
}
function workerJob(msg, transfer) {
  const w = maskWorker();
  if (!w) return Promise.reject(new Error('no worker'));
  const id = ++workerSeq;
  return new Promise((resolve, reject) => { jobs.set(id, { resolve, reject }); w.postMessage({ id, ...msg }, transfer); });
}

/**
 * Pre-computes the expensive mask stages of renderDoc(doc, { scale }) in a worker and stores them in the
 * render cache. Resolves true when something was computed; false when nothing was needed, the doc changed
 * meanwhile, or workers are unavailable (renderDoc then simply computes synchronously as before).
 */
export async function prewarm(doc, scale = 1) {
  try {
    if (!doc || !doc.cutout || !doc.mask) return false;
    const W = doc.width, H = doc.height;
    const s = Math.min(1, scale);
    const w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(H * s));
    const sx = w / W;
    const mask = doc.mask, v = ver(mask);
    const { sh, fe, p } = edgeParams((doc.edge?.shift || 0) * sx, (doc.edge?.feather || 0) * sx);
    const stale = () => doc.mask !== mask || ver(mask) !== v;
    let did = false;
    // 1) 收缩/扩展 + 羽化 (identity is a plain copy → cheap, left to the sync path)
    const key = `em${uidOf(mask)}@${w}x${h}:fx`;
    let e = cache.get(key);
    if ((sh || fe) && !(e && e.v === v && e.p === p)) {
      const d = e && e.p === p ? dirtySince(mask, e.v) : null;
      if (!(e && d && d !== 'clean')) { // a brush's partial update stays on the (fast) sync path
        const src = maskScaled(mask, w, h).slice();
        const out = await workerJob({ op: 'edge', src, w, h, sh, fe }, [src.buffer]);
        if (stale()) return false;
        e = cache.get(key);
        if (!e) e = cset(key, { canvas: createCanvas(w, h), w, h }, w * h * 5);
        e.arr = out;
        alphaToCanvas(out, w, h, e.canvas);
        e.v = v; e.p = p;
        did = true;
      }
    }
    // 2) 描边 distance field (skipped when the edge settings changed meanwhile: a new refine follows)
    const st = doc.fx?.stroke;
    if (st?.on && st.width > 0 && edgeParams((doc.edge?.shift || 0) * sx, (doc.edge?.feather || 0) * sx).p === p) {
      const em = effectiveMaskWH(doc, w, h);
      const skey = `st${uidOf(mask)}@${w}x${h}`;
      const sv = v + ':' + em.p;
      const se = cache.get(skey);
      if (!se || se.v !== sv) {
        const src = em.arr.slice();
        const out = await workerJob({ op: 'dist', src, w, h, sigma: strokeSigma(sx) }, [src.buffer]);
        if (stale()) return false;
        const cur = cache.get(skey);
        if (cur && cur.v === sv) return did; // the sync path got there first
        const e2 = cache.get(skey) || cset(skey, { canvas: createCanvas(w, h) }, w * h * 8);
        e2.d2 = out; e2.v = sv; e2.style = null;
        did = true;
      }
    }
    return did;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- backgrounds
function blurredPhoto(photo, radiusPx, key0) {
  const w = photo.width, h = photo.height;
  const key = `bl${key0}@${w}x${h}`;
  const sigma = Math.max(0.5, radiusPx);
  const k = sigma.toFixed(2) + ':' + ver(photo) + ':' + uidOf(photo);
  let e = cget(key);
  if (e && e.k === k) return e.canvas;
  if (!e) e = cset(key, { canvas: createCanvas(w, h) }, w * h * 4);
  // edge-extend by 3σ so borders don't fade to transparent
  const p = Math.ceil(sigma * 3) + 2;
  const pad = createCanvas(w + 2 * p, h + 2 * p);
  const pc = pad.getContext('2d');
  pc.drawImage(photo, p, p);
  pc.drawImage(photo, 0, 0, 1, h, 0, p, p, h);
  pc.drawImage(photo, w - 1, 0, 1, h, p + w, p, p, h);
  pc.drawImage(photo, 0, 0, w, 1, p, 0, w, p);
  pc.drawImage(photo, 0, h - 1, w, 1, p, p + h, w, p);
  pc.drawImage(photo, 0, 0, 1, 1, 0, 0, p, p);
  pc.drawImage(photo, w - 1, 0, 1, 1, p + w, 0, p, p);
  pc.drawImage(photo, 0, h - 1, 1, 1, 0, p + h, p, p);
  pc.drawImage(photo, w - 1, h - 1, 1, 1, p + w, p + h, p, p);
  const ctx = e.canvas.getContext('2d');
  ctx.save();
  ctx.clearRect(0, 0, w, h);
  ctx.filter = `blur(${sigma}px)`;
  ctx.drawImage(pad, -p, -p);
  ctx.restore();
  e.k = k;
  return e.canvas;
}

function gradientEndpoints(angleDeg, w, h) {
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(a), dy = -Math.cos(a);
  const len = Math.abs(w * dx) + Math.abs(h * dy);
  const cx = w / 2, cy = h / 2;
  return [cx - (dx * len) / 2, cy - (dy * len) / 2, cx + (dx * len) / 2, cy + (dy * len) / 2];
}

function drawBackground(ctx, doc, photo, w, h, sx) {
  const bg = doc.bg || { type: 'original' };
  switch (bg.type) {
    case 'transparent': break;
    case 'color':
      ctx.fillStyle = bg.color || '#ffffff';
      ctx.fillRect(0, 0, w, h);
      break;
    case 'gradient': {
      const g = ctx.createLinearGradient(...gradientEndpoints(bg.angle ?? 180, w, h));
      g.addColorStop(0, bg.color || '#ffffff');
      g.addColorStop(1, bg.color2 || '#4a90e2');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      break;
    }
    case 'image': {
      const img = bg.image;
      if (!img) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); break; }
      const k = Math.max(w / img.width, h / img.height);
      const dw = img.width * k, dh = img.height * k;
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
      break;
    }
    case 'blur':
      ctx.drawImage(blurredPhoto(photo, (bg.blur ?? 24) * sx * 0.5, uidOf(doc.source)), 0, 0);
      break;
    case 'original':
    default:
      ctx.drawImage(photo, 0, 0);
  }
}

// ---------------------------------------------------------------- scratch canvases
const scratch = new Map();
function scratchCanvas(name, w, h) {
  let c = scratch.get(name);
  if (!c) { c = createCanvas(w, h); scratch.set(name, c); }
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return c;
}

export function hexToRgb(hex) {
  let s = String(hex || '#000').trim().replace('#', '');
  if (s.length === 3) s = s.split('').map((ch) => ch + ch).join('');
  const n = parseInt(s.slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgba(hex, a) { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; }

// ---------------------------------------------------------------- main entry
export function renderDoc(doc, opts = {}) {
  const scale = Math.min(1, opts.scale ?? 1);
  const W = doc.width, H = doc.height;
  const w = Math.max(1, Math.round(W * scale)), h = Math.max(1, Math.round(H * scale));
  const sx = w / W;
  const out = opts.target || createCanvas(w, h);
  if (out.width !== w || out.height !== h) { out.width = w; out.height = h; }
  const ctx = out.getContext('2d');
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, w, h);

  if (opts.showOriginal) {
    ctx.drawImage(scaledPlane(doc.source, w, h), 0, 0);
    ctx.restore();
    return out;
  }

  const inspectionColors = { black: '#000000', white: '#ffffff', green: '#00ff00' };
  const inspection = doc.cutout && doc.mask && (opts.inspection === 'alpha' || inspectionColors[opts.inspection]) ? opts.inspection : null;
  if (inspection === 'alpha') {
    const em = effectiveMaskWH(doc, w, h);
    const image = ctx.createImageData(w, h);
    for (let i = 0, p = 0; i < em.arr.length; i++, p += 4) {
      image.data[p] = image.data[p + 1] = image.data[p + 2] = em.arr[i];
      image.data[p + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    ctx.restore();
    return out;
  }

  const photo = adjustedPlane(doc.source, doc.adjust, w, h, doc);

  if (!inspection && opts.maskView && doc.mask) {
    ctx.drawImage(photo, 0, 0);
    const raw = maskAt(doc.mask, w, h, 0, 0, 'raw');
    const red = scratchCanvas('red', w, h);
    const rc = red.getContext('2d');
    rc.globalCompositeOperation = 'copy';
    rc.fillStyle = 'rgba(255, 36, 66, 0.52)';
    rc.fillRect(0, 0, w, h);
    rc.globalCompositeOperation = 'destination-out';
    rc.drawImage(raw.canvas, 0, 0);
    rc.globalCompositeOperation = 'source-over';
    ctx.drawImage(red, 0, 0);
    ctx.restore();
    return out;
  }

  if (!doc.cutout || !doc.mask) {
    ctx.drawImage(photo, 0, 0);
  } else {
    const em = effectiveMaskWH(doc, w, h);
    if (inspection) {
      ctx.fillStyle = inspectionColors[inspection];
      ctx.fillRect(0, 0, w, h);
    } else drawBackground(ctx, doc, photo, w, h, sx);
    const subjectRGB = subjectPlane(doc.fg || doc.source, doc.mask, w, h);
    const rgb = adjustedPlane(subjectRGB, doc.adjust, w, h, doc);
    const subj = scratchCanvas('subj', w, h);
    const s2 = subj.getContext('2d');
    s2.globalCompositeOperation = 'copy';
    s2.drawImage(rgb, 0, 0);
    s2.globalCompositeOperation = 'destination-in';
    s2.drawImage(em.canvas, 0, 0);
    s2.globalCompositeOperation = 'source-over';
    let sil = subj;
    const fx = inspection ? {} : doc.fx || {};
    if (fx.stroke?.on && fx.stroke.width > 0) {
      sil = scratchCanvas('sil', w, h);
      const c3 = sil.getContext('2d');
      c3.globalCompositeOperation = 'copy';
      c3.drawImage(strokeCanvas(doc, em, w, h, sx), 0, 0);
      c3.globalCompositeOperation = 'source-over';
      c3.drawImage(subj, 0, 0);
    }
    if (fx.shadow?.on && fx.shadow.opacity > 0) {
      ctx.shadowColor = rgba(fx.shadow.color || '#000000', Math.max(0, Math.min(1, fx.shadow.opacity)));
      ctx.shadowBlur = Math.max(0, fx.shadow.blur || 0) * sx;
      ctx.shadowOffsetX = (fx.shadow.dx || 0) * sx;
      ctx.shadowOffsetY = (fx.shadow.dy || 0) * sx;
    }
    ctx.drawImage(sil, 0, 0);
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
  }

  if (!inspection && !opts.noLayers && doc.layers?.length) drawLayers(ctx, doc, sx);
  ctx.restore();
  return out;
}
