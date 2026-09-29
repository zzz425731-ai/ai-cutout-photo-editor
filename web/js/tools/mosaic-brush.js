// tools/mosaic-brush.js — 打码 pixel effects on the photo. Every edit reaches doc.source AND doc.fg and is
// ONE undo step (brush: mirror + store.commitRegions; box / faces: in place + store.commitRegions).
//   setTool('mosaic-brush', { kind: 'mosaic' | 'blur' })   马赛克笔 / 模糊笔
//   setTool('mosaic-box',   { kind: 'mosaic' | 'blur' })   框选打码: drag a rectangle, released → applied
// Settings (view state, not undoable) live in store.ui.mosaic — see mosaicSettings().
// Shared helpers (also used by 一键人脸打码 in panels/mosaic.js and by the unit tests):
//   clampPad(src, R) · pixelateRegion(src, R, block) · blurRegion(src, R, sigma) · blockFor(v, W, H) ·
//   sigmaFor(v, W, H) · mergeRects(rects) · applyRegions(label, regions, { kind })

import { store, uidOf } from '../core/store.js';
import { registerTool } from '../core/tools.js';
import { viewport } from '../core/viewport.js';
import { createBrushStroke, drawBrushCursor } from '../core/brush.js';
import { createCanvas, resizeCanvas } from '../core/io.js';

const DEFAULTS = {
  tool: 'mosaic',        // 手动打码 tool: 'mosaic' | 'blur' | 'box' | 'doodle'
  boxKind: 'mosaic',     // 框选打码 effect
  block: 50,             // 马赛克格子 1..100 (relative to the image size)
  blur: 50,              // 模糊程度 1..100
  face: 'mosaic',        // 一键人脸打码: 'mosaic' | 'blur' | 'emoji'
  faceStrength: 60,      // 1..100
  emoji: '😊',
  color: '#ff3b30',      // 涂鸦
  highlighter: false,    // 荧光笔 (semi-transparent)
};
/** store.ui.mosaic with defaults filled in (the same object on every call once created). */
export function mosaicSettings() {
  const s = store.ui.mosaic || (store.ui.mosaic = {});
  for (const k in DEFAULTS) if (s[k] === undefined) s[k] = DEFAULTS[k];
  return s;
}

/** Overlay redraw, only once the stage exists (the unit-test page has none). */
function redraw() { if (viewport.width) viewport.requestOverlay(); }

// ---------------------------------------------------------------- effect maths
/** 格子大小 (doc px) for a 1..100 setting: ~0.5 % … 3 % of the long side. */
export function blockFor(v, W, H) {
  return Math.max(3, Math.round(Math.max(W, H) * (0.004 + 0.026 * Math.max(0, Math.min(100, v)) / 100)));
}
/** Blur sigma (doc px) for a 1..100 setting. */
export function sigmaFor(v, W, H) {
  return Math.max(1.5, Math.max(W, H) * (0.002 + 0.018 * Math.max(0, Math.min(100, v)) / 100));
}

/** Copy of src over rect R (integer, may extend outside the image) with clamp-to-edge padding. */
export function clampPad(src, R) {
  const W = src.width, H = src.height;
  const out = createCanvas(R.w, R.h);
  const c = out.getContext('2d');
  c.imageSmoothingEnabled = false;
  const ax0 = Math.max(0, Math.min(W, R.x)), ax1 = Math.max(0, Math.min(W, R.x + R.w));
  const ay0 = Math.max(0, Math.min(H, R.y)), ay1 = Math.max(0, Math.min(H, R.y + R.h));
  if (ax1 <= ax0 || ay1 <= ay0) return out;
  const ox = ax0 - R.x, oy = ay0 - R.y, aw = ax1 - ax0, ah = ay1 - ay0;
  c.drawImage(src, ax0, ay0, aw, ah, ox, oy, aw, ah);
  if (ox > 0) c.drawImage(out, ox, oy, 1, ah, 0, oy, ox, ah);
  const rx = ox + aw;
  if (rx < R.w) c.drawImage(out, rx - 1, oy, 1, ah, rx, oy, R.w - rx, ah);
  if (oy > 0) c.drawImage(out, 0, oy, R.w, 1, 0, 0, R.w, oy);
  const by = oy + ah;
  if (by < R.h) c.drawImage(out, 0, by - 1, R.w, 1, 0, by, R.w, R.h - by);
  return out;
}

/** Mosaic of src over R (grid anchored at R's top-left): each block = the average colour below it. */
export function pixelateRegion(src, R, block) {
  const b = Math.max(1, Math.round(block));
  const sw = Math.max(1, Math.ceil(R.w / b)), sh = Math.max(1, Math.ceil(R.h / b));
  const small = b === 1 ? clampPad(src, R) : resizeCanvas(clampPad(src, { x: R.x, y: R.y, w: sw * b, h: sh * b }), sw, sh);
  const out = createCanvas(R.w, R.h);
  const oc = out.getContext('2d');
  oc.imageSmoothingEnabled = false;
  oc.drawImage(small, 0, 0, sw * b, sh * b);
  return out;
}

/** Gaussian-like blur of src over R (edges clamped, result fully opaque). Big sigmas run on a smaller copy. */
export function blurRegion(src, R, sigma) {
  const p = Math.ceil(sigma * 4) + 2;
  const T = clampPad(src, { x: R.x - p, y: R.y - p, w: R.w + 2 * p, h: R.h + 2 * p });
  const s = Math.min(1, 6 / sigma);
  const tw = Math.max(1, Math.round(T.width * s)), th = Math.max(1, Math.round(T.height * s));
  const kx = tw / T.width, ky = th / T.height;
  const S = createCanvas(tw, th);
  const sc = S.getContext('2d');
  sc.imageSmoothingQuality = 'high';
  sc.filter = `blur(${(sigma * kx).toFixed(3)}px)`;
  sc.drawImage(T, 0, 0, tw, th);
  const out = createCanvas(R.w, R.h);
  const oc = out.getContext('2d');
  oc.imageSmoothingEnabled = true;
  oc.imageSmoothingQuality = 'high';
  oc.drawImage(S, p * kx, p * ky, R.w * kx, R.h * ky, 0, 0, R.w, R.h);
  oc.globalCompositeOperation = 'destination-over'; // any residual transparency → the original pixels
  oc.drawImage(T, p, p, R.w, R.h, 0, 0, R.w, R.h);
  return out;
}

/** Soft ellipse cut of an effect canvas covering g.rect (g.ellipse in doc px, g.feather px). */
function shapeEllipse(eff, g) {
  const { rect: r, ellipse: e } = g;
  const c = eff.getContext('2d');
  c.save();
  c.globalCompositeOperation = 'destination-in';
  c.translate(e.cx - r.x, e.cy - r.y);
  c.scale(e.rx, e.ry);
  const f = Math.max(0.02, Math.min(0.5, (g.feather ?? 2) / Math.min(e.rx, e.ry)));
  const gr = c.createRadialGradient(0, 0, 1 - f, 0, 0, 1);
  gr.addColorStop(0, '#000');
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = gr;
  c.fillRect(-1.05, -1.05, 2.1, 2.1);
  c.restore();
  return eff;
}

const touches = (a, b) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
/** Unions overlapping / touching rects until none overlap (so region undo data never overlaps). */
export function mergeRects(rects) {
  const out = rects.map((r) => ({ ...r }));
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < out.length && !changed; i++) {
      for (let j = i + 1; j < out.length; j++) {
        if (!touches(out[i], out[j])) continue;
        const a = out[i], b = out[j];
        const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
        out[i] = { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
        out.splice(j, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

function intRect(r, W, H) {
  const x = Math.max(0, Math.floor(r.x)), y = Math.max(0, Math.floor(r.y));
  const w = Math.min(W, Math.ceil(r.x + r.w)) - x, h = Math.min(H, Math.ceil(r.y + r.h)) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/**
 * Applies mosaic / blur to several regions of the photo (source + fg) as ONE undo step.
 * regions: [{ rect, param /* block px or sigma px *\/, shape?: 'rect'|'ellipse', ellipse?: {cx,cy,rx,ry}, feather? }]
 */
export function applyRegions(label, regions, { kind = 'mosaic' } = {}) {
  const d = store.doc;
  if (!d) return false;
  const list = regions.map((g) => ({ ...g, rect: intRect(g.rect, d.width, d.height) })).filter((g) => g.rect);
  if (!list.length) return false;
  const planes = [['source', d.source], ['fg', d.fg]].filter(([, c]) => c);
  const clusters = mergeRects(list.map((g) => g.rect));
  const befores = clusters.map((r) => planes.map(([, c]) => c.getContext('2d').getImageData(r.x, r.y, r.w, r.h)));
  // every effect is computed from the untouched photo, then drawn onto both planes
  const effs = list.map((g) => {
    const eff = kind === 'blur' ? blurRegion(d.source, g.rect, g.param) : pixelateRegion(d.source, g.rect, g.param);
    return g.shape === 'ellipse' && g.ellipse ? shapeEllipse(eff, g) : eff;
  });
  for (const [, c] of planes) {
    const cx = c.getContext('2d');
    list.forEach((g, i) => cx.drawImage(effs[i], g.rect.x, g.rect.y));
  }
  const parts = [];
  clusters.forEach((r, ci) => planes.forEach(([name], pi) => parts.push({ plane: name, rect: r, before: befores[ci][pi] })));
  store.commitRegions(label, parts);
  return true;
}

// ---------------------------------------------------------------- brush pattern (whole photo, cached)
let patCache = null; // { key, canvas }
function patternKey(kind, d) {
  const s = mosaicSettings();
  const param = kind === 'blur' ? sigmaFor(s.blur, d.width, d.height) : blockFor(s.block, d.width, d.height);
  return { key: `${uidOf(d.source)}:${d.source.__v || 0}:${kind}:${param.toFixed(2)}`, param };
}
function patternFor(kind, d) {
  const { key, param } = patternKey(kind, d);
  if (patCache?.key === key) return patCache;
  const R = { x: 0, y: 0, w: d.width, h: d.height };
  const eff = kind === 'blur' ? blurRegion(d.source, R, param) : pixelateRegion(d.source, R, param);
  const canvas = createCanvas(d.width, d.height, { willRead: true }); // the brush reads it tile by tile
  canvas.getContext('2d').drawImage(eff, 0, 0);
  patCache = { key, canvas };
  return patCache;
}
/** Drops the cached whole-photo pattern (memory) — called when the 打码 panel closes. */
export function releasePattern() { patCache = null; }

// ---------------------------------------------------------------- 马赛克笔 / 模糊笔
let kind = 'mosaic';
let stroke = null, planes = null;

function step(pt) {
  const r = stroke.addPoint(pt.x, pt.y);
  if (r) { store.bump('source', r); if (planes.fg) store.bump('fg', r); }
}
function finish() {
  if (!stroke) return;
  const res = stroke.end();
  stroke = null;
  const p = planes;
  planes = null;
  const d = store.doc;
  if (!res || !d || d.source !== p.src) return;
  store.commitRegions(p.kind === 'blur' ? '模糊笔' : '马赛克笔',
    [{ plane: 'source', ...res }, res.mirror && d.fg === p.fg && { plane: 'fg', rect: res.rect, ...res.mirror }]);
  // the stroke only moved pixels toward the pattern → keep it for the next stroke (consistent blocks)
  if (patCache && patCache.key === p.key) patCache.key = patternKey(p.kind, d).key;
}

export const mosaicBrush = registerTool({
  id: 'mosaic-brush',
  cursor: 'none',
  get hint() {
    return (kind === 'blur' ? '模糊笔' : '马赛克笔') + '：在要遮住的地方涂一涂 · [ ] 调大小 · 空格拖动画布';
  },
  get kind() { return kind; },
  activate(o = {}) { if (o.kind === 'mosaic' || o.kind === 'blur') kind = o.kind; },
  deactivate() { finish(); },
  onPointerDown(pt) {
    const d = store.doc;
    if (!d || stroke) return;
    const pat = patternFor(kind, d);
    planes = { src: d.source, fg: d.fg, kind, key: pat.key };
    stroke = createBrushStroke({
      plane: d.source, mirror: d.fg || null, mode: 'pattern', pattern: pat.canvas,
      size: Math.max(2, store.ui.brush.size), hardness: 0.8,
    });
    step(pt);
  },
  onPointerMove(pt) { if (stroke) step(pt); },
  onPointerUp(pt) { if (stroke) { step(pt); finish(); } },
  drawOverlay(ctx, vp) { drawBrushCursor(ctx, vp, { size: store.ui.brush.size, hardness: 0.8 }); },
});

// ---------------------------------------------------------------- 框选打码
let boxKind = 'mosaic';
let box = null; // { x0, y0, x1, y1 } doc px

const clampPt = (pt) => ({ x: Math.max(0, Math.min(store.doc.width, pt.x)), y: Math.max(0, Math.min(store.doc.height, pt.y)) });
export function boxRect(b) {
  const x = Math.round(Math.min(b.x0, b.x1)), y = Math.round(Math.min(b.y0, b.y1));
  return { x, y, w: Math.round(Math.max(b.x0, b.x1)) - x, h: Math.round(Math.max(b.y0, b.y1)) - y };
}
/** 框选打码 of one rect with the current settings (one undo step). */
export function applyBox(r, k = boxKind) {
  const d = store.doc;
  if (!d) return false;
  const s = mosaicSettings();
  const param = k === 'blur' ? sigmaFor(s.blur, d.width, d.height) : blockFor(s.block, d.width, d.height);
  return applyRegions(k === 'blur' ? '框选模糊' : '框选马赛克', [{ rect: r, param }], { kind: k });
}

export const mosaicBox = registerTool({
  id: 'mosaic-box',
  cursor: 'crosshair',
  get hint() { return `框选打码：在图上拖出方框，松手就${boxKind === 'blur' ? '模糊' : '打上马赛克'} · Esc 取消 · 空格拖动画布`; },
  get kind() { return boxKind; },
  activate(o = {}) { if (o.kind === 'mosaic' || o.kind === 'blur') boxKind = o.kind; },
  deactivate() { box = null; },
  onPointerDown(pt) {
    if (!store.doc) return;
    const p = clampPt(pt);
    box = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    redraw();
  },
  onPointerMove(pt) {
    if (!box || !store.doc) return;
    const p = clampPt(pt);
    box.x1 = p.x; box.y1 = p.y;
    redraw();
  },
  onPointerUp(pt) {
    if (!box) return;
    this.onPointerMove(pt);
    const r = boxRect(box);
    box = null;
    redraw();
    if (r.w >= 2 && r.h >= 2 && r.w * viewport.zoom >= 6 && r.h * viewport.zoom >= 6) applyBox(r);
  },
  onKey(e) { if (e.key === 'Escape' && box) { box = null; redraw(); } },
  drawOverlay(ctx, vp) {
    if (!box) return;
    const r = boxRect(box);
    const a = vp.toScreen(r.x, r.y), b = vp.toScreen(r.x + r.w, r.y + r.h);
    const x = Math.round(a.x) + 0.5, y = Math.round(a.y) + 0.5, w = Math.round(b.x - a.x), h = Math.round(b.y - a.y);
    ctx.save();
    ctx.fillStyle = 'rgba(52, 100, 240, 0.14)';
    ctx.fillRect(x, y, w, h);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = '#3464f0';
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    if (w > 40 && h > 20) {
      const label = `${r.w} × ${r.h}`;
      ctx.font = '12px system-ui, sans-serif';
      const tw = ctx.measureText(label).width + 12;
      const ly = y + h + 22 < vp.height ? y + h + 6 : y - 22;
      ctx.fillStyle = 'rgba(20, 24, 32, 0.78)';
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x + w / 2 - tw / 2, ly, tw, 18, 4) : ctx.rect(x + w / 2 - tw / 2, ly, tw, 18);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x + w / 2, ly + 9.5);
    }
    ctx.restore();
  },
});
