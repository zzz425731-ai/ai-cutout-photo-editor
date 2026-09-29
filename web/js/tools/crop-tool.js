// tools/crop-tool.js — 裁剪 tool: crop box over the image (8 handles, drag to move, drag outside to draw a new
// box), pending 90° turns / flips / 拉直 / 改尺寸 shown as a live preview, and the one-step 「应用」.
//   setTool('crop')   (the 裁剪 panel activates it in mount; deactivating discards the pending crop)
//
// Coordinates
//   doc px        the current document (W × H)
//   frame px      the "straightened frame": the doc after the pending 90° turns / flips (orientation matrix
//                 M, size W2 × H2) and then rotated by θ (拉直) around its centre, keeping the W2 × H2 frame.
//                 The crop rect lives here, axis-aligned, and must stay inside the rotated image (no empty
//                 corners). With θ = 0 that is simply 0..W2 × 0..H2.
//   screen px     stage CSS px. The frame is drawn centred on the doc's on-screen centre, at the viewport zoom
//                 (× the fit ratio of the turned frame, so a 90° turn of a landscape photo still fits).
// Apply: ONE store.commit that maps every pixel plane (source, fg, mask, maskAI) through a single drawImage
// (exact for 90° turns / flips / integer crops) + optional high-quality resize, and moves / turns / scales the
// text & sticker layers the same way. The background image is untouched (it is cover-fitted anyway).
//
// Exports (panel + unit tests): state helpers (cropState, setRatio, setCustomRatio, turn, flip, setStraighten,
// setResize, setLock, setCropRect, cancelCrop, applyCrop, isPending, outputSize, cropRectInt, …) and the pure
// geometry (planFromState, planMatrix, transformPlane, transformLayer, applyPlanToDoc, rectInside, fitAspect,
// shrinkInto, M_* matrices).

import { store } from '../core/store.js';
import { registerTool, currentTool } from '../core/tools.js';
import { viewport } from '../core/viewport.js';
import { createCanvas, mapPlanes, resizeCanvas, MAX_SIDE } from '../core/io.js';
import { busy, toast } from '../core/ui.js';
import { nextFrame } from '../core/actions.js';

export const TOOL_ID = 'crop';
export const MAX_OUT = MAX_SIDE;        // longest side of a result (same cap as opened images)

export const RATIOS = [
  { id: 'free', label: '自由', tip: '随意拖出任何形状' },
  { id: 'orig', label: '原比例', tip: '和照片原来的比例一样' },
  { id: '1:1', label: '1:1', w: 1, h: 1, tip: '正方形，适合头像' },
  { id: 'inch1', label: '一寸照', w: 5, h: 7, tip: '一寸证件照比例 5:7' },
  { id: '3:4', label: '3:4', w: 3, h: 4, tip: '竖版，手机拍照常用' },
  { id: '4:3', label: '4:3', w: 4, h: 3, tip: '横版，手机拍照常用' },
  { id: '2:3', label: '2:3', w: 2, h: 3, tip: '竖版，冲印照片常用' },
  { id: '3:2', label: '3:2', w: 3, h: 2, tip: '横版，冲印照片常用' },
  { id: '9:16', label: '9:16', w: 9, h: 16, tip: '竖屏，手机壁纸、短视频' },
  { id: '16:9', label: '16:9', w: 16, h: 9, tip: '宽屏，电脑壁纸、PPT' },
  { id: 'custom', label: '自定义', tip: '自己输入宽高比例' },
];
export const LONG_SIDES = [2048, 1920, 1280, 1080, 800];

// ---------------------------------------------------------------- 2×2 orientation matrices [m0 m1; m2 m3]
export const M_ID = [1, 0, 0, 1];
export const M_CW = [0, -1, 1, 0];     // turn right 90° (y down): (x, y) → (−y, x)
export const M_CCW = [0, 1, -1, 0];    // turn left 90°
export const M_FLIP_H = [-1, 0, 0, 1];
export const M_FLIP_V = [1, 0, 0, -1];
export const mulM = (A, B) => [A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3]];
export const isIdM = (M) => M[0] === 1 && M[1] === 0 && M[2] === 0 && M[3] === 1;
export const swapsM = (M) => M[0] === 0;
/** Size of the doc after orientation M. */
export const frameDims = (W, H, M) => (swapsM(M) ? [H, W] : [W, H]);

const EPS = 1e-6;
const DEG = Math.PI / 180;

// ---------------------------------------------------------------- pure geometry
/** Is rect r (frame px) inside the W2×H2 image rotated by theta (rad) about its centre (inset by margin)? */
export function rectInside(r, W2, H2, theta = 0, margin = 0) {
  if (!(r.w >= 0 && r.h >= 0)) return false;
  if (!theta) return r.x >= -EPS && r.y >= -EPS && r.x + r.w <= W2 + EPS && r.y + r.h <= H2 + EPS;
  const cx = W2 / 2, cy = H2 / 2, co = Math.cos(theta), si = Math.sin(theta);
  const hw = W2 / 2 - margin + EPS, hh = H2 / 2 - margin + EPS;
  const xs = [r.x - cx, r.x + r.w - cx], ys = [r.y - cy, r.y + r.h - cy];
  for (const dx of xs) {
    for (const dy of ys) {
      if (Math.abs(dx * co + dy * si) > hw || Math.abs(-dx * si + dy * co) > hh) return false;
    }
  }
  return true;
}

/** Largest scale s ≤ 1 so that a w×h rect centred on (cx, cy), scaled by s, is valid. */
function maxScale(cx, cy, w, h, valid) {
  const at = (s) => ({ x: cx - (w * s) / 2, y: cy - (h * s) / 2, w: w * s, h: h * s });
  if (valid(at(1))) return 1;
  if (!valid(at(0))) return 0;
  let lo = 0, hi = 1;
  for (let i = 0; i < 26; i++) { const m = (lo + hi) / 2; if (valid(at(m))) lo = m; else hi = m; }
  return lo;
}

/** Biggest rect of the given aspect (w/h) centred in the (rotated) frame. */
export function fitAspect(aspect, W2, H2, theta = 0, margin = 0) {
  const co = Math.abs(Math.cos(theta)), si = Math.abs(Math.sin(theta));
  const BW = W2 * co + H2 * si, BH = W2 * si + H2 * co;   // bounds of the rotated image
  const w0 = Math.min(BW, BH * aspect), h0 = w0 / aspect;
  const valid = (r) => rectInside(r, W2, H2, theta, margin);
  const s = maxScale(W2 / 2, H2 / 2, w0, h0, valid);
  return { x: W2 / 2 - (w0 * s) / 2, y: H2 / 2 - (h0 * s) / 2, w: w0 * s, h: h0 * s };
}

/**
 * base (a crop the user made) shrunk — keeping its aspect, never grown — until it fits the rotated image.
 * Its centre may slide toward the image centre when that keeps it bigger (straighten near an edge).
 */
export function shrinkInto(base, W2, H2, theta = 0, margin = 0) {
  const valid = (r) => rectInside(r, W2, H2, theta, margin);
  if (valid(base)) return { ...base };
  const bx = base.x + base.w / 2, by = base.y + base.h / 2;
  let best = null;
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const cx = bx + (W2 / 2 - bx) * t, cy = by + (H2 / 2 - by) * t;
    const s = maxScale(cx, cy, base.w, base.h, valid);
    if (!best || s > best.s + 1e-4) best = { s, cx, cy };
    if (s >= 1) break;
  }
  const w = base.w * best.s, h = base.h * best.s;
  return { x: best.cx - w / 2, y: best.cy - h / 2, w, h };
}

/** Integer crop rect (rounded edges, kept inside 0..W2 when not straightened). */
export function roundRect(r, W2, H2, theta = 0) {
  let x0 = Math.round(r.x), y0 = Math.round(r.y), x1 = Math.round(r.x + r.w), y1 = Math.round(r.y + r.h);
  if (!theta) { x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(W2, x1); y1 = Math.min(H2, y1); }
  if (x1 - x0 < 1) x1 = x0 + 1;
  if (y1 - y0 < 1) y1 = y0 + 1;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Output size for an integer crop and a resize setting → { w, h, capped } (long side ≤ MAX_OUT). */
export function outputSizeFor(cw, ch, resize) {
  let w = cw, h = ch;
  const m = resize?.mode || 'orig';
  if (m === 'long') { const k = resize.v / Math.max(cw, ch); w = cw * k; h = ch * k; }
  else if (m === 'w') { w = resize.v; h = (ch * resize.v) / cw; }
  else if (m === 'h') { h = resize.v; w = (cw * resize.v) / ch; }
  else if (m === 'exact') { w = resize.w; h = resize.h; }
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  let capped = false;
  if (Math.max(w, h) > MAX_OUT) {
    const k = MAX_OUT / Math.max(w, h);
    w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
    capped = true;
  }
  return { w, h, capped };
}

/**
 * Plan = everything needed to apply: { W, H, m, theta (deg), crop: integer frame rect, out: {w,h} }.
 * planMatrix(plan) → canvas transform [a, b, c, d, e, f] mapping doc px → crop px (before the resize).
 */
export function planMatrix(plan) {
  const { W, H, m, crop } = plan;
  const [W2, H2] = frameDims(W, H, m);
  const t = (plan.theta || 0) * DEG;
  const co = t ? Math.cos(t) : 1, si = t ? Math.sin(t) : 0;
  // L = Rθ · M
  const l00 = co * m[0] - si * m[2], l01 = co * m[1] - si * m[3];
  const l10 = si * m[0] + co * m[2], l11 = si * m[1] + co * m[3];
  const e = W2 / 2 - crop.x - (l00 * W) / 2 - (l01 * H) / 2;
  const f = H2 / 2 - crop.y - (l10 * W) / 2 - (l11 * H) / 2;
  return [l00, l10, l01, l11, e, f];
}

/** New canvas: one pixel plane cropped / turned / straightened / resized per plan. */
export function transformPlane(src, plan) {
  const { crop, out } = plan;
  const willRead = !!src.__willRead;
  const T = planMatrix(plan);
  const identity = T[0] === 1 && T[1] === 0 && T[2] === 0 && T[3] === 1 && T[4] === 0 && T[5] === 0
    && crop.w === src.width && crop.h === src.height;
  let c = src;
  if (!identity) {
    c = createCanvas(crop.w, crop.h, { willRead });
    const x = c.getContext('2d');
    if (plan.theta) { x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high'; }
    else x.imageSmoothingEnabled = false;           // 90° turns / flips / crops: exact pixel copies
    x.setTransform(T[0], T[1], T[2], T[3], T[4], T[5]);
    x.drawImage(src, 0, 0);
  }
  if (out.w !== crop.w || out.h !== crop.h) return resizeCanvas(c, out.w, out.h, { willRead });
  if (c === src) { // nothing to do for this plane: still return a NEW canvas (planes are immutable)
    c = createCanvas(src.width, src.height, { willRead });
    c.getContext('2d').drawImage(src, 0, 0);
  }
  return c;
}

const wrapAngle = (a) => { a %= 2 * Math.PI; if (a > Math.PI) a -= 2 * Math.PI; if (a <= -Math.PI) a += 2 * Math.PI; return a; };

/** A layer moved / turned / scaled like the pixels. Text stays readable on flips (not mirrored). */
export function transformLayer(L, plan) {
  const T = planMatrix(plan);
  const sx = plan.out.w / plan.crop.w, sy = plan.out.h / plan.crop.h;
  const n = { ...L };
  n.x = (T[0] * L.x + T[2] * L.y + T[4]) * sx;
  n.y = (T[1] * L.x + T[3] * L.y + T[5]) * sy;
  const m = plan.m, r = L.rotation || 0;
  const phi = Math.atan2(m[2], m[0]);             // angle of M·(1, 0)
  let rot;
  if (m[0] * m[3] - m[1] * m[2] > 0) rot = r + phi;
  else if (L.type === 'text') {
    // M·R(r) = R(φ−r)·diag(1,−1) = R(φ−r+π)·diag(−1,1): drop the mirror, keep the more upright choice
    const a = wrapAngle(phi - r), b = wrapAngle(phi - r + Math.PI);
    const ca = Math.cos(a), cb = Math.cos(b);
    rot = Math.abs(ca - cb) > 1e-6 ? (ca > cb ? a : b) : (Math.abs(wrapAngle(a - r)) <= Math.abs(wrapAngle(b - r)) ? a : b);
  } else {
    rot = phi - r + Math.PI;                      // pictures / emoji: a true mirror image
    n.flipX = !L.flipX;
  }
  n.rotation = wrapAngle(rot + (plan.theta || 0) * DEG);
  if (Math.abs(n.rotation) < 1e-9) n.rotation = 0;
  if (sx !== 1 || sy !== 1) n.scale = (L.scale ?? 1) * Math.sqrt(sx * sy);
  return n;
}

/** Applies a plan to a doc (call inside store.commit). */
export function applyPlanToDoc(d, plan) {
  Object.assign(d, mapPlanes(d, (c) => transformPlane(c, plan)));
  if (Array.isArray(d.layers) && d.layers.length) d.layers = d.layers.map((L) => transformLayer(L, plan));
  const k = Math.sqrt((plan.out.w / plan.crop.w) * (plan.out.h / plan.crop.h));
  if (Math.abs(k - 1) > 1e-3) {
    // effect sizes are doc px: keep them looking the same on the resized photo
    const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    // Preserve subpixel refinements when resizing: rounding a 0.25 px shrink to 0 loses the edit.
    const edgePx = (v) => Math.round(v * k * 1000) / 1000;
    if (d.edge) { d.edge.feather = cl(edgePx(d.edge.feather), 0, 30); d.edge.shift = cl(edgePx(d.edge.shift), -15, 15); }
    if (d.fx?.shadow) { const s = d.fx.shadow; s.blur = Math.round(s.blur * k); s.dx = Math.round(s.dx * k); s.dy = Math.round(s.dy * k); }
    if (d.fx?.stroke) d.fx.stroke.width = Math.max(1, Math.round(d.fx.stroke.width * k));
  }
}

/** Short undo label for a plan (at most `max` parts). */
export function planLabel(plan, max = 3) {
  const [W2, H2] = frameDims(plan.W, plan.H, plan.m);
  const parts = [];
  const c = plan.crop;
  if (c.x !== 0 || c.y !== 0 || c.w !== W2 || c.h !== H2) parts.push('裁剪');
  const det = plan.m[0] * plan.m[3] - plan.m[1] * plan.m[2];
  if (det < 0) parts.push('翻转');
  if (!isIdM(plan.m) && !(det < 0 && (isIdM(mulM(M_FLIP_H, plan.m)) || isIdM(mulM(M_FLIP_V, plan.m))))) parts.push('旋转');
  if (plan.theta) parts.push('拉直');
  if (plan.out.w !== c.w || plan.out.h !== c.h) parts.push('改尺寸');
  if (plan.theta && parts[0] === '裁剪') parts.shift();     // 拉直 always trims the corners
  return parts.length ? parts.slice(0, max).join('、') : '裁剪';
}

// ---------------------------------------------------------------- pending state (one crop session)
const S = {
  active: false,
  W: 0, H: 0,
  m: M_ID,
  theta: 0,               // degrees, + = clockwise
  crop: null,             // frame px (floats)
  base: null,             // the crop the user made (拉直 shrinks a copy of it)
  ratio: 'free',
  custom: [5, 4],
  resize: { mode: 'orig' },
  lock: true,
  drag: null,
  hover: 'new',
  straightenAt: 0,
};

export function cropState() {
  const [W2, H2] = frameDims(S.W, S.H, S.m);
  return { W: S.W, H: S.H, W2, H2, m: [...S.m], theta: S.theta, crop: S.crop && { ...S.crop }, ratio: S.ratio,
    custom: [...S.custom], resize: { ...S.resize }, lock: S.lock, active: S.active, dragging: !!S.drag?.moved };
}

function fr() {
  const [W2, H2] = frameDims(S.W, S.H, S.m);
  const th = S.theta * DEG;
  return { W2, H2, th, margin: th ? 1 : 0 };
}
const validNow = (r) => { const f = fr(); return rectInside(r, f.W2, f.H2, f.th, f.margin); };

export function ratioAspect(id = S.ratio) {
  const f = fr();
  if (id === 'orig') return f.W2 / f.H2;
  if (id === 'custom') return S.custom[0] > 0 && S.custom[1] > 0 ? S.custom[0] / S.custom[1] : 0;
  const R = RATIOS.find((x) => x.id === id);
  return R?.w ? R.w / R.h : 0;
}

function fullCrop() {
  const f = fr();
  const a = ratioAspect();
  if (a) return fitAspect(a, f.W2, f.H2, f.th, f.margin);
  const full = { x: 0, y: 0, w: f.W2, h: f.H2 };
  return f.th ? shrinkInto(full, f.W2, f.H2, f.th, f.margin) : full;
}

function emit() {
  if (viewport.width) viewport.requestOverlay();
  store.emit('crop:changed', cropState());
}

/** Starts a fresh session for the current doc (ratio → 自由, size → 原尺寸). */
export function resetCrop({ keepRatio = false } = {}) {
  const d = store.doc;
  S.drag = null;
  if (!d) { S.crop = S.base = null; S.W = S.H = 0; emit(); return; }
  S.W = d.width; S.H = d.height;
  S.m = M_ID; S.theta = 0;
  if (!keepRatio) S.ratio = 'free';
  S.resize = { mode: 'orig' };
  S.crop = fullCrop();
  S.base = { ...S.crop };
  emit();
}

export function cropRectInt() {
  if (!S.crop) return null;
  const f = fr();
  return roundRect(S.crop, f.W2, f.H2, f.th);
}
export function outputSize() {
  const c = cropRectInt();
  return c ? outputSizeFor(c.w, c.h, S.resize) : { w: 0, h: 0, capped: false };
}
export function planFromState() {
  const crop = cropRectInt();
  if (!crop) return null;
  const o = outputSize();
  return { W: S.W, H: S.H, m: [...S.m], theta: S.theta, crop, out: { w: o.w, h: o.h } };
}
export function isPending() {
  const p = planFromState();
  if (!p) return false;
  const [W2, H2] = frameDims(p.W, p.H, p.m);
  return !isIdM(p.m) || !!p.theta || p.crop.x !== 0 || p.crop.y !== 0 || p.crop.w !== W2 || p.crop.h !== H2
    || p.out.w !== p.crop.w || p.out.h !== p.crop.h;
}

export function setRatio(id) {
  if (!RATIOS.some((r) => r.id === id) || !S.crop) return;
  S.ratio = id;
  const a = ratioAspect();
  if (a) { const f = fr(); S.crop = fitAspect(a, f.W2, f.H2, f.th, f.margin); S.base = { ...S.crop }; }
  emit();
}
export function setCustomRatio(w, h) {
  w = +w; h = +h;
  if (!(w > 0 && h > 0)) return;
  S.custom = [Math.min(9999, w), Math.min(9999, h)];
  if (S.ratio === 'custom') setRatio('custom'); else emit();
}

/** dir = 1 turn right (clockwise), −1 turn left. */
export function turn(dir) {
  if (!S.crop) return;
  const { W2, H2 } = fr();
  const t = (r) => (dir > 0 ? { x: H2 - r.y - r.h, y: r.x, w: r.h, h: r.w } : { x: r.y, y: W2 - r.x - r.w, w: r.h, h: r.w });
  S.m = mulM(dir > 0 ? M_CW : M_CCW, S.m);
  const R = RATIOS.find((x) => x.id === S.ratio);
  const fixed = S.ratio === 'custom' ? ratioAspect() : R?.w ? R.w / R.h : 0;
  if (fixed && Math.abs(fixed - 1) > 1e-9) { const f = fr(); S.crop = fitAspect(fixed, f.W2, f.H2, f.th, f.margin); S.base = { ...S.crop }; }
  else { S.crop = t(S.crop); S.base = t(S.base); }
  emit();
}
/** axis 'h' = 水平翻转 (mirror left↔right), 'v' = 垂直翻转. */
export function flip(axis) {
  if (!S.crop) return;
  const { W2, H2 } = fr();
  const t = (r) => (axis === 'h' ? { ...r, x: W2 - r.x - r.w } : { ...r, y: H2 - r.y - r.h });
  S.m = mulM(axis === 'h' ? M_FLIP_H : M_FLIP_V, S.m);
  S.theta = S.theta ? -S.theta : 0;         // the mirror of what the user saw
  S.crop = t(S.crop); S.base = t(S.base);
  emit();
}
export function setStraighten(deg) {
  if (!S.crop) return;
  deg = Math.max(-45, Math.min(45, Math.round((+deg || 0) * 10) / 10));
  if (deg === S.theta) return;
  S.theta = deg;
  S.straightenAt = performance.now();
  const f = fr();
  S.crop = shrinkInto(S.base, f.W2, f.H2, f.th, f.margin);
  emit();
  // the fine grid fades out a moment after the slider stops
  clearTimeout(S.gridTimer);
  S.gridTimer = setTimeout(() => { if (viewport.width) viewport.requestOverlay(); }, 950);
}
export function setResize(r) { S.resize = { ...r }; emit(); }
export function setLock(on) { S.lock = !!on; emit(); }
/** Sets the crop rect (frame px); it is made valid (shrunk / clamped). For tests and number entry. */
export function setCropRect(r) {
  if (!S.crop) return;
  const f = fr();
  let c = { x: +r.x, y: +r.y, w: Math.max(1, +r.w), h: Math.max(1, +r.h) };
  if (!validNow(c)) c = shrinkInto(c, f.W2, f.H2, f.th, f.margin);
  S.crop = c; S.base = { ...c };
  emit();
}

export function cancelCrop() { if (S.crop) resetCrop(); }

let applying = false;
/** Applies the pending crop / turns / flips / straighten / resize as ONE undo step. */
export async function applyCrop() {
  const d = store.doc;
  if (!d || !S.crop || applying || !isPending()) return false;
  const plan = planFromState();
  if (plan.W !== d.width || plan.H !== d.height) { resetCrop(); return false; }
  applying = true;
  const label = planLabel(plan);
  const heavy = d.width * d.height > 2.5e6 || plan.out.w * plan.out.h > 2.5e6;
  const b = heavy ? busy('正在应用…') : null;
  try {
    if (b) await nextFrame();
    if (store.doc !== d || d.width !== plan.W || d.height !== plan.H) return false;
    store.commit(label, (doc) => applyPlanToDoc(doc, plan));
  } catch (err) {
    console.warn('[crop] apply failed:', err);
    toast('处理失败了，图片可能太大，请缩小尺寸后再试', 'error');
    return false;
  } finally {
    b?.done();
    applying = false;
  }
  resetCrop();
  toast(`已${label}，不满意可以按 Ctrl+Z 撤销`, 'success', { duration: 2600 });
  // a focused panel button would show its focus ring as if it were still selected
  if (document.activeElement?.tagName === 'BUTTON') document.activeElement.blur();
  return true;
}

// ---------------------------------------------------------------- screen mapping
function fitZoomFor(w, h) {
  const cssW = viewport.width, cssH = viewport.height;
  const pad = Math.min(48, Math.max(16, Math.min(cssW, cssH) * 0.05));
  const cap = Math.max(2, Math.min(8, 320 / Math.max(w, h)));
  return Math.max(0.02, Math.min(cap, (cssW - pad * 2) / w, (cssH - pad * 2) / h));
}
/** Current display transform: frame px → screen = (cx, cy) + (p − frame centre) · z. */
function disp() {
  const { W2, H2, th } = fr();
  let z = viewport.zoom;
  if (th || (swapsM(S.m) && S.W !== S.H)) {
    // keep the whole turned / straightened image in view, like the untouched doc was
    const co = Math.abs(Math.cos(th)), si = Math.abs(Math.sin(th));
    z *= fitZoomFor(W2 * co + H2 * si, W2 * si + H2 * co) / fitZoomFor(S.W, S.H);
  }
  return { z, cx: viewport.panX + (S.W * viewport.zoom) / 2, cy: viewport.panY + (S.H * viewport.zoom) / 2, W2, H2, th };
}
const toScr = (D, x, y) => ({ x: D.cx + (x - D.W2 / 2) * D.z, y: D.cy + (y - D.H2 / 2) * D.z });
const toFrame = (D, sx, sy) => ({ x: (sx - D.cx) / D.z + D.W2 / 2, y: (sy - D.cy) / D.z + D.H2 / 2 });
function imagePoly(D) {
  const hw = D.W2 / 2, hh = D.H2 / 2, co = Math.cos(D.th), si = Math.sin(D.th);
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => toScr(D, D.W2 / 2 + x * co - y * si, D.H2 / 2 + x * si + y * co));
}
/** Frame point → nearest point inside the rotated image. */
function clampInside(p) {
  const { W2, H2, th, margin } = fr();
  const co = Math.cos(th), si = Math.sin(th);
  const dx = p.x - W2 / 2, dy = p.y - H2 / 2;
  let u = dx * co + dy * si, v = -dx * si + dy * co;
  const hw = Math.max(0, W2 / 2 - margin), hh = Math.max(0, H2 / 2 - margin);
  u = Math.max(-hw, Math.min(hw, u)); v = Math.max(-hh, Math.min(hh, v));
  return { x: W2 / 2 + u * co - v * si, y: H2 / 2 + u * si + v * co };
}

// ---------------------------------------------------------------- dragging
const HIT = 12;          // handle hit distance (screen px)
const CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', move: 'move', new: 'crosshair' };

function hitTest(sx, sy) {
  const D = disp();
  const a = toScr(D, S.crop.x, S.crop.y), b = toScr(D, S.crop.x + S.crop.w, S.crop.y + S.crop.h);
  const corners = { nw: [a.x, a.y], ne: [b.x, a.y], se: [b.x, b.y], sw: [a.x, b.y] };
  let best = null, bd = HIT + 1;
  for (const [k, [x, y]] of Object.entries(corners)) {
    const dd = Math.max(Math.abs(sx - x), Math.abs(sy - y));
    if (dd <= HIT && dd < bd) { best = k; bd = dd; }
  }
  if (best) return best;
  const inX = sx > a.x && sx < b.x, inY = sy > a.y && sy < b.y;
  const edges = [['n', inX && Math.abs(sy - a.y)], ['s', inX && Math.abs(sy - b.y)], ['w', inY && Math.abs(sx - a.x)], ['e', inY && Math.abs(sx - b.x)]];
  for (const [k, dd] of edges) if (dd !== false && dd <= HIT * 0.75 && dd < bd) { best = k; bd = dd; }
  if (best) return best;
  // an untouched full-image box can't move: dragging inside it draws a new box (the usual first gesture)
  if (inX && inY) return fillsFrame() ? 'new' : 'move';
  return 'new';
}
function fillsFrame() {
  const { W2, H2, th } = fr(), c = S.crop;
  return !th && Math.abs(c.x) < 0.5 && Math.abs(c.y) < 0.5 && Math.abs(c.w - W2) < 0.5 && Math.abs(c.h - H2) < 0.5;
}
function insideBox(sx, sy) {
  const D = disp();
  const a = toScr(D, S.crop.x, S.crop.y), b = toScr(D, S.crop.x + S.crop.w, S.crop.y + S.crop.h);
  return sx > a.x && sx < b.x && sy > a.y && sy < b.y;
}

const lerpR = (A, B, t) => ({ x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t, w: A.w + (B.w - A.w) * t, h: A.h + (B.h - A.h) * t });
/**
 * Furthest valid rect on the way from (valid) `from` to `to`. Every corner moves linearly, so each of the
 * rotated-image limits gives a linear bound on t — solved exactly (no drift at the borders).
 */
function constrain(from, to) {
  const { W2, H2, th, margin } = fr();
  const co = Math.cos(th), si = Math.sin(th), cx = W2 / 2, cy = H2 / 2;
  const hw = W2 / 2 - margin, hh = H2 / 2 - margin;
  let t = 1;
  for (const fx of [0, 1]) {
    for (const fy of [0, 1]) {
      const ax = from.x + fx * from.w - cx, ay = from.y + fy * from.h - cy;
      const bx = to.x + fx * to.w - cx, by = to.y + fy * to.h - cy;
      for (const [a, b, lim] of [[ax * co + ay * si, bx * co + by * si, hw], [-ax * si + ay * co, -bx * si + by * co, hh]]) {
        if (b > lim + EPS && b > a) t = Math.min(t, Math.max(0, (lim - a) / (b - a)));
        else if (b < -lim - EPS && b < a) t = Math.min(t, Math.max(0, (-lim - a) / (b - a)));
      }
    }
  }
  const r = t >= 1 ? { ...to } : lerpR(from, to, t);
  if (!th) {   // snap float dust onto the image border
    if (Math.abs(r.x) < 1e-6) { r.w += r.x; r.x = 0; }
    if (Math.abs(r.y) < 1e-6) { r.h += r.y; r.y = 0; }
    if (Math.abs(r.x + r.w - W2) < 1e-6) r.w = W2 - r.x;
    if (Math.abs(r.y + r.h - H2) < 1e-6) r.h = H2 - r.y;
  }
  return r;
}
/** Joint move toward `to`, then let each axis slide on its own along the border. */
function constrainSlide(from, to) {
  let r = constrain(from, to);
  r = constrain(r, { ...r, x: to.x, w: to.w });
  r = constrain(r, { ...r, y: to.y, h: to.h });
  return r;
}
function minSize(D) {
  const { W2, H2 } = fr();
  return Math.max(1, Math.min(16 / D.z, Math.min(W2, H2) / 4));
}

function dragRect(g, p, shift) {
  const st = g.start, D = disp(), mn = minSize(D);
  const k = g.kind;
  if (k === 'move') {
    const dx = p.x - g.p0.x, dy = p.y - g.p0.y;
    let r = constrain(st, { ...st, x: st.x + dx });
    r = constrain(r, { ...r, y: st.y + dy });
    return r;
  }
  let aspect = ratioAspect();
  const corner = k.length === 2 || k === 'new';
  if (!aspect && shift && corner && k !== 'new') aspect = st.w / st.h;
  if (corner) {
    // anchor = the fixed corner; the box grows from it toward the pointer
    let A, dirX, dirY, from;
    if (k === 'new') {
      A = g.anchor;
      dirX = p.x >= A.x ? 1 : -1; dirY = p.y >= A.y ? 1 : -1;
      from = { x: A.x, y: A.y, w: 0, h: 0 };
    } else {
      dirX = k.includes('e') ? 1 : -1; dirY = k.includes('s') ? 1 : -1;
      A = { x: dirX > 0 ? st.x : st.x + st.w, y: dirY > 0 ? st.y : st.y + st.h };
      from = st;
    }
    let w = Math.max((p.x - A.x) * dirX, 0), h = Math.max((p.y - A.y) * dirY, 0);
    if (aspect) {
      w = Math.max(w, h * aspect);
      if (k !== 'new') w = Math.max(w, mn, mn * aspect);
      h = w / aspect;
    } else if (k !== 'new') { w = Math.max(w, mn); h = Math.max(h, mn); }
    const to = { x: dirX > 0 ? A.x : A.x - w, y: dirY > 0 ? A.y : A.y - h, w, h };
    if (k === 'new') {
      // lerp from a point (anchor): scale the box as a whole, sliding for free boxes
      return aspect ? constrain(from, to) : constrainSlide(from, to);
    }
    return aspect ? constrain(from, to) : constrainSlide(from, to);
  }
  // edges
  let to;
  if (k === 'e' || k === 'w') {
    const w = Math.max(mn, k === 'e' ? p.x - st.x : st.x + st.w - p.x);
    const x = k === 'e' ? st.x : st.x + st.w - w;
    if (aspect) { const h = Math.max(w / aspect, 0); to = { x, y: st.y + st.h / 2 - h / 2, w, h }; }
    else to = { ...st, x, w };
  } else {
    const h = Math.max(mn, k === 's' ? p.y - st.y : st.y + st.h - p.y);
    const y = k === 's' ? st.y : st.y + st.h - h;
    if (aspect) { const w = h * aspect; to = { x: st.x + st.w / 2 - w / 2, y, w, h }; }
    else to = { ...st, y, h };
  }
  return constrain(st, to);
}

function setHover(kind) {
  if (S.hover === kind) return;
  S.hover = kind;
  viewport.updateCursor?.();
}

function pointerScreen(pt) { return viewport.toScreen(pt.x, pt.y); }

function onPointerDown(pt, e) {
  if (!S.crop || !store.doc) return;
  const sp = pointerScreen(pt);
  const D = disp();
  const p = toFrame(D, sp.x, sp.y);
  const kind = hitTest(sp.x, sp.y);
  S.drag = { kind, start: { ...S.crop }, prev: { ...S.crop }, p0: p, s0: sp, moved: false };
  if (kind === 'new') S.drag.anchor = clampInside(p);
  setHover(kind);
}
function onPointerMove(pt, e) {
  if (!S.crop || !store.doc) return;
  const sp = pointerScreen(pt);
  const g = S.drag;
  if (!g) { setHover(hitTest(sp.x, sp.y)); return; }
  if (!g.moved && Math.hypot(sp.x - g.s0.x, sp.y - g.s0.y) < 3) return;
  g.moved = true;
  const D = disp();
  S.crop = dragRect(g, toFrame(D, sp.x, sp.y), e?.shiftKey);
  emit();
}
function onPointerUp(pt, e) {
  const g = S.drag;
  if (!g) return;
  if (g.moved) onPointerMove(pt, e);
  S.drag = null;
  if (g.kind === 'new') {
    const D = disp();
    if (!g.moved || S.crop.w * D.z < 8 || S.crop.h * D.z < 8) S.crop = g.prev;   // a click, not a box
  }
  S.base = { ...S.crop };
  const sp = pointerScreen(pt);
  setHover(hitTest(sp.x, sp.y));
  emit();
}

function onDoubleClick(pt) {
  if (!S.crop || !store.doc || !isPending()) return;
  const sp = pointerScreen(pt);
  if (insideBox(sp.x, sp.y)) applyCrop();      // double-click inside the box = 应用
}

function onKey(e) {
  if (!S.crop || !store.doc || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Enter') {
    // 「取消」/「应用」 keep their own Enter; on any other focused button Enter means 应用 (not "click it again")
    if (!isPending() || e.target?.closest?.('.crop-actions')) return;
    e.preventDefault();
    if (!e.repeat) applyCrop();
    return;
  }
  if (e.key === 'Escape') {
    if (S.drag) { e.preventDefault(); S.crop = S.drag.prev; S.base = { ...S.crop }; S.drag = null; emit(); return; }
    if (isPending()) { e.preventDefault(); cancelCrop(); }
    return;
  }
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target?.tagName || '')) return;   // arrows on a focused slider move the slider
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  const a = arrows[e.key];
  if (a && !S.drag) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const c = S.crop;
    let r = constrain(c, { ...c, x: c.x + a[0] * step });
    r = constrain(r, { ...r, y: c.y + a[1] * step });
    S.crop = r; S.base = { ...r };
    emit();
  }
}

// ---------------------------------------------------------------- drawing
let dotPat = null, chkPat = null, patDpr = 0;
function patterns(ctx, dpr) {
  if (patDpr === dpr && dotPat) return;
  patDpr = dpr;
  const d = createCanvas(18 * dpr, 18 * dpr);
  const dx = d.getContext('2d');
  dx.fillStyle = 'rgba(16, 24, 40, 0.07)';
  dx.beginPath(); dx.arc(9 * dpr, 9 * dpr, 1.1 * dpr, 0, Math.PI * 2); dx.fill();
  dotPat = ctx.createPattern(d, 'repeat');
  dotPat.setTransform(new DOMMatrix().scale(1 / dpr));
  const c = createCanvas(16 * dpr, 16 * dpr);
  const cx = c.getContext('2d');
  cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, c.width, c.height);
  cx.fillStyle = '#e9ebf0'; cx.fillRect(0, 0, 8 * dpr, 8 * dpr); cx.fillRect(8 * dpr, 8 * dpr, 8 * dpr, 8 * dpr);
  chkPat = ctx.createPattern(c, 'repeat');
}
const polyPath = (ctx, pts) => { ctx.moveTo(pts[0].x, pts[0].y); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y); ctx.closePath(); };

function pill(ctx, text, x, y, vp) {
  ctx.font = '600 12px "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif';
  const w = Math.ceil(ctx.measureText(text).width) + 16, h = 22;
  x = Math.max(6, Math.min(vp.width - w - 6, x - w / 2));
  y = Math.max(6, Math.min(vp.height - h - 6, y));
  ctx.save();
  ctx.fillStyle = 'rgba(22, 26, 34, 0.82)';
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 6); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, x + 8, y + h / 2 + 0.5);
  ctx.restore();
}

function drawOverlay(ctx, vp) {
  const d = store.doc;
  if (!d || !S.crop || d.width !== S.W || d.height !== S.H) return;
  const D = disp();
  const dpr = vp.dpr || 1;
  const poly = imagePoly(D);
  const identity = isIdM(S.m) && !S.theta && Math.abs(D.z - vp.zoom) < 1e-9;
  if (!identity && vp.preview && vp.previewScale) {
    // the view underneath shows the untouched doc: cover it and draw the turned / straightened preview
    patterns(ctx, dpr);
    ctx.save();
    ctx.fillStyle = '#eceef2'; ctx.fillRect(0, 0, vp.width, vp.height);
    ctx.fillStyle = dotPat; ctx.fillRect(0, 0, vp.width, vp.height);
    ctx.beginPath(); polyPath(ctx, poly);
    ctx.shadowColor = 'rgba(15, 23, 42, 0.16)'; ctx.shadowBlur = 24 * dpr; ctx.shadowOffsetY = 6 * dpr;
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = chkPat;
    chkPat.setTransform(new DOMMatrix().translate(poly[0].x, poly[0].y).scale(1 / dpr));
    ctx.fill();
    ctx.translate(D.cx, D.cy);
    ctx.scale(D.z, D.z);
    ctx.rotate(D.th);
    ctx.transform(S.m[0], S.m[2], S.m[1], S.m[3], 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(vp.preview, -S.W / 2, -S.H / 2, S.W, S.H);
    ctx.restore();
  }
  const a = toScr(D, S.crop.x, S.crop.y), b = toScr(D, S.crop.x + S.crop.w, S.crop.y + S.crop.h);
  const x0 = Math.round(a.x), y0 = Math.round(a.y), x1 = Math.round(b.x), y1 = Math.round(b.y);
  const bw = x1 - x0, bh = y1 - y0;
  // darken outside the box (only over the image)
  ctx.save();
  ctx.beginPath(); polyPath(ctx, poly); ctx.rect(x0, y0, bw, bh);
  ctx.fillStyle = 'rgba(12, 16, 24, 0.55)';
  ctx.fill('evenodd');
  ctx.restore();
  // grid: thirds while dragging, a finer one while straightening
  const straightening = performance.now() - S.straightenAt < 900;
  const lines = straightening ? 6 : S.drag?.moved ? 3 : 0;
  if (lines) {
    ctx.save();
    ctx.lineWidth = 1;
    for (const [color, off] of [['rgba(0, 0, 0, 0.28)', 1], ['rgba(255, 255, 255, 0.72)', 0]]) {
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (let i = 1; i < lines; i++) {
        const gx = Math.round(x0 + (bw * i) / lines) + 0.5 + off, gy = Math.round(y0 + (bh * i) / lines) + 0.5 + off;
        ctx.moveTo(gx, y0); ctx.lineTo(gx, y1);
        ctx.moveTo(x0, gy); ctx.lineTo(x1, gy);
      }
      ctx.stroke();
    }
    ctx.restore();
  }
  // frame
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.strokeRect(x0 - 0.5, y0 - 0.5, bw + 1, bh + 1);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.strokeRect(x0 + 0.5, y0 + 0.5, bw - 1, bh - 1);
  // handles: L-shaped corners + edge bars
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)'; ctx.shadowBlur = 3 * dpr;
  ctx.fillStyle = '#fff';
  const T = 3, L = Math.max(8, Math.min(20, Math.min(bw, bh) / 3));
  const corner = (cx, cy, sx, sy) => {
    ctx.fillRect(sx > 0 ? cx - T : cx - L + T, sy > 0 ? cy - T : cy, L, T);
    ctx.fillRect(sx > 0 ? cx - T : cx, sy > 0 ? cy - T : cy - L + T, T, L);
  };
  corner(x0, y0, 1, 1); corner(x1, y0, -1, 1); corner(x1, y1, -1, -1); corner(x0, y1, 1, -1);
  const E = 18;
  if (bw > E * 2.6) {
    ctx.fillRect(Math.round((x0 + x1) / 2 - E / 2), y0 - T + 1, E, T);
    ctx.fillRect(Math.round((x0 + x1) / 2 - E / 2), y1 - 1, E, T);
  }
  if (bh > E * 2.6) {
    ctx.fillRect(x0 - T + 1, Math.round((y0 + y1) / 2 - E / 2), T, E);
    ctx.fillRect(x1 - 1, Math.round((y0 + y1) / 2 - E / 2), T, E);
  }
  ctx.restore();
  // size readout
  const c = cropRectInt(), o = outputSize();
  const txt = o.w !== c.w || o.h !== c.h ? `${c.w} × ${c.h} → ${o.w} × ${o.h} 像素` : `${c.w} × ${c.h} 像素`;
  const above = y0 - 30 >= 4;
  pill(ctx, txt, (x0 + x1) / 2, above ? y0 - 30 : y0 + 8, vp);
  if (straightening) {
    pill(ctx, `拉直 ${S.theta > 0 ? '+' : ''}${S.theta.toFixed(1)}°`, (x0 + x1) / 2, (y0 + y1) / 2 - 11, vp);
  }
}

// ---------------------------------------------------------------- tool
registerTool({
  id: TOOL_ID,
  get cursor() { return CURSORS[S.drag ? S.drag.kind : S.hover] || 'crosshair'; },
  hint: '拖动四角或边调整裁剪框 · 框外拖动重新画框 · 双击框内或按 Enter 应用 · Esc 取消',
  activate() { S.active = true; resetCrop(); },
  deactivate() { S.active = false; S.drag = null; S.crop = S.base = null; S.theta = 0; S.m = M_ID; store.emit('crop:changed', cropState()); },
  onPointerDown, onPointerMove, onPointerUp, onDoubleClick, onKey,
  drawOverlay,
});

// the doc changed size underneath a pending crop (undo / redo of an earlier crop): start over
store.on('doc:changed', (p) => {
  if (p?.reason === 'bump' || !S.active || currentTool()?.id !== TOOL_ID) return;
  const d = store.doc;
  if (!d) return;
  if (d.width !== S.W || d.height !== S.H) resetCrop({ keepRatio: true });
});
