// tools/layer-tool.js — select / move / scale / rotate text, sticker and image layers on the canvas.
//   setTool('layer')  (the 文字 and 贴纸 panels activate it in mount)
//
// Mouse: click a layer to select it · drag to move (snaps to the canvas centre lines, Alt = no snapping) ·
//        corner handles scale (Shift = free / stretch) · round handle above the box rotates (Shift = 15° steps) ·
//        double-click a text layer → its text box in the 文字 panel gets focus · click empty canvas → deselect
//        (dragging there pans the view).
// Keys:  arrows nudge (Shift ×10) · Delete removes · Ctrl+D duplicates · Esc deselects.
// Every drag is ONE undo step (commits share a per-drag coalesce key; a keep-alive refreshes it while the
// pointer rests). Handles are drawn in screen space, so they stay crisp at any zoom.
//
// Also exports the layer operations shared by the panels:
//   selectedLayer(), selectLayer(id), findLayer(doc, id), updateLayer(id, label, fn(L, doc), coalesceKey?),
//   addLayer(L, label), deleteLayer(id), duplicateLayer(id), moveLayerOrder(id, dir), toggleLayerHidden(id),
//   placementPoint() → {x,y} (visible centre of the image, cascaded so new layers don't stack exactly)

import { store, cloneData } from '../core/store.js';
import { registerTool, currentTool } from '../core/tools.js';
import { viewport } from '../core/viewport.js';
import { showPanel, currentPanelId } from '../core/panels.js';
import { layerSize, layerCorners, layerScale, hitLayer, hitTestLayers, newLayerId, layerLabel } from '../layers/render-layers.js';

const TOOL_ID = 'layer';
const HANDLE_R = 5.5;      // corner handle radius (screen px)
const HANDLE_HIT = 11;     // corner / rotate hit radius
const ROT_DIST = 28;       // rotate handle distance above the box
const SNAP_PX = 7;         // snapping distance (screen px)
const ACCENT = '#3464f0';
const GUIDE = '#ff2d87';

/** Overlay redraw, only once the stage exists (the unit-test page imports this module without a stage). */
function redraw() { if (viewport.width) viewport.requestOverlay(); }

// ---------------------------------------------------------------- layer operations (shared)
export function findLayer(doc, id) { return id && doc?.layers ? doc.layers.find((l) => l.id === id) || null : null; }
export function selectedLayer() { return findLayer(store.doc, store.ui.selectedLayerId); }

export function selectLayer(id) {
  id = id || null;
  if (store.ui.selectedLayerId === id) return;
  store.ui.selectedLayerId = id;
  store.emit('layer:selected', { id });
  redraw();
}

export function updateLayer(id, label, fn, coalesce) {
  if (!findLayer(store.doc, id)) return;
  store.commit(label, (d) => { const L = findLayer(d, id); if (L) fn(L, d); }, coalesce ? { coalesce } : undefined);
}

export function addLayer(L, label = '添加图层') {
  if (!store.doc) return null;
  store.commit(label, (d) => { d.layers = [...(d.layers || []), L]; });
  selectLayer(L.id);
  return L.id;
}

export function deleteLayer(id) {
  const L = findLayer(store.doc, id);
  if (!L) return;
  store.commit(`删除${kindName(L)}`, (d) => { d.layers = d.layers.filter((l) => l.id !== id); });
  if (store.ui.selectedLayerId === id) selectLayer(null);
}

export function duplicateLayer(id) {
  const d0 = store.doc;
  const L = findLayer(d0, id);
  if (!L) return null;
  const copy = cloneData(L);
  copy.id = newLayerId();
  copy.hidden = false;
  const off = Math.max(8, Math.round(Math.min(d0.width, d0.height) * 0.035));
  copy.x += off; copy.y += off;
  store.commit(`复制${kindName(L)}`, (d) => {
    const i = d.layers.findIndex((l) => l.id === id);
    const arr = [...d.layers];
    arr.splice(i + 1, 0, copy);
    d.layers = arr;
  });
  selectLayer(copy.id);
  return copy.id;
}

/** dir = +1 → one step towards the top (drawn later), -1 → towards the bottom. */
export function moveLayerOrder(id, dir) {
  const arr = store.doc?.layers || [];
  const i = arr.findIndex((l) => l.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= arr.length) return false;
  store.commit(dir > 0 ? '图层上移' : '图层下移', (d) => {
    const a = [...d.layers];
    const [x] = a.splice(i, 1);
    a.splice(j, 0, x);
    d.layers = a;
  });
  return true;
}

export function toggleLayerHidden(id) {
  const L = findLayer(store.doc, id);
  if (!L) return;
  updateLayer(id, L.hidden ? `显示${kindName(L)}` : `隐藏${kindName(L)}`, (x) => { x.hidden = !x.hidden; });
}

export function kindName(L) { return L?.type === 'text' ? '文字' : L?.type === 'image' ? '图片' : '贴纸'; }

/** Where new layers go: the visible centre of the image (or the image centre), nudged if occupied. */
export function placementPoint() {
  const d = store.doc;
  if (!d) return { x: 0, y: 0 };
  let x0 = 0, y0 = 0, x1 = d.width, y1 = d.height;
  if (viewport.width && viewport.zoom) {
    // centre of the part of the image that is visible on the stage
    const r = viewport.docRect();
    const vx0 = Math.max(0, -r.x / viewport.zoom), vy0 = Math.max(0, -r.y / viewport.zoom);
    const vx1 = Math.min(d.width, (viewport.width - r.x) / viewport.zoom), vy1 = Math.min(d.height, (viewport.height - r.y) / viewport.zoom);
    if (vx1 > vx0 && vy1 > vy0) { x0 = vx0; y0 = vy0; x1 = vx1; y1 = vy1; }
  }
  const x = (x0 + x1) / 2, y = (y0 + y1) / 2;
  const step = Math.max(10, Math.min(d.width, d.height) * 0.07);
  const near = (px, py) => (d.layers || []).some((l) => !l.hidden && Math.abs(l.x - px) < step * 0.5 && Math.abs(l.y - py) < step * 0.5);
  const marginX = Math.min((x1 - x0) / 2, d.width * 0.1), marginY = Math.min((y1 - y0) / 2, d.height * 0.1);
  const point = (px, py) => ({ x: Math.max(x0 + marginX, Math.min(x1 - marginX, Math.round(px))), y: Math.max(y0 + marginY, Math.min(y1 - marginY, Math.round(py))) });
  if (!near(x, y)) return point(x, y);
  // Search around the visible centre instead of endlessly cascading off the bottom-right edge.
  for (let radius = 1; radius <= 5; radius++) {
    for (let dy = radius; dy >= -radius; dy--) for (let dx = radius; dx >= -radius; dx--) {
      if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
      const px = x + dx * step, py = y + dy * step;
      if (px < x0 + marginX || px > x1 - marginX || py < y0 + marginY || py > y1 - marginY) continue;
      if (!near(px, py)) return point(px, py);
    }
  }
  return point(x, y); // a crowded canvas may overlap, but a new layer always remains visible
}

// ---------------------------------------------------------------- geometry helpers (screen space)
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function screenGeom(L) {
  const cs = layerCorners(L).map(([x, y]) => viewport.toScreen(x, y));
  const tm = { x: (cs[0].x + cs[1].x) / 2, y: (cs[0].y + cs[1].y) / 2 };
  const bm = { x: (cs[3].x + cs[2].x) / 2, y: (cs[3].y + cs[2].y) / 2 };
  let ux = tm.x - bm.x, uy = tm.y - bm.y;
  const n = Math.hypot(ux, uy);
  if (n < 1e-3) { const r = L.rotation || 0; ux = Math.sin(r); uy = -Math.cos(r); } else { ux /= n; uy /= n; }
  const rot = { x: tm.x + ux * ROT_DIST, y: tm.y + uy * ROT_DIST };
  const c = viewport.toScreen(L.x, L.y);
  return { cs, tm, rot, c, w: dist(cs[0], cs[1]), h: dist(cs[1], cs[2]) };
}

function resizeCursor(c, p) {
  let a = (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI;
  a = ((a % 180) + 180) % 180;
  if (a < 22.5 || a >= 157.5) return 'ew-resize';
  if (a < 67.5) return 'nwse-resize';
  if (a < 112.5) return 'ns-resize';
  return 'nesw-resize';
}
const ROTATE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12a7 7 0 1 1-2.05-4.95" stroke="#fff" stroke-width="4.5"/><path d="M17.5 3.5v4h-4" stroke="#fff" stroke-width="4.5"/><path d="M19 12a7 7 0 1 1-2.05-4.95" stroke="#1d2129" stroke-width="2"/><path d="M17.5 3.5v4h-4" stroke="#1d2129" stroke-width="2"/></g></svg>',
)}") 12 12, crosshair`;

// ---------------------------------------------------------------- tool state
let drag = null;       // { kind, id, L0, p0, s0, moved, key, lastCommit, guides, angle }
let hover = { id: null, cursor: 'default' };
let keepAlive = 0;
let dragSeq = 0;

function hitHandles(L, sp) {
  const g = screenGeom(L);
  const small = g.w < 28 || g.h < 28;
  if (dist(sp, g.rot) <= HANDLE_HIT) return { kind: 'rotate', g };
  for (let i = 0; i < 4; i++) {
    if (dist(sp, g.cs[i]) <= HANDLE_HIT) {
      // tiny boxes: let the body win so small stickers can still be dragged
      if (small && hitLayer(L, viewport.pointer.x, viewport.pointer.y)) return null;
      return { kind: 'scale', corner: i, g };
    }
  }
  return null;
}

function setCursor(c) {
  if (hover.cursor === c) return;
  hover.cursor = c;
  viewport.updateCursor();
}

function commitDrag(label, fn) {
  if (!drag) return;
  const id = drag.id;
  if (!findLayer(store.doc, id)) { endDrag(); return; } // layer removed meanwhile (undo / new image)
  drag.lastCommit = performance.now();
  store.commit(label, (d) => { const L = findLayer(d, id); if (L) fn(L); }, { coalesce: drag.key });
}

function startKeepAlive() {
  clearInterval(keepAlive);
  // coalesced commits merge only within 800 ms; while the pointer rests we refresh the step so the whole
  // drag stays ONE undo step
  keepAlive = setInterval(() => {
    if (!drag || !drag.moved || drag.kind === 'pan') return;
    if (performance.now() - drag.lastCommit > 450) commitDrag(drag.label, () => {});
  }, 200);
}

function endDrag() {
  clearInterval(keepAlive);
  keepAlive = 0;
  drag = null;
  redraw();
}

function pointerScreen(pt) { return viewport.toScreen(pt.x, pt.y); }

function onDown(pt, e) {
  const d = store.doc;
  if (!d) return;
  const sp = pointerScreen(pt);
  const sel = selectedLayer();
  const pad = 3 / viewport.zoom;
  const base = { p0: pt, sp0: sp, moved: false, key: `layer.drag.${++dragSeq}`, lastCommit: 0, guides: null };
  if (sel && !sel.hidden) {
    const hh = hitHandles(sel, sp);
    if (hh) {
      drag = { ...base, kind: hh.kind, id: sel.id, L0: cloneData(sel), corner: hh.corner, label: hh.kind === 'rotate' ? '旋转图层' : '缩放图层' };
      if (hh.kind === 'rotate') { drag.a0 = Math.atan2(sp.y - hh.g.c.y, sp.x - hh.g.c.x); setCursor(ROTATE_CURSOR); }
      else setCursor(resizeCursor(hh.g.c, hh.g.cs[hh.corner]));
      startKeepAlive();
      return;
    }
  }
  const top = hitTestLayers(d, pt.x, pt.y, pad);
  if (sel && !sel.hidden && hitLayer(sel, pt.x, pt.y, pad)) {
    drag = { ...base, kind: 'move', id: sel.id, L0: cloneData(sel), clickSelect: top && top.id !== sel.id ? top.id : null, label: '移动图层' };
    setCursor('move');
    startKeepAlive();
    return;
  }
  if (top) {
    selectLayer(top.id);
    drag = { ...base, kind: 'move', id: top.id, L0: cloneData(top), label: '移动图层' };
    setCursor('move');
    startKeepAlive();
    return;
  }
  selectLayer(null);
  drag = { ...base, kind: 'pan', cx: e?.clientX ?? 0, cy: e?.clientY ?? 0 };
  setCursor('grabbing');
}

function onMove(pt, e) {
  const d = store.doc;
  if (!d) return;
  const sp = pointerScreen(pt);
  if (!drag) { updateHover(pt, sp); return; }
  if (drag.kind === 'pan') {
    const cx = e?.clientX ?? 0, cy = e?.clientY ?? 0;
    viewport.panBy(cx - drag.cx, cy - drag.cy);
    drag.cx = cx; drag.cy = cy;
    return;
  }
  if (!drag.moved) {
    if (dist(sp, drag.sp0) < 3) return;
    drag.moved = true;
  }
  const L0 = drag.L0;
  if (drag.kind === 'move') {
    let nx = L0.x + (pt.x - drag.p0.x), ny = L0.y + (pt.y - drag.p0.y);
    const thr = SNAP_PX / viewport.zoom;
    const guides = { v: false, h: false };
    if (!e?.altKey) {
      if (Math.abs(nx - d.width / 2) < thr) { nx = d.width / 2; guides.v = true; }
      if (Math.abs(ny - d.height / 2) < thr) { ny = d.height / 2; guides.h = true; }
    }
    drag.guides = guides;
    commitDrag('移动图层', (L) => { L.x = nx; L.y = ny; });
  } else if (drag.kind === 'rotate') {
    const c = viewport.toScreen(L0.x, L0.y);
    const a = Math.atan2(sp.y - c.y, sp.x - c.x);
    let r = (L0.rotation || 0) + (a - drag.a0);
    const deg = (r * 180) / Math.PI;
    let snapped;
    if (e?.shiftKey) snapped = Math.round(deg / 15) * 15;
    else { const q = Math.round(deg / 90) * 90; snapped = Math.abs(deg - q) < 4 ? q : deg; }
    r = (snapped * Math.PI) / 180;
    r = Math.atan2(Math.sin(r), Math.cos(r)); // normalise to (-π, π]
    if (Math.abs(r) < 1e-9) r = 0;
    drag.angle = Math.round((r * 180) / Math.PI);
    commitDrag('旋转图层', (L) => { L.rotation = r; });
  } else if (drag.kind === 'scale') {
    const res = scaleFrom(L0, drag.corner, pt, !!e?.shiftKey);
    commitDrag('缩放图层', (L) => { L.x = res.x; L.y = res.y; L.scale = res.scale; if (res.sy != null) L.sy = res.sy; });
  }
}

/** New centre / scale when corner `i` (0 TL,1 TR,2 BR,3 BL) is dragged to doc point p; the opposite corner stays put. */
export function scaleFrom(L0, i, p, free) {
  const d = store.doc;
  const cs = layerCorners(L0);
  const A = { x: cs[(i + 2) % 4][0], y: cs[(i + 2) % 4][1] };
  const P0 = { x: cs[i][0], y: cs[i][1] };
  const { w, h } = layerSize(L0);
  const { sx: sx0, sy: sy0 } = layerScale(L0);
  const long0 = Math.max(w * Math.abs(sx0), h * Math.abs(sy0));
  const minLong = Math.max(6, 14 / (viewport.zoom || 1));
  const maxLong = Math.max(d?.width || 1000, d?.height || 1000) * 4;
  const kMin = minLong / long0, kMax = maxLong / long0;
  const clampK = (k) => Math.max(kMin, Math.min(kMax, k));
  if (!free) {
    const dx = P0.x - A.x, dy = P0.y - A.y;
    const k = clampK(((p.x - A.x) * dx + (p.y - A.y) * dy) / (dx * dx + dy * dy || 1));
    return { x: A.x + (dx * k) / 2, y: A.y + (dy * k) / 2, scale: (L0.scale ?? 1) * k, sy: null };
  }
  const r = L0.rotation || 0;
  const u = { x: Math.cos(r), y: Math.sin(r) }, v = { x: -Math.sin(r), y: Math.cos(r) };
  const sgx = i === 1 || i === 2 ? 1 : -1, sgy = i >= 2 ? 1 : -1;
  const Dx = p.x - A.x, Dy = p.y - A.y;
  const lx = Dx * u.x + Dy * u.y, ly = Dx * v.x + Dy * v.y;
  const w0 = w * sx0, h0 = h * sy0;
  const minW = minLong * 0.35;
  const kx = Math.max(minW / w0, Math.min(kMax, (sgx * lx) / w0));
  const ky = Math.max(minW / h0, Math.min(kMax, (sgy * ly) / h0));
  const nsx = sx0 * kx, nsy = sy0 * ky;
  const cx = A.x + u.x * (sgx * kx * w0) / 2 + v.x * (sgy * ky * h0) / 2;
  const cy = A.y + u.y * (sgx * kx * w0) / 2 + v.y * (sgy * ky * h0) / 2;
  return { x: cx, y: cy, scale: nsx, sy: nsy / nsx };
}

function onUp(pt, e) {
  if (!drag) return;
  const dr = drag;
  if (dr.kind !== 'pan' && dr.moved) onMove(pt, e); // final position
  if (dr.kind === 'move' && !dr.moved && dr.clickSelect) selectLayer(dr.clickSelect);
  endDrag();
  updateHover(pt, pointerScreen(pt));
}

function updateHover(pt, sp) {
  const d = store.doc;
  if (!d) return;
  const sel = selectedLayer();
  let cursor = 'default', id = null;
  const hh = sel && !sel.hidden ? hitHandles(sel, sp) : null;
  if (hh) cursor = hh.kind === 'rotate' ? ROTATE_CURSOR : resizeCursor(hh.g.c, hh.g.cs[hh.corner]);
  else {
    const pad = 3 / viewport.zoom;
    const top = (sel && !sel.hidden && hitLayer(sel, pt.x, pt.y, pad)) ? sel : hitTestLayers(d, pt.x, pt.y, pad);
    if (top) { cursor = 'move'; id = top.id; }
  }
  if (hover.id !== id) { hover.id = id; redraw(); }
  setCursor(cursor);
}

// ---------------------------------------------------------------- keys
function onKey(e) {
  const d = store.doc;
  if (!d) return;
  const k = e.key;
  const mod = e.ctrlKey || e.metaKey;
  if (k === 'Escape') { if (store.ui.selectedLayerId) { selectLayer(null); e.preventDefault(); } return; }
  const sel = selectedLayer();
  if (!sel) return;
  if (mod && (k === 'd' || k === 'D')) { e.preventDefault(); duplicateLayer(sel.id); return; }
  if (mod || e.altKey) return;
  if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); deleteLayer(sel.id); return; }
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  // arrows on a focused slider / switch / segmented control belong to that control
  const tgt = e.target;
  if (arrows[k] && tgt?.closest?.('input, select, textarea, [role="radiogroup"], [role="tablist"]')) return;
  if (arrows[k]) {
    e.preventDefault();
    const step = Math.max(1, Math.round(1 / (viewport.zoom || 1))) * (e.shiftKey ? 10 : 1);
    const [dx, dy] = arrows[k];
    updateLayer(sel.id, '微调位置', (L) => { L.x += dx * step; L.y += dy * step; }, `layer.nudge.${sel.id}`);
  }
}

function onDoubleClick(pt) {
  const d = store.doc;
  if (!d) return;
  const pad = 3 / viewport.zoom;
  const sel = selectedLayer();
  const L = (sel && !sel.hidden && hitLayer(sel, pt.x, pt.y, pad)) ? sel : hitTestLayers(d, pt.x, pt.y, pad);
  if (!L) return;
  selectLayer(L.id);
  if (L.type === 'text') {
    store.ui.textEditPending = L.id;
    if (currentPanelId() !== 'text') showPanel('text');
    else store.emit('layer:edit', { id: L.id });
  } else if (currentPanelId() !== 'sticker') showPanel('sticker');
}

// ---------------------------------------------------------------- overlay
function polyPath(ctx, pts) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
}

function drawRotateHandle(ctx, p, active) {
  ctx.save();
  ctx.shadowColor = 'rgba(16,24,40,0.25)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 1;
  ctx.fillStyle = active ? ACCENT : '#ffffff';
  ctx.beginPath(); ctx.arc(p.x, p.y, 9.5, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = active ? '#ffffff' : ACCENT;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(p.x, p.y, 9.5, 0, Math.PI * 2);
  if (!active) ctx.stroke();
  // circular arrow
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.arc(p.x, p.y, 4.6, -Math.PI * 0.15, Math.PI * 1.35); ctx.stroke();
  const ax = p.x + 4.6 * Math.cos(-Math.PI * 0.15), ay = p.y + 4.6 * Math.sin(-Math.PI * 0.15);
  ctx.beginPath(); ctx.moveTo(ax - 3.2, ay - 1.2); ctx.lineTo(ax + 0.4, ay + 0.3); ctx.lineTo(ax + 1.2, ay - 3.4); ctx.stroke();
  ctx.restore();
}

function drawBadge(ctx, x, y, text) {
  ctx.save();
  ctx.font = '600 12px "Microsoft YaHei UI","Microsoft YaHei",sans-serif';
  const w = ctx.measureText(text).width + 14, h = 22;
  const bx = Math.round(x - w / 2), by = Math.round(y - h / 2);
  ctx.fillStyle = 'rgba(29,33,41,0.88)';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(bx, by, w, h, 11); else ctx.rect(bx, by, w, h);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, bx + w / 2, by + h / 2 + 0.5);
  ctx.restore();
}

function drawOverlay(ctx, vp) {
  const d = store.doc;
  if (!d) return;
  const sel = selectedLayer();
  // hover outline (not for the selected layer)
  if (!drag && hover.id && hover.id !== sel?.id && vp.pointer.inside && !vp.spaceHeld) {
    const H = findLayer(d, hover.id);
    if (H && !H.hidden) {
      const cs = layerCorners(H).map(([x, y]) => vp.toScreen(x, y));
      ctx.save();
      ctx.strokeStyle = 'rgba(52,100,240,0.75)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      polyPath(ctx, cs); ctx.stroke();
      ctx.restore();
    }
  }
  // snap guides
  if (drag?.kind === 'move' && drag.moved && drag.guides) {
    const r = vp.docRect();
    ctx.save();
    ctx.strokeStyle = GUIDE;
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    if (drag.guides.v) { const x = Math.round(r.x + r.w / 2) + 0.5; ctx.beginPath(); ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h); ctx.stroke(); }
    if (drag.guides.h) { const y = Math.round(r.y + r.h / 2) + 0.5; ctx.beginPath(); ctx.moveTo(r.x, y); ctx.lineTo(r.x + r.w, y); ctx.stroke(); }
    ctx.restore();
  }
  if (!sel || sel.hidden) return;
  const g = screenGeom(sel);
  ctx.save();
  // box: white halo + accent line
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 3.5;
  polyPath(ctx, g.cs); ctx.stroke();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.5;
  polyPath(ctx, g.cs); ctx.stroke();
  // rotate stem
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 3.5;
  ctx.beginPath(); ctx.moveTo(g.tm.x, g.tm.y); ctx.lineTo(g.rot.x, g.rot.y); ctx.stroke();
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(g.tm.x, g.tm.y); ctx.lineTo(g.rot.x, g.rot.y); ctx.stroke();
  // corner handles
  for (let i = 0; i < 4; i++) {
    const p = g.cs[i];
    const active = drag?.kind === 'scale' && drag.corner === i;
    ctx.save();
    ctx.shadowColor = 'rgba(16,24,40,0.28)';
    ctx.shadowBlur = 3;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = active ? ACCENT : '#ffffff';
    ctx.beginPath(); ctx.arc(p.x, p.y, HANDLE_R, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(p.x, p.y, HANDLE_R, 0, Math.PI * 2); ctx.stroke();
  }
  drawRotateHandle(ctx, g.rot, drag?.kind === 'rotate');
  ctx.restore();
  if (drag?.kind === 'rotate' && drag.moved) drawBadge(ctx, g.rot.x, g.rot.y - 24, `${drag.angle ?? 0}°`);
  if (drag?.kind === 'scale' && drag.moved) {
    const { w, h } = layerSize(sel);
    const { sx, sy } = layerScale(sel);
    const p = g.cs[drag.corner];
    drawBadge(ctx, p.x, p.y + (p.y >= g.c.y ? 24 : -24), `${Math.round(w * Math.abs(sx))} × ${Math.round(h * Math.abs(sy))}`);
  }
}

// ---------------------------------------------------------------- registration
export const layerTool = registerTool({
  id: TOOL_ID,
  get cursor() { return drag?.kind === 'pan' ? 'grabbing' : hover.cursor; },
  hint: '点选文字或贴纸 · 拖动移动 · 拖四角缩放（Shift 自由拉伸）· 拖上方圆点旋转 · 方向键微调 · Delete 删除 · Ctrl+D 复制',
  activate() { hover = { id: null, cursor: 'default' }; redraw(); },
  deactivate() { endDrag(); hover = { id: null, cursor: 'default' }; },
  onPointerDown: onDown,
  onPointerMove: onMove,
  onPointerUp: onUp,
  onDoubleClick,
  onKey,
  drawOverlay,
});

// keep handles in sync with undo/redo and panel edits
store.on('doc:changed', (p) => { if (p?.reason !== 'bump' && currentTool()?.id === TOOL_ID) redraw(); });
store.on('doc:loaded', () => { endDrag(); hover = { id: null, cursor: 'default' }; });
store.on('layer:selected', redraw);

export { layerLabel };
