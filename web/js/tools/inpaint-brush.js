// tools/inpaint-brush.js — 消除笔: paints a translucent red selection over what should disappear (the photo
// itself is NOT touched while painting), then /api/inpaint (LaMa) fills it in.
//   setTool('inpaint-brush')
//   store.ui.eraseAuto (default true) → erase automatically when the stroke ends; otherwise runErase()
// Only a context crop around each painted area is sent (≈ 2.5 × its bbox, ≥ 256 px, kept inside the image);
// the results are pasted back with ONE actions.replaceSource (one undo step, fg kept in sync).
// Events: 'erase:paint' { has } when the selection changes · 'erase:running' bool · 'erase:done' { ms, n }.
// Keys while active: Enter = 开始消除 · Esc = 清除涂抹. Size comes from store.ui.brush.size ([ ] keys).

import { store, unionRect } from '../core/store.js';
import { registerTool } from '../core/tools.js';
import { drawBrushCursor } from '../core/brush.js';
import { viewport } from '../core/viewport.js';
import * as api from '../core/api.js';
import { busy, toast } from '../core/ui.js';
import { createCanvas, cropCanvas, cloneCanvas, canvasToDataURL, dataURLToCanvas } from '../core/io.js';
import { replaceSource, nextFrame } from '../core/actions.js';

export const PAINT_COLOR = '#ff2d4a';
export const CONTEXT_FACTOR = 2.5;
export const CONTEXT_MIN = 256;

let paint = null;     // { canvas, ctx, doc, rects: [] } — the painted selection (view state, not in the doc)
let stroke = null;    // { last: [x, y], rect, size }
let running = false;
let warm = false;     // the inpaint model has been used once this session (first call loads it)

/** Overlay redraw, only once the stage exists (the unit-test page has none). */
function redraw() { if (viewport.width) viewport.requestOverlay(); }

// ---------------------------------------------------------------- pure helpers (unit-tested)
/** Context crop around a painted bbox: factor × its size, at least `min` px, shifted/clipped to stay inside W×H. */
export function contextRect(b, W, H, { factor = CONTEXT_FACTOR, min = CONTEXT_MIN } = {}) {
  const cw = Math.min(W, Math.max(min, Math.round(b.w * factor)));
  const ch = Math.min(H, Math.max(min, Math.round(b.h * factor)));
  let x = Math.round(b.x + b.w / 2 - cw / 2), y = Math.round(b.y + b.h / 2 - ch / 2);
  x = Math.max(0, Math.min(W - cw, x));
  y = Math.max(0, Math.min(H - ch, y));
  return { x, y, w: cw, h: ch };
}

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Groups painted stroke rects into independent jobs: strokes whose context crops overlap are merged, so
 * each job is one request and the jobs never overlap. → [{ bbox, crop }]
 */
export function groupRects(rects, W, H, opts) {
  let groups = rects.filter((r) => r && r.w > 0 && r.h > 0).map((r) => ({ bbox: { ...r } }));
  for (let changed = true; changed;) {
    changed = false;
    for (const g of groups) g.crop = contextRect(g.bbox, W, H, opts);
    outer: for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        if (overlaps(groups[i].crop, groups[j].crop)) {
          groups[i].bbox = unionRect(groups[i].bbox, groups[j].bbox);
          groups.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  return groups;
}

/** White-on-black mask (what /api/inpaint wants) of the painted pixels inside rect. → { canvas, count } */
export function maskFromPaint(paintCanvas, rect) {
  const src = paintCanvas.getContext('2d').getImageData(rect.x, rect.y, rect.w, rect.h).data;
  const out = createCanvas(rect.w, rect.h);
  const octx = out.getContext('2d');
  const id = octx.createImageData(rect.w, rect.h);
  const d = id.data;
  let count = 0;
  for (let i = 0; i < d.length; i += 4) {
    const v = src[i + 3] > 24 ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
    if (v) count++;
  }
  octx.putImageData(id, 0, 0);
  return { canvas: out, count };
}

// ---------------------------------------------------------------- selection state
export function hasPaint() { return !!(paint && paint.doc === store.doc && paint.rects.length); }
export function isErasing() { return running; }
/** The painted selection canvas (tests / debugging). */
export function paintCanvas() { return paint?.canvas || null; }

function ensurePaint() {
  const d = store.doc;
  if (!d) return null;
  if (!paint || paint.canvas.width !== d.width || paint.canvas.height !== d.height) {
    const canvas = createCanvas(d.width, d.height); // GPU-backed: drawn every overlay frame, read once per erase
    paint = { canvas, ctx: canvas.getContext('2d'), doc: d, rects: [] };
  } else if (paint.doc !== d) {
    paint.ctx.clearRect(0, 0, paint.canvas.width, paint.canvas.height);
    paint.doc = d;
    paint.rects = [];
  }
  return paint;
}

export function clearPaint() {
  const had = hasPaint();
  if (paint) { paint.ctx.clearRect(0, 0, paint.canvas.width, paint.canvas.height); paint.rects = []; }
  stroke = null;
  redraw();
  if (had) store.emit('erase:paint', { has: false });
}

function dab(x0, y0, x1, y1, size) {
  const c = paint.ctx;
  c.fillStyle = c.strokeStyle = PAINT_COLOR;
  c.lineCap = c.lineJoin = 'round';
  c.lineWidth = size;
  c.beginPath();
  if (x0 === x1 && y0 === y1) { c.arc(x0, y0, size / 2, 0, Math.PI * 2); c.fill(); }
  else { c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke(); }
}
function grow(r, x, y, pad) {
  const n = { x: Math.floor(x - pad), y: Math.floor(y - pad), w: Math.ceil(2 * pad) + 1, h: Math.ceil(2 * pad) + 1 };
  return r ? unionRect(r, n) : n;
}
function clampToDoc(r) {
  const W = store.doc.width, H = store.doc.height;
  const x = Math.max(0, r.x), y = Math.max(0, r.y);
  const w = Math.min(W, r.x + r.w) - x, h = Math.min(H, r.y + r.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

// ---------------------------------------------------------------- erase
/** Sends every painted area to /api/inpaint and pastes the results back as ONE undo step. */
export async function runErase() {
  const doc = store.doc;
  if (running || !doc || !hasPaint()) return false;
  const src = doc.source;
  const srcV = src.__v || 0;
  const valid = () => store.doc === doc && doc.source === src && (src.__v || 0) === srcV;
  const jobs = groupRects(paint.rects, doc.width, doc.height);
  running = true;
  store.emit('erase:running', true);
  const b = busy(warm ? '正在消除…' : '首次使用要加载消除模型，约 10 秒…');
  const t0 = performance.now();
  try {
    await nextFrame();
    const results = [];
    for (let i = 0; i < jobs.length; i++) {
      const { crop } = jobs[i];
      const m = maskFromPaint(paint.canvas, crop);
      if (!m.count) continue;
      if (i > 0 || warm) b.update(jobs.length > 1 ? `正在消除… ${i + 1}/${jobs.length}` : '正在消除…');
      const r = await api.inpaint(canvasToDataURL(cropCanvas(src, crop), 'image/png'), canvasToDataURL(m.canvas, 'image/png'));
      warm = true;
      if (!valid()) return false; // another image / undo / in-place pixel edit meanwhile
      const img = await dataURLToCanvas(r.image);
      if (img.width !== crop.w || img.height !== crop.h) throw new Error('消除结果尺寸不对，请重试');
      results.push({ crop, img });
    }
    if (!valid()) return false;
    if (!results.length) { clearPaint(); return false; }
    const out = cloneCanvas(src);
    const octx = out.getContext('2d');
    let rect = null;
    for (const { crop, img } of results) {
      octx.drawImage(img, 0, 0, crop.w, crop.h, crop.x, crop.y, crop.w, crop.h);
      rect = rect ? unionRect(rect, crop) : crop;
    }
    replaceSource('消除', out, { rect });
    clearPaint();
    const ms = Math.round(performance.now() - t0);
    store.emit('erase:done', { ms, n: results.length });
    return true;
  } catch (err) {
    console.warn('[erase] inpaint failed:', err);
    toast(err.message || '消除失败了，请再试一次', 'error');
    return false;
  } finally {
    b.done();
    running = false;
    store.emit('erase:running', false);
  }
}

// ---------------------------------------------------------------- tool
function finishStroke() {
  if (!stroke) return false;
  const r = clampToDoc(stroke.rect);
  stroke = null;
  if (!r) return false;
  paint.rects.push(r);
  store.emit('erase:paint', { has: true });
  return true;
}

export const inpaintBrush = registerTool({
  id: 'inpaint-brush',
  cursor: 'none',
  get hint() {
    return store.ui.eraseAuto === false
      ? '消除笔：涂好后点「开始消除」（回车） · Esc 清除涂抹 · [ ] 调大小 · 空格拖动画布'
      : '消除笔：涂住要去掉的东西，松手自动消除 · [ ] 调大小 · 空格拖动画布';
  },
  activate() {
    if (paint && paint.doc !== store.doc) clearPaint();
  },
  deactivate() {
    stroke = null;
    clearPaint();
  },
  onPointerDown(pt) {
    if (running || !store.doc) return;
    if (!ensurePaint()) return;
    const size = Math.max(2, store.ui.brush.size);
    stroke = { last: [pt.x, pt.y], rect: grow(null, pt.x, pt.y, size / 2 + 2), size };
    dab(pt.x, pt.y, pt.x, pt.y, size);
    redraw();
  },
  onPointerMove(pt) {
    if (!stroke) return;
    const [lx, ly] = stroke.last;
    if (Math.hypot(pt.x - lx, pt.y - ly) < 0.5) return;
    dab(lx, ly, pt.x, pt.y, stroke.size);
    stroke.last = [pt.x, pt.y];
    stroke.rect = grow(stroke.rect, pt.x, pt.y, stroke.size / 2 + 2);
    redraw();
  },
  onPointerUp(pt) {
    if (!stroke) return;
    this.onPointerMove(pt);
    if (finishStroke() && store.ui.eraseAuto !== false) runErase();
  },
  onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape' && hasPaint()) { clearPaint(); e.preventDefault?.(); }
    else if (e.key === 'Enter' && hasPaint()) { runErase(); e.preventDefault?.(); }
  },
  drawOverlay(ctx, vp) {
    if (paint && paint.doc === store.doc && (paint.rects.length || stroke)) {
      const r = vp.docRect();
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(paint.canvas, r.x, r.y, r.w, r.h);
      ctx.restore();
    }
    if (!running) drawBrushCursor(ctx, vp, { size: store.ui.brush.size, hardness: 1 });
  },
});
