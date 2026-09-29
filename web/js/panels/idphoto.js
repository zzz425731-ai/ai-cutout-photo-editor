// panels/idphoto.js — 证件照: 尺寸 / 底色 / 一键生成（人像抠图 + 人脸定位 + 精确像素裁切）/ 微调 / 限制大小保存 / 排版打印.
//
// 「一键生成」 turns the current doc into an ID photo at the exact pixel size in ONE undo step: all four planes
// (source, fg, mask, maskAI) are cropped + scaled, cutout on, colour background, doc.dpi = 300.
// doc.idphoto keeps the pre-idphoto planes (canvases by reference) and the detected face, so changing the size or
// the 微调 sliders always re-frames from the ORIGINAL photo (no compounding quality loss) — also after undo/redo.

import { registerPanel } from '../core/panels.js';
import { store, uidOf, cloneData } from '../core/store.js';
import { h, section, slider, toggle, segmented, button, hint, toast, busy, modal, confirm } from '../core/ui.js';
import { icon, ICONS } from '../core/icons.js';
import * as api from '../core/api.js';
import { runCutout, nextFrame, isCutoutRunning } from '../core/actions.js';
import { createCanvas, resizeCanvas, rotateCanvas90, canvasToBlob, readAlpha } from '../core/io.js';
import { exportCanvas } from '../core/exporter.js';
import { prewarm } from '../core/render.js';

ICONS.idphotoPrint = '<path d="M7 9V4h10v5"/><rect x="3.5" y="9" width="17" height="8" rx="2"/><path d="M7 14h10v6H7z"/>';

// ------------------------------------------------------------------ sizes & colours
export const DPI = 300;
const PX_PER_MM = DPI / 25.4;
export const mmToPx = (mm) => Math.round(mm * PX_PER_MM);
export const pxToMm = (px) => px / PX_PER_MM;
const r1 = (v) => Math.round(v * 10) / 10;

export const PRESETS = [
  { id: 'one', name: '一寸', mm: [25, 35], px: [295, 413] },
  { id: 'two', name: '二寸', mm: [35, 49], px: [413, 579] },
  { id: 'small-two', name: '小二寸', mm: [35, 45], px: [413, 531] },
  { id: 'small-one', name: '小一寸', mm: [22, 32], px: [260, 378] },
  { id: 'big-one', name: '大一寸', mm: [33, 48], px: [390, 567] },
  { id: 'idcard', name: '身份证', mm: [26, 32], px: [358, 441], dpi: 350 }, // 公安部规格: 358×441 px = 26×32 mm @ 350 dpi
  { id: 'driver', name: '驾驶证', mm: [22, 32], px: [260, 378] },
  { id: 'passport', name: '护照/签证', file: '护照签证', mm: [33, 48], px: [390, 567] },
  { id: 'custom', name: '自定义' },
];
const CUSTOM_LIMITS = { mm: { min: 10, max: 150 }, px: { min: 100, max: 2400 } };

/** Size of a preset (or the custom size) → { id, name, file, w, h (px), mm:[w,h], dpi } or null if the custom size is invalid. */
export function presetSize(id, custom) {
  if (id === 'custom') {
    const c = custom || {};
    const unit = c.unit === 'px' ? 'px' : 'mm';
    const L = CUSTOM_LIMITS[unit];
    const w = +c.w, hh = +c.h;
    if (!(w >= L.min && w <= L.max && hh >= L.min && hh <= L.max)) return null;
    if (w / hh < 0.45 || w / hh > 1.6) return null;
    if (unit === 'px') return { id, name: '自定义', file: '自定义', w: Math.round(w), h: Math.round(hh), mm: [pxToMm(Math.round(w)), pxToMm(Math.round(hh))], dpi: DPI };
    return { id, name: '自定义', file: '自定义', w: mmToPx(w), h: mmToPx(hh), mm: [w, hh], dpi: DPI };
  }
  const p = PRESETS.find((x) => x.id === id && x.px) || PRESETS[0];
  return { id: p.id, name: p.name, file: p.file || p.name, w: p.px[0], h: p.px[1], mm: [...p.mm], dpi: p.dpi || DPI };
}

export const GRADIENT_TOP = '#dcebfa';
export const COLORS = [
  { id: 'white', name: '白', hex: '#ffffff' },
  { id: 'blue', name: '蓝', hex: '#438edb' },
  { id: 'red', name: '红', hex: '#d9001b' },
  { id: 'gray', name: '浅灰', hex: '#f2f2f2' },
  { id: 'gradient', name: '渐变蓝', hex: GRADIENT_TOP, hex2: '#438edb' },
  { id: 'custom', name: '自定义' },
];
/** doc.bg fields for a colour choice. */
export function colorBg(id, customHex) {
  if (id === 'gradient') return { type: 'gradient', color: GRADIENT_TOP, color2: '#438edb', angle: 180 };
  if (id === 'custom') return { type: 'color', color: /^#[0-9a-f]{6}$/i.test(customHex || '') ? customHex.toLowerCase() : '#ffffff' };
  const c = COLORS.find((x) => x.id === id && x.hex) || COLORS[0];
  return { type: 'color', color: c.hex };
}

// ------------------------------------------------------------------ face → framing (pure, unit-tested)
export const HEAD = 0.66;      // hair top → chin, fraction of the photo height
export const TOP = 0.09;       // space above the hair
const HEAD_MAX = 0.72;         // big hair / hats may take up to this much
export const MIN_FACE = 40;    // px: smaller faces are refused
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const clampI = (v, a, b) => Math.min(b, Math.max(a, Math.round(v)));

/** Face from /api/faces (landmarks: right eye, left eye, nose, right mouth, left mouth) → geometry in the same px. */
export function faceGeometry(f) {
  const [re, le, , rm, lm] = f.landmarks || [];
  const boxCx = f.x + f.w / 2;
  let eyeY = f.y + f.h * 0.42, eyeCx = boxCx, chin = f.y + f.h;
  if (re && le) { eyeY = (re[1] + le[1]) / 2; eyeCx = (re[0] + le[0]) / 2; }
  if (re && le && rm && lm) {
    // the box bottom sits at the chin for most faces; landmarks catch boxes that end too early / too late
    const mouthY = (rm[1] + lm[1]) / 2, D = mouthY - eyeY;
    if (D > 0) chin = clamp(chin, mouthY + 0.3 * D, mouthY + 0.9 * D);
  }
  return { bx: f.x, top: f.y, bw: f.w, bh: f.h, cx: (boxCx + eyeCx) / 2, eyeY, chin };
}

/**
 * Hair top + horizontal head extent from the subject mask (alpha array of `rect`, same px as g).
 * Scans upward from the eyes over the face columns and stops at the first empty rows.
 */
export function measureHead(arr, rect, g) {
  const { x: rx, y: ry, w: rw, h: rh } = rect;
  const A = (x, y) => arr[(y - ry) * rw + (x - rx)];
  const xa = clampI(g.bx - 0.1 * g.bw, rx, rx + rw - 1), xb = clampI(g.bx + 1.1 * g.bw, xa, rx + rw - 1);
  const thr = Math.max(2, Math.round((xb - xa + 1) * 0.015));
  const count = (y) => { let n = 0; for (let x = xa; x <= xb; x++) if (A(x, y) > 96) n++; return n; };
  const yStart = clampI(g.eyeY, ry, ry + rh - 1);
  const miss = { hairTop: g.top - 0.25 * g.bh, left: g.bx, right: g.bx + g.bw, found: false };
  if (count(yStart) < thr) return miss;
  let top = yStart, empty = 0;
  const maxGap = Math.max(1, Math.round(g.bh * 0.012));
  for (let y = yStart - 1; y >= ry; y--) {
    if (count(y) >= thr) { top = y; empty = 0; } else if (++empty > maxGap) break;
  }
  top = Math.max(top, g.top - 1.3 * g.bh); // raised hands / props touching the head
  const cx = clampI(g.cx, rx, rx + rw - 1), gap = Math.max(2, Math.round(g.bw * 0.12));
  let left = g.bx, right = g.bx + g.bw;
  const step = Math.max(1, Math.round((yStart - top) / 120));
  for (let y = Math.ceil(top); y <= yStart; y += step) {
    let last = null;
    for (let x = cx; x >= rx; x--) {
      if (A(x, y) > 128) last = x;
      else if ((last === null ? cx - x : last - x) > gap) break;
    }
    if (last !== null) left = Math.min(left, last);
    last = null;
    for (let x = cx; x < rx + rw; x++) {
      if (A(x, y) > 128) last = x;
      else if ((last === null ? x - cx : x - last) > gap) break;
    }
    if (last !== null) right = Math.max(right, last + 1);
  }
  return { hairTop: top, left, right, found: true };
}

/** measureHead on a doc mask (downscaled first so the face is ~240 px: fast and plenty precise). */
export function headFromMask(mask, g) {
  const m = Math.min(1, 240 / Math.max(1, g.bh));
  const mc = m < 1 ? resizeCanvas(mask, mask.width * m, mask.height * m, { willRead: true }) : mask;
  const sx = mc.width / mask.width, sy = mc.height / mask.height;
  const x0 = clampI(Math.floor((g.bx - 1.6 * g.bw) * sx), 0, mc.width - 1);
  const x1 = clampI(Math.ceil((g.bx + 2.6 * g.bw) * sx), x0 + 1, mc.width);
  const y1 = clampI(Math.ceil(g.eyeY * sy) + 1, 1, mc.height);
  const rect = { x: x0, y: 0, w: x1 - x0, h: y1 };
  const gs = { bx: g.bx * sx, bw: g.bw * sx, cx: g.cx * sx, top: g.top * sy, bh: g.bh * sy, eyeY: g.eyeY * sy, chin: g.chin * sy };
  const r = measureHead(readAlpha(mc, rect), rect, gs);
  return { hairTop: r.hairTop / sy, left: r.left / sx, right: r.right / sx, hairFound: r.found };
}

/**
 * Automatic framing for a W×H photo: head (hair top → chin) ≈ 66 % of the height, ≈ 9 % space above,
 * face centred (but the whole head kept inside when possible). Returns a scale + an anchor (head centre)
 * with its output position, so zoom / shifts can be applied around it (frameRect).
 */
export function autoFrame(g, W, H, srcW, srcH) {
  const hairTop = g.hairTop ?? g.top - 0.25 * g.bh;
  const measured = Math.max(g.chin - hairTop, (g.chin - g.top) * 1.05, 1);
  const expected = 2.15 * Math.max(1, g.chin - g.eyeY);          // typical hair-top → chin for this face
  const headNorm = Math.min(measured, 1.25 * expected);         // big hair must not shrink the face too much…
  const s = Math.min((HEAD * H) / headNorm, (HEAD_MAX * H) / measured); // …but never leaves the photo
  let y0 = g.chin - ((TOP + HEAD) * H) / s;
  const over = y0 + H / s - srcH;                               // photo ends soon below the chin → move the head
  if (over > 0) {                                               // down a little (≤ 13 % space above) instead
    const room = Math.max(0, 0.13 * H - (hairTop - y0) * s) / s;
    y0 -= Math.min(over, room);
  }
  const Ws = W / s, m = 0.04 * Ws;
  let cx = g.cx;
  if (g.right > g.left) {
    if (g.right - g.left + 2 * m <= Ws) cx = clamp(cx, g.right + m - Ws / 2, g.left - m + Ws / 2);
    else cx = (g.left + g.right) / 2;
  }
  const x0 = cx - Ws / 2;
  const ax = cx, ay = (hairTop + g.chin) / 2;
  return { s, ax, ay, axOut: (ax - x0) * s, ayOut: (ay - y0) * s };
}

/** Source rect for the photo with the user's fine-tuning: zoom around the head centre, dx/dy in photo fractions. */
export function frameRect(base, W, H, zoom = 1, dx = 0, dy = 0) {
  const s = base.s * zoom;
  return { x: base.ax - (base.axOut + dx * W) / s, y: base.ay - (base.ayOut + dy * H) / s, w: W / s, h: H / s, s };
}

// ------------------------------------------------------------------ planes
// Cheap working copies of the original planes (≈1.6× the output resolution): re-framing while dragging a slider
// only draws from these. Cleared when another original is framed.
const work = new Map();
function workOf(orig, need) {
  if (need >= 0.55) return orig;
  let e = work.get(orig);
  if (!e || e.k < need * 0.98 || e.k > need * 2.2) {
    const k = Math.min(1, need * 1.6);
    e = { k, c: resizeCanvas(orig, orig.width * k, orig.height * k, { willRead: false }) };
    work.set(orig, e);
  }
  return e.c;
}
function pruneWork(keep) { for (const k of [...work.keys()]) if (!keep.includes(k)) work.delete(k); }

/**
 * Draw `rect` (original-photo px) of a plane into a new W×H canvas. `src` may be a downscaled copy of the
 * original (OW×OH). Outside the photo the outermost row/column is repeated (a photo that ends at the shoulders
 * still fills the frame); mask planes stay empty above the photo (nothing above the hair).
 */
export function drawPlane(src, OW, OH, rect, W, H, isMask = false) {
  const out = createCanvas(W, H, { willRead: isMask });
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  const s = W / rect.w, kx = src.width / OW, ky = src.height / OH;
  const X0 = clampI(-rect.x * s, 0, W), X1 = clampI((OW - rect.x) * s, 0, W);
  const Y0 = clampI(-rect.y * s, 0, H), Y1 = clampI((OH - rect.y) * s, 0, H);
  if (X1 <= X0 || Y1 <= Y0) return out;
  const cw = src.width, ch = src.height;
  let sx = (rect.x + X0 / s) * kx, sy = (rect.y + Y0 / s) * ky;
  let sw = ((X1 - X0) / s) * kx, sh = ((Y1 - Y0) / s) * ky;
  sx = clamp(sx, 0, cw - 0.01); sy = clamp(sy, 0, ch - 0.01);
  sw = Math.min(sw, cw - sx); sh = Math.min(sh, ch - sy);
  ctx.drawImage(src, sx, sy, sw, sh, X0, Y0, X1 - X0, Y1 - Y0);
  // Edge bands. Strips are extracted 1:1 across their width (no bleeding) and then stretched (edges clamp).
  // Photo planes: the band fades from the sharp outermost pixels into a smoothed copy, so clothes / skin
  // continue as a soft colour instead of hard streaks. Masks keep the sharp silhouette.
  const soft = !isMask;
  const kx0 = Math.max(1, Math.round(cw * 0.012)), ky0 = Math.max(1, Math.round(ch * 0.012));
  const ramp = Math.max(4, Math.round(Math.max(W, H) * 0.035));
  const strip = (a, b, c, d, dw, dh) => {
    const t = createCanvas(dw, dh);
    const tc = t.getContext('2d');
    tc.imageSmoothingEnabled = true; tc.imageSmoothingQuality = 'high';
    tc.drawImage(src, a, b, c, d, 0, 0, dw, dh);
    return t;
  };
  const put = (t, dx, dy, dw, dh) => { if (dw > 0 && dh > 0) ctx.drawImage(t, dx, dy, dw, dh); };
  // side: 'l' | 'r' | 't' | 'b' (where the band lies relative to the photo) → fade in away from the photo edge
  const fade = (t, dx, dy, dw, dh, side) => {
    if (dw <= 0 || dh <= 0) return;
    const tmp = createCanvas(dw, dh);
    const tc = tmp.getContext('2d');
    tc.imageSmoothingEnabled = true; tc.imageSmoothingQuality = 'high';
    tc.drawImage(t, 0, 0, dw, dh);
    tc.globalCompositeOperation = 'destination-in';
    const g = side === 'b' ? tc.createLinearGradient(0, 0, 0, ramp) : side === 't' ? tc.createLinearGradient(0, dh, 0, dh - ramp)
      : side === 'r' ? tc.createLinearGradient(0, 0, ramp, 0) : tc.createLinearGradient(dw, 0, dw - ramp, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,1)');
    tc.fillStyle = g; tc.fillRect(0, 0, dw, dh);
    ctx.drawImage(tmp, dx, dy);
  };
  const lenY = Y1 - Y0, lenX = X1 - X0;
  const smooth = (n) => Math.max(2, Math.round(n / 14));
  if (X0 > 0) {
    put(strip(0, sy, 1, sh, 1, lenY), 0, Y0, X0, lenY);
    if (soft) fade(strip(0, sy, kx0, sh, 1, smooth(lenY)), 0, Y0, X0, lenY, 'l');
  }
  if (X1 < W) {
    put(strip(cw - 1, sy, 1, sh, 1, lenY), X1, Y0, W - X1, lenY);
    if (soft) fade(strip(cw - kx0, sy, kx0, sh, 1, smooth(lenY)), X1, Y0, W - X1, lenY, 'r');
  }
  const rows = [];
  if (Y1 < H) rows.push([ch - 1, ch - ky0, Y1, H - Y1, 'b']);
  if (Y0 > 0 && !isMask) rows.push([0, 0, 0, Y0, 't']);
  for (const [row, rowK, dy, dh, side] of rows) {
    put(strip(sx, row, sw, 1, lenX, 1), X0, dy, lenX, dh);
    if (soft) fade(strip(sx, rowK, sw, ky0, smooth(lenX), 1), X0, dy, lenX, dh, side);
    // corners: one (averaged) colour
    const cy = soft ? rowK : row, chh = soft ? ky0 : 1;
    if (X0 > 0) put(strip(0, cy, soft ? kx0 : 1, chh, 1, 1), 0, dy, X0, dh);
    if (X1 < W) put(strip(cw - (soft ? kx0 : 1), cy, soft ? kx0 : 1, chh, 1, 1), X1, dy, W - X1, dh);
  }
  return out;
}

/** All planes of the ID photo for the record's size / zoom / shifts. */
export function buildPlanes(rec) {
  const o = rec.orig, W = rec.size.w, H = rec.size.h;
  const base = autoFrame(rec.face, W, H, o.width, o.height);
  const r = frameRect(base, W, H, (rec.zoom ?? 100) / 100, (rec.dx || 0) / 100, (rec.dy || 0) / 100);
  pruneWork([o.source, o.fg, o.mask, o.maskAI]);
  const plane = (c, isMask) => (c ? drawPlane(workOf(c, r.s), o.width, o.height, r, W, H, isMask) : null);
  const maskAI = plane(o.maskAI, true);
  if (maskAI && o.maskAI.__matte) maskAI.__matte = o.maskAI.__matte;
  return { source: plane(o.source, false), fg: plane(o.fg, false), mask: plane(o.mask, true), maskAI, rect: r };
}

/** Inside store.commit: (re)build the doc planes from rec (= d.idphoto or about to be). */
export function applyFrame(d, rec) {
  const p = buildPlanes(rec);
  d.source = p.source; d.fg = p.fg; d.mask = p.mask; d.maskAI = p.maskAI;
  d.width = rec.size.w; d.height = rec.size.h;
  d.dpi = rec.size.dpi || DPI;
  d.cutout = true;
  rec.s = p.rect.s;
  rec.out = { src: uidOf(p.source), mask: uidOf(p.mask), w: rec.size.w, h: rec.size.h };
  return p.rect;
}

/** Inside store.commit on a cut-out doc: turn it into an ID photo. g = faceGeometry (+ headFromMask). */
export function makeIdPhoto(d, g, { size, color = 'white', customColor = null } = {}) {
  const rec = {
    preset: size.id, size: { ...size, mm: [...size.mm] }, color, customColor, zoom: 100, dx: 0, dy: 0, face: { ...g },
    orig: { source: d.source, fg: d.fg || null, mask: d.mask, maskAI: d.maskAI || d.mask, width: d.width, height: d.height },
  };
  const r = applyFrame(d, rec);
  // one-time conversions from the original photo's pixels
  d.edge = { feather: Math.min(30, Math.round((d.edge?.feather || 0) * r.s)), shift: clamp(Math.round((d.edge?.shift || 0) * r.s), -15, 15) };
  if (d.fx) { d.fx.shadow.on = false; d.fx.stroke.on = false; }
  d.layers = (d.layers || []).map((L) => ({ ...L, x: (L.x - r.x) * r.s, y: (L.y - r.y) * r.s, scale: (L.scale ?? 1) * r.s }));
  d.bg = { ...d.bg, ...colorBg(color, customColor) };
  d.idphoto = rec;
  return rec;
}

/** Was the ID photo edited in place / replaced after it was framed (beauty, mask brush, crop…)? */
export function isStale(d, rec = d?.idphoto) {
  if (!rec?.out || !d?.source || !d.mask) return true;
  return uidOf(d.source) !== rec.out.src || uidOf(d.mask) !== rec.out.mask || (d.source.__v || 0) !== 0 || (d.mask.__v || 0) !== 0
    || d.width !== rec.out.w || d.height !== rec.out.h;
}

// ------------------------------------------------------------------ saving
/** JPEG at quality 95, or the best quality that fits maxBytes (binary search). → { blob, quality, ok } */
export async function encodeJpeg(canvas, maxBytes = null) {
  const q95 = await canvasToBlob(canvas, 'image/jpeg', 0.95);
  if (!maxBytes || q95.size <= maxBytes) return { blob: q95, quality: 95, ok: true };
  let lo = 0.1, hi = 0.95;
  let best = await canvasToBlob(canvas, 'image/jpeg', lo);
  if (best.size > maxBytes) return { blob: best, quality: 10, ok: false };
  let bestQ = lo;
  for (let i = 0; i < 7; i++) {
    const mid = (lo + hi) / 2;
    const b = await canvasToBlob(canvas, 'image/jpeg', mid);
    if (b.size <= maxBytes) { best = b; bestQ = mid; lo = mid; } else hi = mid;
  }
  return { blob: best, quality: Math.round(bestQ * 100), ok: true };
}
export const kbText = (bytes) => `${Math.max(1, Math.ceil(bytes / 1024))} KB`;

// ------------------------------------------------------------------ print layout
// 6 寸 = 6×4 in, 5 寸 = 5×3.5 in, at 300 dpi. Margins keep the usual counts (6 寸: 一寸 8 张, 二寸 4 张) and room to cut.
export const PAPERS = {
  6: { name: '6 寸', px: [1800, 1200], mm: [152, 102], margin: 11 },
  5: { name: '5 寸', px: [1500, 1050], mm: [127, 89], margin: 8 },
};
const GAP_MM = 3;

/** Grid of photos (size in mm) on a paper; photos are turned 90° when that fits more. */
export function layoutSheet(paperId, photoMM) {
  const P = PAPERS[paperId] || PAPERS[6];
  const [SW, SH] = P.px;
  const M = mmToPx(P.margin), G = mmToPx(GAP_MM);
  const pw = mmToPx(photoMM[0]), ph = mmToPx(photoMM[1]);
  const fit = (w, hh) => {
    const cols = Math.max(0, Math.floor((SW - 2 * M + G) / (w + G)));
    const rows = Math.max(0, Math.floor((SH - 2 * M + G) / (hh + G)));
    return { cols, rows, n: cols * rows };
  };
  const up = fit(pw, ph), rot = fit(ph, pw);
  const rotated = rot.n > up.n;
  const g = rotated ? rot : up;
  const cellW = rotated ? ph : pw, cellH = rotated ? pw : ph;
  const gridW = g.cols * cellW + (g.cols - 1) * G, gridH = g.rows * cellH + (g.rows - 1) * G;
  const x0 = Math.round((SW - gridW) / 2), y0 = Math.round((SH - gridH) / 2);
  const cells = [];
  for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) cells.push({ x: x0 + c * (cellW + G), y: y0 + r * (cellH + G) });
  const cutX = [], cutY = [];
  if (g.n) {
    for (let c = 0; c <= g.cols; c++) cutX.push(Math.round(x0 + c * (cellW + G) - G / 2));
    for (let r = 0; r <= g.rows; r++) cutY.push(Math.round(y0 + r * (cellH + G) - G / 2));
  }
  return { paper: String(paperId), sheetW: SW, sheetH: SH, photoW: pw, photoH: ph, cellW, cellH, rotated, cols: g.cols, rows: g.rows, count: g.n, cells, cutX, cutY };
}

/** Render the sheet: white paper, light cut lines in the gaps, the photo in every cell. */
export function renderSheet(photo, L) {
  const c = createCanvas(L.sheetW, L.sheetH);
  const x = c.getContext('2d');
  x.fillStyle = '#ffffff';
  x.fillRect(0, 0, c.width, c.height);
  if (!L.count) return c;
  let p = photo.width === L.photoW && photo.height === L.photoH ? photo : resizeCanvas(photo, L.photoW, L.photoH);
  if (L.rotated) p = rotateCanvas90(p, -1);
  x.strokeStyle = '#c9ced6';
  x.lineWidth = 2;
  x.beginPath();
  for (const lx of L.cutX) { x.moveTo(lx, 0); x.lineTo(lx, L.sheetH); }
  for (const ly of L.cutY) { x.moveTo(0, ly); x.lineTo(L.sheetW, ly); }
  x.stroke();
  for (const cell of L.cells) x.drawImage(p, cell.x, cell.y);
  return c;
}

// ------------------------------------------------------------------ panel
function prefs() {
  store.ui.idphoto ??= { preset: 'one', color: 'white', customColor: '#8ec5f0', custom: { unit: 'mm', w: 25, h: 35 }, limitOn: false, limitKB: 200, paper: '6', guides: true };
  return store.ui.idphoto;
}
const baseName = (p) => String(p || '').split(/[\\/]/).pop();
function fileBase(d) { return (d?.name || '照片').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim() || '照片'; }
const sizeLine = (size) => `${r1(size.mm[0])}×${r1(size.mm[1])} 毫米 · ${size.w}×${size.h} 像素`;

registerPanel({
  id: 'idphoto',
  title: '证件照',
  icon: icon('idphoto', 22),
  order: 30,
  tip: '一寸、二寸证件照，换底色，排版打印',
  mount(el, ctx) {
    const { viewport } = ctx;
    const P = prefs();

    // ---------------------------------------------------------- intro / done card
    const intro = h('div', { class: 'idp-intro' },
      h('div', { class: 'idp-intro-art', html: icon('idphoto', 26) }),
      h('div', {},
        h('div', { class: 'idp-intro-title' }, '一键做证件照'),
        h('div', { class: 'idp-intro-sub' }, '自动抠图、换底色，把头像摆到标准位置')));
    const doneTitle = h('div', { class: 'idp-done-title' });
    const doneSub = h('div', { class: 'idp-done-sub' });
    const quickSave = button({ text: '保存', icon: 'save', primary: true, size: 'sm', tip: '保存成 JPG 到「输出」文件夹', onClick: () => saveIdPhoto() });
    const quickPrint = button({ text: '排版打印', icon: 'idphotoPrint', variant: 'secondary', size: 'sm', tip: '排到 6 寸 / 5 寸相纸上', onClick: () => openPrint() });
    const done = h('div', { class: 'idp-done' },
      h('div', { class: 'idp-done-head' },
        h('div', { class: 'idp-done-ico', html: icon('check', 18) }),
        h('div', { class: 'idp-done-text' }, doneTitle, doneSub)),
      h('div', { class: 'idp-done-actions' }, quickSave, quickPrint));

    // ---------------------------------------------------------- 尺寸
    const cards = new Map();
    const grid = h('div', { class: 'idp-sizes', role: 'radiogroup', 'aria-label': '证件照尺寸' });
    for (const p of PRESETS) {
      const b = h('button', { type: 'button', class: 'idp-size', role: 'radio', 'data-id': p.id, onclick: () => choosePreset(p.id) },
        h('span', { class: 'idp-size-name' }, p.name),
        p.px
          ? [h('span', { class: 'idp-size-mm' }, `${p.mm[0]}×${p.mm[1]}mm`), h('span', { class: 'idp-size-px' }, `${p.px[0]}×${p.px[1]}`)]
          : [h('span', { class: 'idp-size-mm' }, '毫米 / 像素'), h('span', { class: 'idp-size-px' }, '自己填')]);
      cards.set(p.id, b);
      grid.append(b);
    }
    const cW = h('input', { class: 'num-input idp-num', type: 'text', inputmode: 'decimal', 'aria-label': '宽' });
    const cH = h('input', { class: 'num-input idp-num', type: 'text', inputmode: 'decimal', 'aria-label': '高' });
    const cUnit = segmented({ size: 'sm', value: P.custom.unit, className: 'idp-unit',
      options: [{ value: 'mm', label: '毫米' }, { value: 'px', label: '像素' }],
      onChange: (u) => changeUnit(u) });
    const cInfo = h('div', { class: 'idp-custom-info' });
    const customBox = h('div', { class: 'idp-custom' },
      h('div', { class: 'idp-custom-row' },
        h('label', { class: 'idp-custom-f' }, h('span', {}, '宽'), cW),
        h('span', { class: 'idp-x' }, '×'),
        h('label', { class: 'idp-custom-f' }, h('span', {}, '高'), cH),
        cUnit),
      cInfo);
    for (const inp of [cW, cH]) {
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); e.stopPropagation(); });
      inp.addEventListener('change', commitCustom);
    }
    const secSize = section('尺寸', '按报名或办证要求选，不确定就选一寸');
    secSize.append(grid, customBox);

    // ---------------------------------------------------------- 底色
    const tiles = new Map();
    const colorRow = h('div', { class: 'idp-colors', role: 'radiogroup', 'aria-label': '底色' });
    const picker = h('input', { type: 'color', class: 'idp-picker', tabindex: '-1', 'aria-hidden': 'true', value: P.customColor });
    for (const c of COLORS) {
      const sw = h('span', { class: `idp-sw idp-sw-${c.id}`, style: c.hex ? { '--c': c.hex, '--c2': c.hex2 || c.hex } : null });
      const b = h('button', { type: 'button', class: 'idp-color', role: 'radio', 'data-id': c.id, 'aria-label': `${c.name}底`,
        onclick: () => (c.id === 'custom' ? picker.click() : chooseColor(c.id)) }, sw, h('span', { class: 'idp-color-name' }, c.name));
      tiles.set(c.id, { b, sw });
      colorRow.append(b);
    }
    tiles.get('custom').b.append(picker);
    picker.addEventListener('input', () => chooseColor('custom', picker.value, true));
    picker.addEventListener('change', () => store.endCoalesce());
    const secColor = section('底色', '白底最常用；蓝底、红底按要求选');
    secColor.append(colorRow);

    // ---------------------------------------------------------- 生成
    const genBtn = button({ text: '一键生成证件照', icon: 'sparkles', primary: true, size: 'lg', block: true, className: 'idp-gen', onClick: generate });
    const genWrap = h('div', { class: 'idp-gen-wrap' }, genBtn, hint('自动抠出人像、找到人脸，裁成标准尺寸。第一次会多等几秒'));

    // ---------------------------------------------------------- 微调
    const zoom = slider({ label: '头部大小', min: 80, max: 125, step: 1, unit: '%', value: 100, defaultValue: 100,
      onInput: (v) => reframe('证件照：头部大小', () => ({ zoom: zoom.getValue() }), 'idphoto.zoom') });
    const dy = slider({ label: '上下位置', min: -20, max: 20, step: 1, value: 0, defaultValue: 0, format: (v) => (v > 0 ? `+${v}` : `${v}`),
      onInput: () => reframe('证件照：上下位置', () => ({ dy: dy.getValue() }), 'idphoto.dy') });
    const dx = slider({ label: '左右位置', min: -20, max: 20, step: 1, value: 0, defaultValue: 0, format: (v) => (v > 0 ? `+${v}` : `${v}`),
      onInput: () => reframe('证件照：左右位置', () => ({ dx: dx.getValue() }), 'idphoto.dx') });
    zoom.classList.add('idp-zoom'); dy.classList.add('idp-dy'); dx.classList.add('idp-dx');
    const guides = toggle({ label: '显示参考线', hint: '蓝色虚线标出头顶、下巴的标准位置', value: P.guides,
      onChange: (v) => { P.guides = v; viewport.requestOverlay(); } });
    const resetBtn = button({ text: '复位', icon: 'reset', variant: 'ghost', size: 'sm', className: 'idp-reset', tip: '回到自动摆放的位置',
      onClick: () => reframe('证件照：复位', () => ({ zoom: 100, dx: 0, dy: 0 })) });
    const tuneHint = hint('');
    const secTune = section('微调', null, { right: resetBtn });
    secTune.append(tuneHint, zoom, dy, dx, guides);

    // ---------------------------------------------------------- 保存
    const limitOn = toggle({ label: '限制文件大小', hint: '报名网站常要求不超过多少 KB', value: P.limitOn,
      onChange: (v) => { P.limitOn = v; syncLimit(); scheduleEstimate(); } });
    const limitNum = h('input', { class: 'num-input idp-num', type: 'text', inputmode: 'numeric', value: String(P.limitKB), 'aria-label': '最大文件大小（KB）' });
    limitNum.addEventListener('keydown', (e) => { if (e.key === 'Enter') limitNum.blur(); e.stopPropagation(); });
    limitNum.addEventListener('change', () => {
      const v = Math.round(parseFloat(limitNum.value));
      if (Number.isFinite(v) && v >= 5 && v <= 5000) P.limitKB = v;
      else toast('请填 5～5000 之间的数字', 'warning');
      syncLimit(); scheduleEstimate();
    });
    const limitSeg = segmented({ size: 'sm', block: true, value: null, className: 'idp-kb',
      options: [20, 50, 100, 200].map((v) => ({ value: v, label: `${v}KB` })),
      onChange: (v) => { P.limitKB = v; syncLimit(); scheduleEstimate(); } });
    const limitBox = h('div', { class: 'idp-limit' },
      h('div', { class: 'idp-limit-row' }, h('span', {}, '不超过'), limitNum, h('span', {}, 'KB')), limitSeg);
    const saveBtn = button({ text: '保存证件照', icon: 'save', primary: true, block: true, className: 'idp-save', onClick: saveIdPhoto });
    const saveInfo = h('div', { class: 'idp-save-info' });
    const secSave = section('保存', '按所选尺寸保存高清 JPG，可以直接上传或冲印');
    secSave.append(limitOn, limitBox, saveBtn, saveInfo);

    // ---------------------------------------------------------- 排版打印
    const printBtn = button({ text: '排版打印', icon: 'idphotoPrint', variant: 'secondary', block: true, onClick: openPrint });
    const printHint = hint('');
    const secPrint = section('排版打印');
    secPrint.append(printHint, printBtn);

    const sizeBox = h('div', { class: 'idp-setup' }, secSize, secColor, genWrap);
    el.append(intro, done, sizeBox, secTune, secSave, secPrint);

    // ---------------------------------------------------------- guides overlay
    ctx.onDispose(viewport.addOverlay((o, vp) => {
      const d = store.doc, rec = d?.idphoto;
      if (!rec || !P.guides || isStale(d, rec)) return;
      const W = d.width, H = d.height;
      const a = vp.toScreen(0, 0), b = vp.toScreen(W, H);
      if (b.y - a.y < 120) return;
      const yTop = Math.round(vp.toScreen(0, TOP * H).y) + 0.5, yChin = Math.round(vp.toScreen(0, (TOP + HEAD) * H).y) + 0.5;
      const xc = Math.round(vp.toScreen(W / 2, 0).x) + 0.5;
      o.save();
      o.lineWidth = 1;
      o.setLineDash([6, 4]);
      o.strokeStyle = 'rgba(52, 100, 240, 0.9)';
      o.beginPath();
      o.moveTo(a.x, yTop); o.lineTo(b.x, yTop);
      o.moveTo(a.x, yChin); o.lineTo(b.x, yChin);
      o.moveTo(xc, a.y); o.lineTo(xc, b.y);
      o.stroke();
      o.setLineDash([]);
      o.font = '12px "Microsoft YaHei UI", system-ui, sans-serif';
      o.textBaseline = 'middle';
      for (const [y, t] of [[yTop, '头顶'], [yChin, '下巴']]) {
        const tw = o.measureText(t).width + 12;
        const lx = b.x + 6;
        o.fillStyle = 'rgba(52, 100, 240, 0.92)';
        o.beginPath(); o.roundRect(lx, y - 10, tw, 20, 10); o.fill();
        o.fillStyle = '#fff';
        o.fillText(t, lx + 6, y + 0.5);
      }
      o.restore();
    }));

    // ---------------------------------------------------------- actions
    let asking = false;
    /** Re-frame from the original photo (size / 微调). patch() is read when the commit actually runs. */
    function reframe(label, patch, coalesce) {
      const d = store.doc, rec = d?.idphoto;
      if (!rec) return;
      const run = () => {
        try {
          store.commit(label, (dd) => { Object.assign(dd.idphoto, patch()); applyFrame(dd, dd.idphoto); }, coalesce ? { coalesce } : undefined);
        } catch (err) {
          console.error(err);
          toast('调整失败，请重试', 'error');
          sync();
        }
      };
      if (!isStale(d, rec)) { run(); return; }
      if (asking) return;
      asking = true;
      confirm('生成证件照以后，照片又改动过（比如美颜、修补边缘）。重新调整会从原照片重新裁切，这些改动需要重新做一遍。', {
        title: '重新调整证件照', okText: '继续调整', cancelText: '先不调',
      }).then((ok) => {
        asking = false;
        if (ok && store.doc === d && d.idphoto) { run(); store.endCoalesce(); } else sync();
      });
    }

    function choosePreset(id) {
      const d = store.doc, rec = d?.idphoto;
      if (id === 'custom' && !presetSize('custom', P.custom)) P.custom = { unit: 'mm', w: 25, h: 35 };
      P.preset = id;
      if (rec && (id !== rec.preset || id === 'custom')) {
        const size = presetSize(id, P.custom);
        if (size && !(id === rec.preset && size.w === rec.size.w && size.h === rec.size.h)) {
          reframe(`证件照尺寸：${size.name}`, () => ({ preset: id, size }));
          return;
        }
      }
      sync();
    }

    function changeUnit(u) {
      const c = P.custom;
      if (c.unit === u) return;
      if (u === 'px') P.custom = { unit: 'px', w: mmToPx(c.w), h: mmToPx(c.h) };
      else P.custom = { unit: 'mm', w: r1(pxToMm(c.w)), h: r1(pxToMm(c.h)) };
      syncCustom();
    }
    function commitCustom() {
      const u = P.custom.unit, L = CUSTOM_LIMITS[u];
      const w = parseFloat(cW.value), hh = parseFloat(cH.value);
      const next = { unit: u, w: u === 'px' ? Math.round(w) : r1(w), h: u === 'px' ? Math.round(hh) : r1(hh) };
      if (!presetSize('custom', next)) {
        const unitName = u === 'px' ? '像素' : '毫米';
        toast(Number.isFinite(w) && Number.isFinite(hh) && w >= L.min && w <= L.max && hh >= L.min && hh <= L.max
          ? '宽和高差得太多了，证件照一般是竖着的长方形'
          : `宽和高请填 ${L.min}～${L.max} ${unitName}`, 'warning');
        syncCustom();
        return;
      }
      P.custom = next;
      syncCustom();
      const rec = store.doc?.idphoto;
      if (rec && P.preset === 'custom') {
        const size = presetSize('custom', next);
        if (rec.preset !== 'custom' || size.w !== rec.size.w || size.h !== rec.size.h) reframe('证件照尺寸：自定义', () => ({ preset: 'custom', size }));
      }
    }

    function chooseColor(id, hex, live = false) {
      if (id === 'custom') P.customColor = hex;
      P.color = id;
      const d = store.doc, rec = d?.idphoto;
      if (!rec) { sync(); return; }
      store.commit(id === 'custom' ? '证件照底色：自定义' : `证件照底色：${COLORS.find((c) => c.id === id).name}`, (dd) => {
        dd.bg = { ...dd.bg, ...colorBg(id, P.customColor) };
        dd.cutout = true;
        dd.idphoto.color = id;
        dd.idphoto.customColor = P.customColor;
      }, live ? { coalesce: 'idphoto.color' } : undefined);
    }

    async function generate() {
      const d0 = store.doc;
      if (!d0 || isCutoutRunning() || d0.idphoto) return;
      const size = presetSize(P.preset, P.custom);
      if (!size) { toast('自定义尺寸不对，请先改好宽和高', 'warning'); return; }
      const src = d0.source;
      const b = busy('正在找人脸…');
      let g, nFaces = 0;
      try {
        await nextFrame();
        const r = await api.faces(await canvasToBlob(src, 'image/jpeg', 0.92));
        if (store.doc !== d0 || d0.source !== src) return;
        const faces = (r.faces || []).slice().sort((p, q) => q.w * q.h - p.w * p.h);
        nFaces = faces.length;
        if (!nFaces) {
          toast('没有找到人脸。请换一张正脸、光线清楚的照片', 'warning', { duration: 6000 });
          return;
        }
        const k = r.width ? src.width / r.width : 1;
        const f = faces[0];
        const fs = { x: f.x * k, y: f.y * k, w: f.w * k, h: f.h * k, landmarks: (f.landmarks || []).map(([x, y]) => [x * k, y * k]) };
        if (fs.h < MIN_FACE) {
          toast('照片里的人脸太小了，请换一张离镜头近一些的照片', 'warning', { duration: 6000 });
          return;
        }
        g = faceGeometry(fs);
        // refuse faces that would have to be blown up a lot (blurry mess), before spending time on the cutout
        const sEst = (HEAD * size.h) / (2.15 * Math.max(1, g.chin - g.eyeY));
        if (sEst > 2.6) {
          toast('照片里的人脸太小了，做成证件照会很模糊。请换一张离镜头近一些的照片', 'warning', { duration: 6000 });
          return;
        }
        const [re, le] = fs.landmarks;
        const turned = re && le && (Math.hypot(le[0] - re[0], le[1] - re[1]) / fs.w < 0.3 || Math.atan2(Math.abs(le[1] - re[1]), Math.abs(le[0] - re[0]) || 1) > 0.21);
        b.update('正在生成证件照…');
        const build = (d) => {
          try {
            makeIdPhoto(d, { ...g, ...headFromMask(d.mask, g) }, { size, color: P.color, customColor: P.customColor });
          } catch (err) {
            console.error(err);
            throw new Error('生成证件照失败，请换一张照片试试');
          }
        };
        let ok;
        if (d0.cutout && d0.mask) {
          try { store.commit('生成证件照', build); ok = true; } catch (err) { toast(err.message, 'error'); ok = false; }
        } else {
          ok = await runCutout({ mode: 'portrait', then: build, label: '生成证件照' });
        }
        const rec = store.doc?.idphoto;
        if (!ok || !rec) return;
        const notes = [];
        if (nFaces > 1) notes.push(`照片里有 ${nFaces} 张脸，已按最大的那张来做`);
        if (turned) notes.push('脸有点侧或歪，证件照最好用正对镜头的照片');
        if (rec.s > 1.3) notes.push('照片里的人脸比较小，证件照可能有点模糊，换一张近一点拍的会更清楚');
        if (notes.length) toast(notes.join('；'), 'warning', { duration: 8000 });
        else toast(`${size.name}证件照做好了，不满意可以在「微调」里拖一拖`, 'success');
      } catch (err) {
        toast(err.message || '生成失败，请重试', 'error');
      } finally {
        b.done();
      }
    }

    async function saveIdPhoto() {
      const d = store.doc;
      if (!d?.idphoto) return;
      // 后台美颜可能在保存期间完成；编码内容、文件名、dpi 都属于点击时这一版。
      const snapshot = cloneData(d), rec = snapshot.idphoto;
      const savedVersion = store.version, savedKey = estimateKey(d);
      const limit = P.limitOn ? P.limitKB : null;
      const b = busy('正在保存证件照…');
      try {
        await nextFrame();
        await prewarm(snapshot, 1);
        const c = exportCanvas(snapshot, { flattenColor: '#ffffff' });
        if (limit) b.update('正在压缩到合适大小…');
        const r = await encodeJpeg(c, limit ? limit * 1000 - 64 : null);
        if (!r.ok) {
          toast(`压到最低画质也有 ${kbText(r.blob.size)}，超过了 ${limit} KB。请把限制调大一点`, 'warning', { duration: 7000 });
          return;
        }
        b.update('正在写入文件…');
        const name = `${fileBase(snapshot)}_证件照_${rec.size.file || rec.size.name}.jpg`;
        const res = await api.save(r.blob, name, { dpi: rec.size.dpi || DPI });
        if (store.doc === d && store.version === savedVersion) store.markSaved();
        lastSaved = { name: baseName(res.path), bytes: r.blob.size, quality: r.quality, key: savedKey };
        renderSaveInfo();
        toast(`已保存到「输出」文件夹：${baseName(res.path)}（${kbText(r.blob.size)}）`, 'success', {
          action: { text: '打开文件夹', onClick: () => api.openOutput(res.path).catch((e) => toast(e.message, 'error')) },
        });
        store.emit('saved', res);
      } catch (err) {
        toast(err.message || '保存失败，请重试', 'error');
      } finally {
        b.done();
      }
    }

    async function openPrint() {
      const d = store.doc, rec = d?.idphoto;
      if (!rec) return;
      let photo;
      const b = busy('正在排版…');
      try {
        await nextFrame();
        await prewarm(d, 1);
        photo = exportCanvas(d, { flattenColor: '#ffffff' });
      } catch (err) {
        console.error(err);
        toast('排版失败，请重试', 'error');
        return;
      } finally { b.done(); }
      const size = rec.size;
      let paper = P.paper in PAPERS ? P.paper : '6';
      let sheet = null, layout = null;
      const view = h('div', { class: 'idp-sheet-view' });
      const info = h('div', { class: 'idp-sheet-info' });
      const draw = () => {
        layout = layoutSheet(paper, size.mm);
        sheet = layout.count ? renderSheet(photo, layout) : null;
        view.innerHTML = '';
        if (sheet) {
          sheet.className = 'idp-sheet-canvas';
          view.append(sheet);
          info.innerHTML = '';
          info.append(h('b', {}, `共 ${layout.count} 张${size.name}照`),
            ` · ${PAPERS[paper].name}相纸 ${layout.sheetW}×${layout.sheetH} 像素 · 300 dpi。冲印后沿浅灰色线剪开`);
        } else {
          view.append(h('div', { class: 'idp-sheet-empty' }, '照片太大，这张相纸放不下'));
          info.textContent = '请换大一点的相纸，或把尺寸改小一些';
        }
        saveSheetBtn.disabled = !sheet;
      };
      const seg = segmented({ block: true, value: paper, className: 'idp-paper',
        options: Object.entries(PAPERS).sort((a, c) => c[0] - a[0]).map(([id, p]) => ({ value: id, label: `${p.name}相纸（${p.mm[0]}×${p.mm[1]} 毫米）` })),
        onChange: (v) => { paper = v; P.paper = v; draw(); } });
      const m = modal({
        title: `排版打印 · ${size.name}`, width: 720,
        content: h('div', { class: 'idp-print' }, seg, view, info),
        buttons: [
          { text: '关闭', value: false },
          { text: '保存排版图', primary: true, icon: 'save', onClick: (close) => { const s = sheet, lp = layout; close(true); saveSheet(s, lp, d, rec); } },
        ],
      });
      const saveSheetBtn = [...m.el.querySelectorAll('.modal-foot .btn')].pop();
      draw();
    }

    async function saveSheet(sheet, layout, d, rec) {
      if (!sheet) return;
      const b = busy('正在保存排版图…');
      try {
        await nextFrame();
        const blob = await canvasToBlob(sheet, 'image/jpeg', 0.95);
        const name = `${fileBase(d)}_证件照_${rec.size.file || rec.size.name}_${layout.paper}寸排版.jpg`;
        const res = await api.save(blob, name, { dpi: DPI });
        toast(`排版图已保存（${layout.count} 张），拿去冲印 ${PAPERS[layout.paper].name}照片就行`, 'success', {
          action: { text: '打开文件夹', onClick: () => api.openOutput(res.path).catch((e) => toast(e.message, 'error')) },
        });
      } catch (err) {
        toast(err.message || '保存失败，请重试', 'error');
      } finally {
        b.done();
      }
    }

    // ---------------------------------------------------------- estimated file size
    let estTimer = 0, est = null, lastSaved = null, estSeq = 0;
    const estimateKey = (d) => `${uidOf(d.source)}.${d.source.__v || 0}|${uidOf(d.mask)}.${d.mask?.__v || 0}|${store.version}`;
    function scheduleEstimate() {
      clearTimeout(estTimer);
      renderSaveInfo();
      const d = store.doc;
      if (!d?.idphoto) return;
      estTimer = setTimeout(async () => {
        const seq = ++estSeq;
        const key = estimateKey(d);
        try {
          await prewarm(d, 1);
          if (store.doc !== d || seq !== estSeq) return;
          const blob = await canvasToBlob(exportCanvas(d, { flattenColor: '#ffffff' }), 'image/jpeg', 0.95);
          if (seq !== estSeq) return;
          est = { key, bytes: blob.size };
          renderSaveInfo();
        } catch { /* estimate only */ }
      }, 450);
    }
    ctx.onDispose(() => { clearTimeout(estTimer); estSeq++; });
    function renderSaveInfo() {
      const d = store.doc;
      saveInfo.innerHTML = '';
      if (!d?.idphoto) return;
      const key = estimateKey(d);
      if (lastSaved && lastSaved.key === key) {
        saveInfo.append(h('span', { class: 'idp-ok', html: icon('check', 14) }),
          h('span', {}, `已保存 ${kbText(lastSaved.bytes)}${lastSaved.quality < 95 ? `（画质 ${lastSaved.quality}%）` : ''}`));
        return;
      }
      if (!est || est.key !== key) { saveInfo.append(h('span', { class: 'idp-muted' }, '正在估算文件大小…')); return; }
      const over = P.limitOn && est.bytes > P.limitKB * 1000 - 64;
      saveInfo.append(h('span', { class: 'idp-muted' }, `高画质约 ${kbText(est.bytes)}`),
        over ? h('span', { class: 'idp-muted' }, `，保存时会压缩到 ${P.limitKB} KB 以内`) : null);
    }

    // ---------------------------------------------------------- sync
    function syncCustom() {
      const c = P.custom;
      cUnit.setValue(c.unit);
      if (document.activeElement !== cW) cW.value = String(c.w);
      if (document.activeElement !== cH) cH.value = String(c.h);
      const s = presetSize('custom', c);
      cInfo.textContent = s ? (c.unit === 'px' ? `约 ${r1(s.mm[0])}×${r1(s.mm[1])} 毫米（300 dpi）` : `= ${s.w}×${s.h} 像素（300 dpi）`) : '';
    }
    function syncLimit() {
      limitOn.setValue(P.limitOn);
      limitBox.hidden = !P.limitOn;
      if (document.activeElement !== limitNum) limitNum.value = String(P.limitKB);
      limitSeg.setValue([20, 50, 100, 200].includes(P.limitKB) ? P.limitKB : null);
    }
    function sync() {
      const d = store.doc;
      if (!d) return;
      const rec = d.idphoto || null;
      const presetId = rec ? rec.preset : P.preset;
      for (const [id, b] of cards) { const on = id === presetId; b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); }
      if (rec?.preset === 'custom' && rec.size) {
        const u = P.custom.unit;
        if (!(presetSize('custom', P.custom)?.w === rec.size.w && presetSize('custom', P.custom)?.h === rec.size.h)) {
          P.custom = u === 'px' ? { unit: 'px', w: rec.size.w, h: rec.size.h } : { unit: 'mm', w: r1(rec.size.mm[0]), h: r1(rec.size.mm[1]) };
        }
      }
      customBox.hidden = presetId !== 'custom';
      syncCustom();
      const colorId = rec ? rec.color : P.color;
      const custom = (rec ? rec.customColor : P.customColor) || P.customColor;
      for (const [id, t] of tiles) {
        const on = id === colorId;
        t.b.classList.toggle('on', on);
        t.b.setAttribute('aria-checked', on ? 'true' : 'false');
      }
      const ct = tiles.get('custom');
      ct.sw.classList.toggle('has', colorId === 'custom');
      ct.sw.style.setProperty('--c', custom);
      if (/^#[0-9a-f]{6}$/i.test(custom)) picker.value = custom;

      intro.hidden = !!rec;
      done.hidden = !rec;
      genWrap.hidden = !!rec;
      if (rec) {
        doneTitle.textContent = `${rec.size.name}证件照已生成`;
        doneSub.textContent = sizeLine(rec.size);
      }
      genBtn.setDisabled(isCutoutRunning());
      const on = !!rec;
      for (const s of [zoom, dy, dx]) s.setDisabled(!on);
      zoom.setValue(rec?.zoom ?? 100); dy.setValue(rec?.dy ?? 0); dx.setValue(rec?.dx ?? 0);
      resetBtn.setDisabled(!on || ((rec.zoom ?? 100) === 100 && !rec.dx && !rec.dy));
      guides.setDisabled(!on);
      guides.setValue(P.guides);
      tuneHint.textContent = on ? '头太大、太小或没居中，拖一拖就好。数值为正：往下 / 往右' : '生成证件照以后，可以在这里调整头部大小和位置';
      secTune.classList.toggle('idp-off', !on);
      limitOn.setDisabled(!on);
      limitNum.disabled = !on;
      limitSeg.setDisabled(!on);
      saveBtn.setDisabled(!on);
      printBtn.setDisabled(!on);
      secSave.classList.toggle('idp-off', !on);
      secPrint.classList.toggle('idp-off', !on);
      syncLimit();
      const lay = layoutSheet(P.paper in PAPERS ? P.paper : '6', (rec ? rec.size : presetSize(P.preset, P.custom) || presetSize('one')).mm);
      printHint.textContent = on
        ? (lay.count ? `一张 ${PAPERS[lay.paper].name}相纸能放 ${lay.count} 张，带裁剪线，拿去冲印就行` : '这个尺寸太大，相纸放不下')
        : '生成证件照以后，可以排到 6 寸 / 5 寸相纸上打印';
      scheduleEstimate();
      viewport.requestOverlay();
    }
    ctx.on('doc:changed', (p) => { if (p?.reason !== 'bump') sync(); });
    ctx.on('cutout:running', () => genBtn.setDisabled(isCutoutRunning()));
    sync();
  },
});
