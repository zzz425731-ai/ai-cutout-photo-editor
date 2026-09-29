// layers/render-layers.js — draws text / emoji / image layers on top of the document.
// Owned by the text/sticker track. Preview and export use exactly the same code path (only `scale` differs).
//
// Layer (common): { id, type:'text'|'emoji'|'image', x, y /* centre, doc px */, rotation /* rad */,
//                   scale /* uniform */, sy? /* extra vertical stretch factor, default 1 */,
//                   flipX? /* mirror horizontally */, opacity, hidden:false }
//   text:  { text, fontSize, fontFamily /* CSS stack */, color, gradient?:{on,color2} /* top→bottom fill */,
//            bold, italic, align:'left'|'center'|'right', lineHeight /* × fontSize */, letterSpacing /* local px */,
//            vertical? /* 竖排: lines become columns, right → left */,
//            stroke:{on,width,color}, shadow:{on,color,opacity?,blur,dx,dy}, bg:{on,color,opacity,padding,radius,border?} }
//          All lengths are local px (multiplied by `scale`). New layers use fontSize 100, so every other length
//          reads as "% of the font size"; `scale` sets the on-image size (字号 = fontSize × scale).
//   emoji: { char, size }                 (glyph box ≈ size × size local px)
//   image: { canvas, width, height }      (base size in local px; the canvas is kept by reference)
//
// API:
//   drawLayers(ctx, doc, scale)          draw all visible layers (ctx in output px; doc px × scale)
//   drawLayer(ctx, layer, scale)         honours the ctx's current transform
//   layerSize(L) → {w,h}                 local, unscaled box (centred on x,y)
//   layerScale(L) → {sx,sy}
//   layerCorners(L) → [[x,y]×4]          doc px, clockwise from the local top-left
//   layerBounds(L) → {x,y,w,h}           axis-aligned doc-px bounds of the box
//   docToLocal(L, x, y) / localToDoc(L, lx, ly)   (local = unscaled layer px, origin at the centre)
//   hitTestLayers(doc, x, y, pad=0) → layer|null  topmost visible layer containing the doc point
//   layerLabel(L) → short Chinese name for layer lists
//   createTextLayer(props) / createEmojiLayer(props) / createImageLayer(canvas, props) / newLayerId()
//   DEFAULT_FONT, EMOJI_FONT, fontStack(family)

export const DEFAULT_FONT = '"Microsoft YaHei UI","Microsoft YaHei","PingFang SC",system-ui,sans-serif';
export const EMOJI_FONT = '"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';

/** CSS font stack for a family name, falling back to the UI font (so Chinese always renders). */
export function fontStack(family) {
  if (!family) return DEFAULT_FONT;
  return `"${String(family).replace(/"/g, '')}",${DEFAULT_FONT}`;
}

let idCounter = 1;
export const newLayerId = () => `L${Date.now().toString(36)}${(idCounter++).toString(36)}`;

let measureCtx = null;
function mctx() {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  return measureCtx;
}
const HAS_LS = (() => { try { const c = document.createElement('canvas').getContext('2d'); return 'letterSpacing' in c; } catch { return false; } })();
function setLS(ctx, px) { if (HAS_LS) ctx.letterSpacing = `${px || 0}px`; }

const clamp01 = (v) => Math.max(0, Math.min(1, v));

function textFont(L) {
  return `${L.italic ? 'italic ' : ''}${L.bold ? '700 ' : '400 '}${L.fontSize || 100}px ${L.fontFamily || DEFAULT_FONT}`;
}

/** Characters rotated 90° in vertical text (brackets, dashes, ellipsis, tilde, colons). */
const V_ROTATE = new Set([...'（）()《》〈〉【】[]{}「」『』〔〕—–-_…～~<>：:；;|｜']);
/** Characters moved to the upper-right of their cell in vertical text (comma / full stop). */
const V_SHIFT = new Set([...'，。、．,.']);

// ---------------------------------------------------------------- text layout (cached)
const layoutCache = new Map();
function textLayout(L) {
  const fs = L.fontSize || 100;
  const lh = fs * (L.lineHeight || 1.25);
  const ls = L.letterSpacing || 0;
  const vertical = !!L.vertical;
  const text = String(L.text ?? '');
  const font = textFont(L);
  const key = `${font}|${ls}|${lh}|${vertical ? 1 : 0}|${text}`;
  let lay = layoutCache.get(key);
  if (lay) return lay;
  const lines = text.split('\n');
  if (vertical) {
    const cols = lines.map((s) => Array.from(s));
    const heights = cols.map((c) => (c.length ? c.length * fs + (c.length - 1) * ls : 0));
    const w = Math.max(lh, cols.length * lh);
    const h = Math.max(fs, ...heights);
    lay = { vertical, lines, cols, heights, w, h, lh, fs, ls, font };
  } else {
    const ctx = mctx();
    ctx.font = font;
    setLS(ctx, ls);
    // measureText includes the spacing after the last glyph → remove it so alignment is exact
    const widths = lines.map((s) => (s ? Math.max(0, ctx.measureText(s).width - (HAS_LS ? ls : 0)) : 0));
    setLS(ctx, 0);
    const w = Math.max(fs * 0.5, ...widths);
    const h = Math.max(lh, lines.length * lh);
    lay = { vertical, lines, widths, w, h, lh, fs, ls, font };
  }
  if (layoutCache.size > 300) layoutCache.clear();
  layoutCache.set(key, lay);
  return lay;
}

/** Extra space around the text block (padding / stroke / italic overhang). */
function textExtents(L, lay) {
  const pad = L.bg?.on ? Math.max(0, L.bg.padding ?? 16) + Math.max(0, L.bg.border || 0) / 2 : 0;
  const st = L.stroke?.on ? Math.max(0, L.stroke.width || 0) : 0;
  const it = L.italic && !lay.vertical ? lay.fs * 0.08 : 0;
  return { ex: Math.max(pad, st) + it, ey: Math.max(pad, st) };
}

// ---------------------------------------------------------------- emoji metrics (cached per char)
const emojiCache = new Map();
function emojiMetrics(ch) {
  let m = emojiCache.get(ch);
  if (m) return m;
  const ctx = mctx();
  ctx.font = `100px ${EMOJI_FONT}`;
  setLS(ctx, 0);
  const t = ctx.measureText(ch || '😀');
  let l = t.actualBoundingBoxLeft, r = t.actualBoundingBoxRight, a = t.actualBoundingBoxAscent, d = t.actualBoundingBoxDescent;
  if (!(r + l > 1) || !(a + d > 1)) { l = 0; r = t.width || 100; a = 88; d = 12; }
  m = { l, r, a, d, w: l + r, h: a + d };
  if (emojiCache.size > 500) emojiCache.clear();
  emojiCache.set(ch, m);
  return m;
}

// ---------------------------------------------------------------- geometry
export function layerSize(L) {
  switch (L.type) {
    case 'text': {
      const lay = textLayout(L);
      const { ex, ey } = textExtents(L, lay);
      return { w: lay.w + ex * 2, h: lay.h + ey * 2 };
    }
    case 'emoji': {
      const m = emojiMetrics(L.char);
      const k = (L.size || 100) / 100;
      const pad = (L.size || 100) * 0.04;
      return { w: m.w * k + pad * 2, h: m.h * k + pad * 2 };
    }
    case 'image':
      return { w: L.width || L.canvas?.width || 1, h: L.height || L.canvas?.height || 1 };
    default:
      return { w: 1, h: 1 };
  }
}

export function layerScale(L) {
  const s = L.scale ?? 1;
  return { sx: s, sy: s * (L.sy ?? 1) };
}

export function localToDoc(L, lx, ly) {
  const { sx, sy } = layerScale(L);
  const c = Math.cos(L.rotation || 0), s = Math.sin(L.rotation || 0);
  const px = lx * sx, py = ly * sy;
  return { x: L.x + px * c - py * s, y: L.y + px * s + py * c };
}

export function docToLocal(L, x, y) {
  const { sx, sy } = layerScale(L);
  const c = Math.cos(L.rotation || 0), s = Math.sin(L.rotation || 0);
  const dx = x - L.x, dy = y - L.y;
  return { x: (dx * c + dy * s) / (sx || 1e-9), y: (-dx * s + dy * c) / (sy || 1e-9) };
}

export function layerCorners(L) {
  const { w, h } = layerSize(L);
  return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([px, py]) => {
    const p = localToDoc(L, px, py);
    return [p.x, p.y];
  });
}

export function layerBounds(L) {
  const cs = layerCorners(L);
  const xs = cs.map((p) => p[0]), ys = cs.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Topmost visible layer whose (rotated) box contains the doc point. pad = extra doc px tolerance. */
export function hitTestLayers(doc, x, y, pad = 0) {
  const layers = doc?.layers || [];
  for (let i = layers.length - 1; i >= 0; i--) {
    const L = layers[i];
    if (L.hidden) continue;
    if (hitLayer(L, x, y, pad)) return L;
  }
  return null;
}
export function hitLayer(L, x, y, pad = 0) {
  const { w, h } = layerSize(L);
  const { sx, sy } = layerScale(L);
  const p = docToLocal(L, x, y);
  return Math.abs(p.x) <= w / 2 + pad / Math.abs(sx || 1) && Math.abs(p.y) <= h / 2 + pad / Math.abs(sy || 1);
}

export function layerLabel(L) {
  if (!L) return '';
  if (L.type === 'text') {
    const s = String(L.text || '').split('\n').map((x) => x.trim()).filter(Boolean).join(' ');
    return s ? (s.length > 14 ? `${s.slice(0, 14)}…` : s) : '（空白文字）';
  }
  if (L.type === 'emoji') return `贴纸 ${L.char || ''}`;
  if (L.type === 'image') return L.name || '图片';
  return '图层';
}

// ---------------------------------------------------------------- colours / paths
function hexA(color, a = 1) {
  const s0 = String(color || '#000000').trim();
  if (!s0.startsWith('#')) {
    if (a >= 1) return s0;
    const m = s0.match(/rgba?\(([^)]+)\)/i);
    if (m) { const p = m[1].split(',').map((v) => parseFloat(v)); return `rgba(${p[0] | 0},${p[1] | 0},${p[2] | 0},${(p.length > 3 ? p[3] : 1) * a})`; }
    return s0;
  }
  let s = s0.slice(1);
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const n = parseInt(s.slice(0, 6), 16) || 0;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${clamp01(a)})`;
}

function roundRectPath(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------------------------------------------------------------- text drawing (local coords)
function drawTextBg(ctx, L, lay) {
  if (!L.bg?.on) return;
  const pad = Math.max(0, L.bg.padding ?? 16);
  const x = -lay.w / 2 - pad, y = -lay.h / 2 - pad, w = lay.w + pad * 2, h = lay.h + pad * 2;
  const op = L.bg.opacity ?? 0.5;
  if (op > 0) {
    ctx.fillStyle = hexA(L.bg.color || '#000000', op);
    roundRectPath(ctx, x, y, w, h, L.bg.radius ?? 12);
    ctx.fill();
  }
  const bw = Math.max(0, L.bg.border || 0);
  if (bw > 0) {
    ctx.lineWidth = bw;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = L.color || '#ffffff';
    roundRectPath(ctx, x, y, w, h, L.bg.radius ?? 12);
    ctx.stroke();
  }
}

/** Calls fn(char|string, x, y, rotate?, cellTop?) for every run to draw, in local coords. */
function eachRun(L, lay, fn) {
  const align = L.align || 'center';
  if (lay.vertical) {
    const { fs, ls, lh } = lay;
    lay.cols.forEach((chars, i) => {
      const cx = lay.w / 2 - lh / 2 - i * lh;
      const colH = lay.heights[i];
      const top = align === 'left' ? -lay.h / 2 : align === 'right' ? lay.h / 2 - colH : -colH / 2;
      chars.forEach((ch, j) => fn(ch, cx, top + j * (fs + ls) + fs / 2, i, top));
    });
  } else {
    const y0 = -lay.h / 2 + lay.lh / 2;
    lay.lines.forEach((s, i) => {
      if (!s) return;
      const w = lay.widths[i];
      const x = align === 'left' ? -lay.w / 2 : align === 'right' ? lay.w / 2 - w : -w / 2;
      fn(s, x, y0 + i * lay.lh, i);
    });
  }
}

function drawGlyphs(ctx, L, lay, mode /* 'stroke'|'fill' */) {
  const { fs } = lay;
  ctx.font = lay.font;
  ctx.textBaseline = 'middle';
  if (lay.vertical) {
    setLS(ctx, 0);
    ctx.textAlign = 'center';
    eachRun(L, lay, (ch, x, y) => {
      const rot = V_ROTATE.has(ch), shift = V_SHIFT.has(ch);
      if (rot || shift) {
        ctx.save();
        ctx.translate(x + (shift ? fs * 0.52 : 0), y - (shift ? fs * 0.5 : 0));
        if (rot) ctx.rotate(Math.PI / 2);
        if (mode === 'stroke') ctx.strokeText(ch, 0, 0); else ctx.fillText(ch, 0, 0);
        ctx.restore();
      } else if (mode === 'stroke') ctx.strokeText(ch, x, y);
      else ctx.fillText(ch, x, y);
    });
  } else {
    setLS(ctx, lay.ls);
    ctx.textAlign = 'left';
    eachRun(L, lay, (s, x, y) => { if (mode === 'stroke') ctx.strokeText(s, x, y); else ctx.fillText(s, x, y); });
    setLS(ctx, 0);
  }
}

function fillStyleFor(ctx, L, lay) {
  const c1 = L.color || '#ffffff';
  if (!L.gradient?.on || !L.gradient.color2) return c1;
  const g = ctx.createLinearGradient(0, -lay.h / 2, 0, lay.h / 2);
  if (lay.vertical || lay.lines.length <= 1) {
    const t = lay.vertical ? 0 : Math.max(0, (lay.h - lay.fs) / 2 / lay.h);
    g.addColorStop(t, c1); g.addColorStop(1 - t, L.gradient.color2);
    return g;
  }
  // one gradient per line: repeat the stops inside every line box
  const n = lay.lines.length;
  for (let i = 0; i < n; i++) {
    const a = i / n, b = (i + 1) / n, pad = (b - a) * (1 - lay.fs / lay.lh) / 2;
    g.addColorStop(Math.min(1, a + pad), c1);
    g.addColorStop(Math.max(0, b - pad - 1e-4), L.gradient.color2);
  }
  return g;
}

function drawTextGlyphs(ctx, L, lay) {
  if (L.stroke?.on && L.stroke.width > 0) {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.miterLimit = 2;
    ctx.strokeStyle = L.stroke.color || '#000000';
    ctx.lineWidth = L.stroke.width * 2; // stroke drawn behind the fill → only the outer half shows
    drawGlyphs(ctx, L, lay, 'stroke');
  }
  ctx.fillStyle = fillStyleFor(ctx, L, lay);
  drawGlyphs(ctx, L, lay, 'fill');
}

// ---------------------------------------------------------------- scratch canvases for compositing
const scratch = [null, null];
function scratchCanvas(i, w, h) {
  let c = scratch[i];
  if (!c) c = scratch[i] = document.createElement('canvas');
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } else c.getContext('2d').clearRect(0, 0, w, h);
  return c;
}
function releaseScratch() {
  for (const c of scratch) if (c && c.width * c.height > 1.5e6) { c.width = 1; c.height = 1; }
}

/** Local → output-pixel transform of a layer (current ctx transform × layer transform). */
function layerMatrix(base, L, scale) {
  const { sx, sy } = layerScale(L);
  const m = DOMMatrix.fromMatrix(base);
  m.translateSelf(L.x * scale, L.y * scale);
  m.rotateSelf(((L.rotation || 0) * 180) / Math.PI);
  m.scaleSelf(sx * scale * (L.flipX ? -1 : 1), sy * scale);
  return m;
}

function drawTextLayer(ctx, L, scale) {
  const lay = textLayout(L);
  const opacity = clamp01(L.opacity ?? 1);
  const base = ctx.getTransform();
  const M = layerMatrix(base, L, scale);
  const sh = L.shadow;
  const shadowOn = !!(sh?.on && (sh.opacity ?? 1) > 0 && ((sh.blur || 0) > 0 || sh.dx || sh.dy));
  const layered = (L.stroke?.on && L.stroke.width > 0) || L.bg?.on;
  if (!shadowOn && (opacity >= 1 || !layered)) {
    ctx.save();
    ctx.setTransform(M);
    ctx.globalAlpha *= opacity;
    drawTextBg(ctx, L, lay);
    drawTextGlyphs(ctx, L, lay);
    ctx.restore();
    return;
  }
  // Composite in output space: bg + (text with its shadow) → one bitmap → drawn with the layer opacity.
  // Pixel-aligned with the target, so it stays as crisp as direct drawing.
  const k = Math.hypot(M.a, M.b) || 1; // output px per local px
  const { w, h } = layerSize(L);
  const glyphPad = lay.fs * 0.35;
  const hw = w / 2 + glyphPad, hh = h / 2 + glyphPad;
  const pts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => M.transformPoint(new DOMPoint(x, y)));
  const shBlur = shadowOn ? Math.max(0, sh.blur || 0) * k : 0;
  const shDx = shadowOn ? (sh.dx || 0) * k : 0, shDy = shadowOn ? (sh.dy || 0) * k : 0;
  let x0 = Math.min(...pts.map((p) => p.x)), x1 = Math.max(...pts.map((p) => p.x));
  let y0 = Math.min(...pts.map((p) => p.y)), y1 = Math.max(...pts.map((p) => p.y));
  if (shadowOn) {
    x0 = Math.min(x0, x0 + shDx - shBlur); x1 = Math.max(x1, x1 + shDx + shBlur);
    y0 = Math.min(y0, y0 + shDy - shBlur); y1 = Math.max(y1, y1 + shDy + shBlur);
  }
  // clip to the target (in output px; the base transform maps to it)
  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  const bx = Math.max(0, Math.floor(x0)), by = Math.max(0, Math.floor(y0));
  const bw = Math.min(cw, Math.ceil(x1)) - bx, bh = Math.min(ch, Math.ceil(y1)) - by;
  if (bw <= 0 || bh <= 0) return;
  const O = new DOMMatrix().translateSelf(-bx, -by).multiplySelf(M);
  const off = scratchCanvas(0, bw, bh);
  const oc = off.getContext('2d');
  oc.setTransform(O);
  drawTextBg(oc, L, lay);
  if (shadowOn) {
    const t = scratchCanvas(1, bw, bh);
    const tc = t.getContext('2d');
    tc.setTransform(O);
    drawTextGlyphs(tc, L, lay);
    tc.setTransform(1, 0, 0, 1, 0, 0);
    oc.setTransform(1, 0, 0, 1, 0, 0);
    oc.save();
    oc.shadowColor = hexA(sh.color || '#000000', sh.opacity ?? 1);
    oc.shadowBlur = shBlur;
    oc.shadowOffsetX = shDx;
    oc.shadowOffsetY = shDy;
    oc.drawImage(t, 0, 0);
    oc.restore();
  } else {
    drawTextGlyphs(oc, L, lay);
  }
  oc.setTransform(1, 0, 0, 1, 0, 0);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha *= opacity;
  ctx.drawImage(off, bx, by);
  ctx.restore();
}

export function drawLayer(ctx, L, scale = 1) {
  if (!L || L.hidden) return;
  if ((L.opacity ?? 1) <= 0) return;
  if (L.type === 'text') { drawTextLayer(ctx, L, scale); return; }
  ctx.save();
  ctx.setTransform(layerMatrix(ctx.getTransform(), L, scale));
  ctx.globalAlpha *= clamp01(L.opacity ?? 1);
  if (L.type === 'emoji') {
    const size = L.size || 100;
    const m = emojiMetrics(L.char);
    const k = size / 100;
    ctx.font = `${size}px ${EMOJI_FONT}`;
    setLS(ctx, 0);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#000000';
    ctx.fillText(L.char || '😀', -((m.r - m.l) / 2) * k, ((m.a - m.d) / 2) * k);
  } else if (L.type === 'image' && L.canvas) {
    const { w, h } = layerSize(L);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(L.canvas, -w / 2, -h / 2, w, h);
  }
  ctx.restore();
}

export function drawLayers(ctx, doc, scale = 1) {
  for (const L of doc.layers || []) {
    try { drawLayer(ctx, L, scale); } catch (err) { console.error('[layers] draw failed:', err); }
  }
  releaseScratch();
}

// ---------------------------------------------------------------- factories
export function createTextLayer(props = {}) {
  return {
    id: newLayerId(), type: 'text', x: 0, y: 0, rotation: 0, scale: 1, opacity: 1, hidden: false,
    text: '输入文字', fontSize: 100, fontFamily: DEFAULT_FONT, color: '#ffffff', bold: true, italic: false,
    align: 'center', lineHeight: 1.25, letterSpacing: 0, vertical: false,
    gradient: { on: false, color2: '#ffb300' },
    stroke: { on: true, width: 6, color: '#1d2129' },
    shadow: { on: false, color: '#000000', opacity: 0.45, blur: 12, dx: 0, dy: 5 },
    bg: { on: false, color: '#000000', opacity: 0.6, padding: 18, radius: 14, border: 0 },
    ...props,
  };
}
export function createEmojiLayer(props = {}) {
  return { id: newLayerId(), type: 'emoji', x: 0, y: 0, rotation: 0, scale: 1, opacity: 1, hidden: false, flipX: false, char: '😀', size: 100, ...props };
}
export function createImageLayer(canvas, props = {}) {
  return { id: newLayerId(), type: 'image', x: 0, y: 0, rotation: 0, scale: 1, opacity: 1, hidden: false, flipX: false, canvas, width: canvas.width, height: canvas.height, ...props };
}
