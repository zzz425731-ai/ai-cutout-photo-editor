// core/viewport.js — the stage: zoom/pan/fit, checkerboard, hi-DPI, pointer routing to tools,
// progressive preview rendering, overlays, hold-to-compare.
//
//   viewport.zoom                         current zoom (1 = 100 %)
//   viewport.toDoc(e) → {x,y}             client event (or {clientX,clientY}) → doc px
//   viewport.toScreen(x,y) → {x,y}        doc px → stage css px
//   viewport.docRect() → {x,y,w,h}        image rectangle in stage css px
//   viewport.requestRender()              re-render the document (coalesced to one frame)
//   viewport.requestOverlay()             redraw only tool/panel overlays
//   viewport.addOverlay(fn(ctx, viewport)) → remove()   extra overlay drawing (ctx in stage css px)
//   viewport.fit() / setZoom(z, ax?, ay?) / zoomBy(f, ax?, ay?) / panBy(dx, dy)
//   viewport.setCompare(bool)             show the untouched original while true
//   viewport.pointer → { x, y, inside, sx, sy }   last pointer position (doc px, stage css px)
//   viewport.renderNow()                  synchronous render (tests)

import { store } from './store.js';
import { renderDoc, prewarm } from './render.js';
import { currentTool } from './tools.js';
import { createCanvas } from './io.js';

const INTERACTIVE_MAX_PX = 2.6e6;
const MIN_ZOOM = 0.02, MAX_ZOOM = 16;

let stage, view, overlay, vctx, octx;
let cssW = 0, cssH = 0, dpr = 1;
let preview = null;
let raf = 0, renderDirty = false, viewDirty = false, overlayDirty = false;
let lastRenderEnd = 0, lastRenderCost = 0, hqTimer = 0, forceFull = false, zoomRenderTimer = 0;
const fullCost = new Map(); // preview scale -> ms estimate of a full-quality render at it (decaying max)
let previewDrop = 0;   // extra √2 steps below the default preview scale when previews themselves are slow
let pointersDown = 0;  // any mouse button held anywhere (slider drag, brush stroke) -> postpone the HQ refine
let userZoomed = false;
let spaceHeld = false, panning = null, toolPointer = null;
let checker = null;
const overlays = new Set();
let lastDims = '';

export const viewport = {
  zoom: 1,
  panX: 0,
  panY: 0,
  previewScale: 0,
  compare: false,
  inspection: null,
  pointer: { x: 0, y: 0, sx: 0, sy: 0, inside: false },
  get dpr() { return dpr; },
  get width() { return cssW; },
  get height() { return cssH; },
  get isPanning() { return !!panning; },
  /** true while a tool stroke is in progress (left button held on the canvas) */
  get isStroking() { return toolPointer != null; },
  get spaceHeld() { return spaceHeld; },

  init(stageEl, viewCanvas, overlayCanvas) {
    stage = stageEl; view = viewCanvas; overlay = overlayCanvas;
    vctx = view.getContext('2d');
    octx = overlay.getContext('2d');
    preview = createCanvas(1, 1);
    new ResizeObserver(() => resize()).observe(stage);
    watchDpr();
    resize();
    bindPointer();
    store.on('doc:loaded', () => { userZoomed = false; lastDims = ''; preview.width = 1; viewport.previewScale = 0; viewport.inspection = null; fullCost.clear(); previewDrop = 0; });
    store.on('doc:changed', () => {
      const d = store.doc;
      if (!d) return;
      const dims = `${d.width}x${d.height}`;
      if (dims !== lastDims) { lastDims = dims; fullCost.clear(); viewport.fit(); }
      viewport.requestRender();
    });
    store.on('tool:changed', () => { viewport.updateCursor(); viewport.requestRender(); viewport.requestOverlay(); });
  },

  // ------------------------------------------------------------ coordinates
  toDoc(e) {
    const r = stage.getBoundingClientRect();
    return { x: (e.clientX - r.left - viewport.panX) / viewport.zoom, y: (e.clientY - r.top - viewport.panY) / viewport.zoom };
  },
  toScreen(x, y) { return { x: x * viewport.zoom + viewport.panX, y: y * viewport.zoom + viewport.panY }; },
  docRect() {
    const d = store.doc;
    if (!d) return { x: 0, y: 0, w: 0, h: 0 };
    return { x: viewport.panX, y: viewport.panY, w: d.width * viewport.zoom, h: d.height * viewport.zoom };
  },

  // ------------------------------------------------------------ zoom / pan
  fitZoom() {
    const d = store.doc;
    if (!d || !cssW || !cssH) return 1;
    const pad = Math.min(48, Math.max(16, Math.min(cssW, cssH) * 0.05));
    // up to 200 %; tiny images (icons, 20x20 ...) may go up to 800 % so they are not a speck on screen
    const cap = Math.max(2, Math.min(8, 320 / Math.max(d.width, d.height)));
    return Math.max(MIN_ZOOM, Math.min(cap, (cssW - pad * 2) / d.width, (cssH - pad * 2) / d.height));
  },
  fit() {
    const d = store.doc;
    if (!d) return;
    viewport.zoom = viewport.fitZoom();
    viewport.panX = Math.round((cssW - d.width * viewport.zoom) / 2);
    viewport.panY = Math.round((cssH - d.height * viewport.zoom) / 2);
    userZoomed = false;
    afterViewChange();
  },
  setZoom(z, ax = cssW / 2, ay = cssH / 2) {
    const d = store.doc;
    if (!d) return;
    z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    const k = z / viewport.zoom;
    viewport.panX = ax - (ax - viewport.panX) * k;
    viewport.panY = ay - (ay - viewport.panY) * k;
    viewport.zoom = z;
    userZoomed = true;
    clampPan();
    afterViewChange();
  },
  zoomBy(f, ax, ay) { viewport.setZoom(viewport.zoom * f, ax, ay); },
  zoomStep(dir) {
    const steps = [0.02, 0.05, 0.1, 0.125, 0.167, 0.25, 0.333, 0.5, 0.667, 0.8, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16];
    const z = viewport.zoom;
    const next = dir > 0 ? steps.find((s) => s > z * 1.01) : [...steps].reverse().find((s) => s < z * 0.99);
    viewport.setZoom(next ?? z);
  },
  panBy(dx, dy) {
    viewport.panX += dx; viewport.panY += dy;
    userZoomed = true;
    clampPan();
    afterViewChange(false);
  },

  // ------------------------------------------------------------ drawing
  requestRender() { renderDirty = true; schedule(); },
  requestOverlay() { overlayDirty = true; schedule(); },
  requestDraw() { viewDirty = true; schedule(); },
  addOverlay(fn) { overlays.add(fn); viewport.requestOverlay(); return () => { overlays.delete(fn); viewport.requestOverlay(); }; },
  setCompare(on) {
    if (viewport.compare === !!on) return;
    viewport.compare = !!on;
    stage.classList.toggle('comparing', viewport.compare);
    forceFull = true;
    viewport.requestRender();
  },
  /** Temporary edge checks: never change the document or exported background. */
  setInspection(mode) {
    const next = ['black', 'white', 'green', 'alpha'].includes(mode) ? mode : null;
    if (viewport.inspection === next) return;
    viewport.inspection = next;
    viewport.requestRender();
    store.emit('inspection:changed', next);
  },
  renderNow() { forceFull = true; doRender(); drawView(); drawOverlay(); },
  updateCursor() {
    if (!overlay) return;
    const t = currentTool();
    overlay.style.cursor = panning ? 'grabbing' : spaceHeld || !t || t.id === 'pan' || t.pans ? 'grab' : (t.cursor || 'default');
  },
  /** The last rendered preview canvas (read-only). */
  get preview() { return preview; },
};

function afterViewChange(maybeRerender = true) {
  viewDirty = true; overlayDirty = true;
  schedule();
  store.emit('view:changed', { zoom: viewport.zoom });
  if (maybeRerender) {
    clearTimeout(zoomRenderTimer);
    zoomRenderTimer = setTimeout(() => {
      if (store.doc && Math.abs(neededScale() - viewport.previewScale) > 1e-6) refineNow();
    }, 140);
  }
}

function clampPan() {
  const d = store.doc;
  if (!d) return;
  const w = d.width * viewport.zoom, h = d.height * viewport.zoom;
  const m = 60; // keep at least this much of the image visible
  viewport.panX = Math.min(cssW - m, Math.max(m - w, viewport.panX));
  viewport.panY = Math.min(cssH - m, Math.max(m - h, viewport.panY));
}

function neededScale() {
  const z = viewport.zoom * dpr;
  if (z >= 1) return 1;
  return Math.min(1, Math.pow(2, Math.ceil(Math.log2(z) * 2) / 2));
}

function schedule() {
  if (!raf) raf = requestAnimationFrame(frame);
}

function frame() {
  raf = 0;
  try {
    if (renderDirty) doRender();
    if (viewDirty) drawView();
    if (overlayDirty) drawOverlay();
  } catch (err) {
    console.error('[viewport] render failed:', err);
  }
}

function doRender() {
  renderDirty = false;
  const d = store.doc;
  if (!d) return;
  const need = neededScale();
  let s = need;
  const now = performance.now();
  // A full-quality render that is slow (big image at high zoom) is replaced by a cheaper preview while
  // changes keep coming (slider drag, brushing) or whenever the last full render was slow; full quality
  // follows ~240 ms after the changes stop (and never while a mouse button is still held down).
  // Decided on the cost of FULL renders only: using the last (cheap) preview's cost made renders alternate
  // preview / full and froze slider drags on 4096-px images at 100 %.
  const continuous = now - lastRenderEnd < 200;
  const est = fullCost.get(need) || 0;
  const slow = est > 60 || (continuous && est > 18);
  let isPreview = false;
  if (!forceFull && slow && d.width * d.height * s * s > INTERACTIVE_MAX_PX) {
    const base = Math.pow(2, (Math.floor(Math.log2(Math.sqrt(INTERACTIVE_MAX_PX / (d.width * d.height))) * 2) - previewDrop) / 2);
    s = Math.min(need, Math.max(need / 4, base));
    isPreview = s < need;
  }
  forceFull = false;
  const t = currentTool();
  const maskView = !!(t && t.maskView && store.ui.showMask && d.mask && !viewport.compare);
  const t0 = performance.now();
  renderDoc(d, { scale: s, target: preview, showOriginal: viewport.compare, maskView, inspection: viewport.inspection });
  lastRenderCost = performance.now() - t0;
  lastRenderEnd = performance.now();
  if (s === need) fullCost.set(need, Math.max(lastRenderCost, (fullCost.get(need) || 0) * 0.75));
  // previews themselves slow (heavy 羽化/描边 on a huge image) → smaller previews until the next full render
  if (isPreview && lastRenderCost > 45) previewDrop = Math.min(2, previewDrop + 1);
  else if (!isPreview) previewDrop = 0;
  viewport.previewScale = s;
  viewport.lastRenderMs = lastRenderCost;
  viewport.renderCount = (viewport.renderCount || 0) + 1;
  viewDirty = true;
  clearTimeout(hqTimer);
  if (s < need) scheduleRefine(240);
}

function scheduleRefine(ms) {
  clearTimeout(hqTimer);
  hqTimer = setTimeout(() => {
    if (pointersDown > 0) { scheduleRefine(120); return; } // still dragging: keep the fast preview
    refineNow();
  }, ms);
}

/** Full-quality render: the slow mask maths runs in a worker first (page stays responsive), then a fast render. */
let refineSeq = 0;
function refineNow() {
  const d = store.doc;
  if (!d) return;
  const seq = ++refineSeq;
  const v = store.version;
  prewarm(d, neededScale()).then(() => {
    if (seq !== refineSeq || store.doc !== d) return;          // a newer refine / another image
    if (store.version !== v) return;                            // a newer change renders (and refines) itself
    forceFull = true; viewport.requestRender();
  });
}

function makeChecker() {
  const cell = 8;
  const c = createCanvas(cell * 2 * dpr, cell * 2 * dpr);
  const x = c.getContext('2d');
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, c.width, c.height);
  x.fillStyle = '#e9ebf0';
  x.fillRect(0, 0, cell * dpr, cell * dpr);
  x.fillRect(cell * dpr, cell * dpr, cell * dpr, cell * dpr);
  checker = vctx.createPattern(c, 'repeat');
}

function drawView() {
  viewDirty = false;
  vctx.setTransform(1, 0, 0, 1, 0, 0);
  vctx.clearRect(0, 0, view.width, view.height);
  const d = store.doc;
  if (!d || !viewport.previewScale) return;
  vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const x = Math.round(viewport.panX * dpr) / dpr, y = Math.round(viewport.panY * dpr) / dpr;
  const w = Math.round(d.width * viewport.zoom * dpr) / dpr, h = Math.round(d.height * viewport.zoom * dpr) / dpr;
  // soft drop shadow under the canvas
  vctx.save();
  vctx.shadowColor = 'rgba(15, 23, 42, 0.16)';
  vctx.shadowBlur = 24 * dpr;
  vctx.shadowOffsetY = 6 * dpr;
  vctx.fillStyle = '#ffffff';
  vctx.fillRect(x, y, w, h);
  vctx.restore();
  // checkerboard (aligned to the image, fixed screen size)
  if (!checker) makeChecker();
  vctx.save();
  checker.setTransform(new DOMMatrix().translate(x, y).scale(1 / dpr));
  vctx.fillStyle = checker;
  vctx.fillRect(x, y, w, h);
  vctx.restore();
  // image
  const magnify = (viewport.zoom * dpr) / viewport.previewScale;
  vctx.imageSmoothingEnabled = magnify < 2.5;
  vctx.imageSmoothingQuality = 'high';
  vctx.drawImage(preview, x, y, w, h);
  // hairline frame so light backgrounds don't melt into the stage
  vctx.strokeStyle = 'rgba(16, 24, 40, 0.10)';
  vctx.lineWidth = 1 / dpr;
  vctx.strokeRect(x - 0.5 / dpr, y - 0.5 / dpr, w + 1 / dpr, h + 1 / dpr);
}

function drawOverlay() {
  overlayDirty = false;
  octx.setTransform(1, 0, 0, 1, 0, 0);
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (!store.doc) return;
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const t = currentTool();
  try { t?.drawOverlay?.(octx, viewport); } catch (err) { console.error('[viewport] tool overlay failed:', err); }
  for (const fn of overlays) {
    octx.save();
    try { fn(octx, viewport); } catch (err) { console.error('[viewport] overlay failed:', err); }
    octx.restore();
  }
}

function resize() {
  const r = stage.getBoundingClientRect();
  const nw = Math.max(1, Math.round(r.width)), nh = Math.max(1, Math.round(r.height));
  const ndpr = window.devicePixelRatio || 1;
  const changed = nw !== cssW || nh !== cssH || ndpr !== dpr;
  const oldW = cssW, oldH = cssH;
  cssW = nw; cssH = nh;
  if (ndpr !== dpr) { dpr = ndpr; checker = null; }
  for (const c of [view, overlay]) {
    c.width = Math.round(cssW * dpr); c.height = Math.round(cssH * dpr);
    c.style.width = `${cssW}px`; c.style.height = `${cssH}px`;
  }
  if (!changed) return;
  if (store.doc) {
    if (!userZoomed) viewport.fit();
    else { viewport.panX += (cssW - oldW) / 2; viewport.panY += (cssH - oldH) / 2; clampPan(); afterViewChange(); }
  }
  viewDirty = true; overlayDirty = true;
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
  frame();
}

function watchDpr() {
  const mq = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
  mq.addEventListener('change', () => { resize(); forceFull = true; viewport.requestRender(); watchDpr(); }, { once: true });
}

function isTyping(e) {
  const t = e.target;
  return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !(t.type === 'range' || t.type === 'checkbox' || t.type === 'button'));
}

function bindPointer() {
  // held mouse buttons anywhere on the page (slider thumbs, canvas strokes), see scheduleRefine
  window.addEventListener('pointerdown', () => { pointersDown++; }, true);
  const release = () => { pointersDown = Math.max(0, pointersDown - 1); };
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
  window.addEventListener('blur', () => { pointersDown = 0; });
  // a release outside the window can be missed: any move with no button held means nothing is held
  window.addEventListener('pointermove', (e) => { if (pointersDown && !e.buttons) pointersDown = 0; }, { capture: true, passive: true });
  overlay.addEventListener('pointerdown', (e) => {
    if (!store.doc) return;
    overlay.focus?.({ preventScroll: true });
    const t = currentTool();
    const wantPan = e.button === 1 || (e.button === 0 && (spaceHeld || !t || t.id === 'pan' || t.pans));
    if (wantPan) {
      e.preventDefault();
      panning = { x: e.clientX, y: e.clientY, id: e.pointerId };
      overlay.setPointerCapture(e.pointerId);
      viewport.updateCursor();
      return;
    }
    if (e.button !== 0) return;
    toolPointer = e.pointerId;
    overlay.setPointerCapture(e.pointerId);
    updatePointer(e);
    try { t.onPointerDown?.(viewport.toDoc(e), e); } catch (err) { console.error('[tool] pointerdown failed:', err); }
  });
  overlay.addEventListener('pointermove', (e) => {
    updatePointer(e);
    if (panning && e.pointerId === panning.id) {
      viewport.panBy(e.clientX - panning.x, e.clientY - panning.y);
      panning.x = e.clientX; panning.y = e.clientY;
      return;
    }
    const t = currentTool();
    if (t?.onPointerMove) {
      const evs = toolPointer === e.pointerId && e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      try { for (const ev of evs.length ? evs : [e]) t.onPointerMove(viewport.toDoc(ev), ev); } catch (err) { console.error('[tool] pointermove failed:', err); }
    }
    viewport.requestOverlay();
  });
  const up = (e) => {
    if (panning && e.pointerId === panning.id) {
      panning = null;
      viewport.updateCursor();
      return;
    }
    if (toolPointer === e.pointerId) {
      toolPointer = null;
      // lostpointercapture carries no reliable position → finish at the last known pointer position
      const pt = e.type === 'lostpointercapture' ? { x: viewport.pointer.x, y: viewport.pointer.y } : viewport.toDoc(e);
      try { currentTool()?.onPointerUp?.(pt, e); } catch (err) { console.error('[tool] pointerup failed:', err); }
    }
  };
  overlay.addEventListener('pointerup', up);
  overlay.addEventListener('pointercancel', up);
  overlay.addEventListener('lostpointercapture', up); // e.g. a dialog stole the pointer: end the stroke / pan
  overlay.addEventListener('pointerleave', () => { viewport.pointer.inside = false; viewport.requestOverlay(); });
  overlay.addEventListener('pointerenter', (e) => { updatePointer(e); });
  overlay.addEventListener('contextmenu', (e) => e.preventDefault());
  overlay.addEventListener('dblclick', (e) => { currentTool()?.onDoubleClick?.(viewport.toDoc(e), e); });
  stage.addEventListener('wheel', (e) => {
    if (!store.doc) return;
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    const f = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018));
    viewport.zoomBy(f, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  const isSpace = (e) => e.code === 'Space' || e.key === ' ';
  window.addEventListener('keydown', (e) => {
    if (isSpace(e) && !isTyping(e) && !e.repeat) {
      if (store.doc) e.preventDefault();
      spaceHeld = true;
      viewport.updateCursor();
      viewport.requestOverlay();
    } else if (isSpace(e) && !isTyping(e)) e.preventDefault();
    if (!isTyping(e) && !document.querySelector('.modal-back')) currentTool()?.onKey?.(e);
  });
  window.addEventListener('keyup', (e) => {
    if (isSpace(e)) { spaceHeld = false; viewport.updateCursor(); viewport.requestOverlay(); }
  });
  window.addEventListener('blur', () => { spaceHeld = false; viewport.updateCursor(); });
}

function updatePointer(e) {
  const r = stage.getBoundingClientRect();
  const p = viewport.toDoc(e);
  viewport.pointer.x = p.x; viewport.pointer.y = p.y;
  viewport.pointer.sx = e.clientX - r.left; viewport.pointer.sy = e.clientY - r.top;
  viewport.pointer.inside = true;
}
