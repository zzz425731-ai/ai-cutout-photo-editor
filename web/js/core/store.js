// core/store.js — document state, events and undo/redo history.
//
// Public API (stable, used by every panel/tool):
//   store.doc                      current document (see createDoc) or null
//   store.ui                       { panel, tool, selectedLayerId, brush:{size,hardness}, showMask, cutoutMode }
//   store.dirty                    true when there are unsaved edits
//   store.on(evt, fn) / off / emit
//   store.setDoc(doc)              new document, clears history
//   store.commit(label, mutate, { coalesce })        record undo step, then mutate(doc)
//   store.commitRegion(label, planeName, rect, beforeImageData, afterImageData?)
//   store.commitRegions(label, [{ plane, rect, before, after? }, …])   several planes, one undo step
//   store.undo() / redo() / canUndo() / canRedo() / undoLabel() / redoLabel()
//   store.bump(planeNameOrCanvas, rect?)               mark a plane's pixels changed (cache invalidation)
//   store.markSaved()
//   store.endCoalesce(key?)       end a coalescing run (slider released) → next commit starts a new step
//   store.setHistoryLimits({ maxSteps, maxBytes })   defaults 80 steps / 512 MB
//
// Events: doc:loaded, doc:changed {reason,label?,plane?,rect?}, history:changed, panel:changed,
//         tool:changed, layer:selected, brush:changed, view:changed, cutout:running, saved, exported, files:dropped

const COALESCE_MS = 800;

let uidCounter = 1;
const uids = new WeakMap();
/** Stable numeric id for any object (canvas, layer image, …). */
export function uidOf(obj) {
  let u = uids.get(obj);
  if (!u) { u = uidCounter++; uids.set(obj, u); }
  return u;
}

function isPlain(v) {
  if (v === null || typeof v !== 'object') return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === Array.prototype || p === null;
}
/** Deep-clones plain objects/arrays; keeps canvases/bitmaps/other class instances by reference. */
export function cloneData(v) {
  if (Array.isArray(v)) return v.map(cloneData);
  if (isPlain(v)) { const o = {}; for (const k of Object.keys(v)) o[k] = cloneData(v[k]); return o; }
  return v;
}

function isPlane(v) {
  return v && typeof v === 'object' && (
    (typeof HTMLCanvasElement !== 'undefined' && v instanceof HTMLCanvasElement) ||
    (typeof OffscreenCanvas !== 'undefined' && v instanceof OffscreenCanvas) ||
    (typeof ImageBitmap !== 'undefined' && v instanceof ImageBitmap));
}
function collectPlanes(v, set) {
  if (!v || typeof v !== 'object') return set;
  if (isPlane(v)) { set.add(v); return set; }
  if (Array.isArray(v)) { for (const x of v) collectPlanes(x, set); return set; }
  if (isPlain(v)) { for (const k of Object.keys(v)) collectPlanes(v[k], set); }
  return set;
}
const planeBytes = (c) => (c.width || 0) * (c.height || 0) * 4;

export const DEFAULT_EDGE = { feather: 0, shift: 0 };
export const DEFAULT_BG = { type: 'original', color: '#ffffff', color2: '#4a90e2', angle: 180, image: null, blur: 24 };
export const DEFAULT_FX = {
  shadow: { on: false, blur: 30, dx: 0, dy: 12, opacity: 0.35, color: '#000000' },
  stroke: { on: false, width: 12, color: '#ffffff' },
};
export const DEFAULT_ADJUST = {
  exposure: 0, brightness: 0, contrast: 0, saturation: 0, vibrance: 0, temperature: 0, tint: 0,
  highlights: 0, shadows: 0, sharpen: 0, vignette: 0, fade: 0, grain: 0,
  filter: 'none', filterStrength: 100,
};

/** Creates a complete document around an opaque RGB source canvas. */
export function createDoc({ source, name = '照片', ...rest }) {
  return {
    name,
    width: source.width,
    height: source.height,
    source,
    fg: null,
    mask: null,
    maskAI: null,
    cutout: false,
    edge: cloneData(DEFAULT_EDGE),
    bg: cloneData(DEFAULT_BG),
    fx: cloneData(DEFAULT_FX),
    adjust: cloneData(DEFAULT_ADJUST),
    layers: [],
    dpi: null,
    ...rest,
  };
}

const listeners = new Map();
let undoStack = [];
let redoStack = [];
// 512 MB keeps the tab light on PCs with little free RAM (mask strokes are stored alpha-only, see packImage)
let limits = { maxSteps: 80, maxBytes: 512 * 1024 * 1024 };

function snapshot(doc) { return cloneData(doc); }
function applySnapshot(doc, snap) {
  const s = cloneData(snap);
  for (const k of Object.keys(doc)) if (!(k in s)) delete doc[k];
  Object.assign(doc, s);
}

/**
 * Region undo data. Mask planes (RGB always 0) are kept as their alpha channel only — ¼ of the memory
 * of an RGBA ImageData. Any region whose RGB is all zero packs losslessly (unpack writes RGB = 0).
 */
function packImage(img) {
  if (!img || !img.data || img.packed) return img;
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) if (d[i] | d[i + 1] | d[i + 2]) return img;
  const alpha = new Uint8Array(d.length >> 2);
  for (let i = 0, j = 3; i < alpha.length; i++, j += 4) alpha[i] = d[j];
  return { packed: true, width: img.width, height: img.height, alpha };
}
function unpackImage(p) {
  if (!p || !p.packed) return p;
  const img = new ImageData(p.width, p.height);
  const d = img.data;
  for (let i = 0, j = 3; i < p.alpha.length; i++, j += 4) d[j] = p.alpha[i];
  return img;
}
const imgBytes = (img) => img?.data?.byteLength || img?.alpha?.byteLength || 0;

function entryBytes(e) {
  if (e.kind === 'region') return imgBytes(e.before) + imgBytes(e.after);
  if (e.kind === 'multi') return e.items.reduce((s, it) => s + imgBytes(it.before) + imgBytes(it.after), 0);
  return 0;
}

export const store = {
  doc: null,
  ui: {
    panel: null,
    tool: 'pan',
    selectedLayerId: null,
    brush: { size: 40, hardness: 0.7 },
    showMask: true,
    cutoutMode: 'general',
  },
  dirty: false,
  /** increments on every document change (any reason) */
  version: 0,

  on(evt, fn) {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(fn);
    return () => store.off(evt, fn);
  },
  off(evt, fn) { listeners.get(evt)?.delete(fn); },
  emit(evt, payload) {
    const set = listeners.get(evt);
    if (!set) return;
    for (const fn of [...set]) {
      try { fn(payload); } catch (err) { console.error(`[store] listener for "${evt}" failed:`, err); }
    }
  },

  setDoc(doc) {
    store.doc = doc;
    undoStack = [];
    redoStack = [];
    store.dirty = false;
    store.version++;
    store.ui.selectedLayerId = null;
    store.emit('doc:loaded', doc);
    store.emit('doc:changed', { reason: 'load' });
    store.emit('history:changed');
  },

  /**
   * Records an undo step (snapshot of all plain data; pixel planes by reference) and then runs
   * mutate(doc). Commits with the same `coalesce` key within 800 ms merge into one step.
   * Returns whatever mutate returns.
   */
  commit(label, mutate, opts = {}) {
    const doc = store.doc;
    if (!doc) return undefined;
    const now = performance.now();
    const top = undoStack[undoStack.length - 1];
    const key = opts.coalesce ?? null;
    let entry, isNew = false;
    if (key && top && top.kind === 'snap' && top.key === key && now - top.t < COALESCE_MS && redoStack.length === 0) {
      entry = top;
      entry.t = now;
      entry.label = label;
    } else {
      entry = { kind: 'snap', label, key, t: now, before: snapshot(doc), after: null };
      isNew = true;
    }
    let result;
    try {
      result = mutate(doc);
    } catch (err) {
      // roll back a failed mutation so the document never ends half-changed
      if (isNew) applySnapshot(doc, entry.before);
      throw err;
    }
    if (isNew) { undoStack.push(entry); redoStack = []; }
    store.dirty = true;
    store.version++;
    trimHistory();
    store.emit('doc:changed', { reason: 'commit', label });
    store.emit('history:changed');
    return result;
  },

  /**
   * Records a pixel region diff for a plane that a brush already mutated in place.
   * rect = {x,y,w,h} (doc px); before = ImageData of that rect before the stroke.
   * after is read from the plane if omitted. Also marks rect dirty (like bump) for the render caches.
   */
  commitRegion(label, planeName, rect, before, after) {
    const doc = store.doc;
    if (!doc) return;
    const canvas = typeof planeName === 'string' ? doc[planeName] : planeName;
    if (!canvas || !rect || rect.w <= 0 || rect.h <= 0) return;
    if (!after) after = canvas.getContext('2d').getImageData(rect.x, rect.y, rect.w, rect.h);
    bumpCanvas(canvas, rect); // the whole stroke area is final now → caches refresh it (covers un-bumped tails)
    undoStack.push({ kind: 'region', label, plane: typeof planeName === 'string' ? planeName : null, canvas, rect: { ...rect }, before: packImage(before), after: packImage(after), t: performance.now() });
    redoStack = [];
    store.dirty = true;
    store.version++;
    trimHistory();
    store.emit('doc:changed', { reason: 'commit', label, plane: planeName, rect });
    store.emit('history:changed');
  },

  /**
   * Like commitRegion but for several planes changed by ONE user action (one undo step), e.g. a mosaic
   * stroke that painted `source` and mirrored into `fg`. parts = [{ plane, rect, before, after? }, …]
   * (plane = doc field name or canvas; falsy parts are skipped).
   */
  commitRegions(label, parts) {
    const doc = store.doc;
    if (!doc) return;
    const items = [];
    for (const p of parts || []) {
      if (!p || !p.rect || p.rect.w <= 0 || p.rect.h <= 0 || !p.before) continue;
      const canvas = typeof p.plane === 'string' ? doc[p.plane] : p.plane;
      if (!canvas) continue;
      const after = p.after || canvas.getContext('2d').getImageData(p.rect.x, p.rect.y, p.rect.w, p.rect.h);
      bumpCanvas(canvas, p.rect);
      items.push({ plane: typeof p.plane === 'string' ? p.plane : null, canvas, rect: { ...p.rect }, before: packImage(p.before), after: packImage(after) });
    }
    if (!items.length) return;
    undoStack.push({ kind: 'multi', label, items, t: performance.now() });
    redoStack = [];
    store.dirty = true;
    store.version++;
    trimHistory();
    store.emit('doc:changed', { reason: 'commit', label, plane: items[0].plane, rect: items[0].rect });
    store.emit('history:changed');
  },

  /**
   * Ends the current coalescing run (called when a slider is released), so the next commit with the
   * same key starts a new undo step. With `key`, only a run with that key is ended.
   */
  endCoalesce(key) {
    const top = undoStack[undoStack.length - 1];
    if (top && top.kind === 'snap' && top.key && (key == null || top.key === key)) top.key = null;
  },

  canUndo() { return undoStack.length > 0; },
  canRedo() { return redoStack.length > 0; },
  undoLabel() { return undoStack[undoStack.length - 1]?.label ?? null; },
  redoLabel() { return redoStack[redoStack.length - 1]?.label ?? null; },
  historyInfo() { return { undo: undoStack.length, redo: redoStack.length, bytes: historyBytes(), labels: undoStack.map((e) => e.label) }; },

  undo() {
    const doc = store.doc;
    const e = undoStack.pop();
    if (!doc || !e) return false;
    if (e.kind === 'snap') {
      e.after = snapshot(doc);
      applySnapshot(doc, e.before);
    } else if (e.kind === 'multi') {
      for (const it of e.items) { it.canvas.getContext('2d').putImageData(unpackImage(it.before), it.rect.x, it.rect.y); bumpCanvas(it.canvas, it.rect); }
    } else {
      e.canvas.getContext('2d').putImageData(unpackImage(e.before), e.rect.x, e.rect.y);
      bumpCanvas(e.canvas, e.rect);
    }
    e.key = null; // never coalesce into an undone/redone step
    redoStack.push(e);
    store.dirty = true;
    store.version++;
    store.emit('doc:changed', { reason: 'undo', label: e.label, plane: e.plane, rect: e.rect });
    store.emit('history:changed');
    return true;
  },

  redo() {
    const doc = store.doc;
    const e = redoStack.pop();
    if (!doc || !e) return false;
    if (e.kind === 'snap') {
      applySnapshot(doc, e.after);
    } else if (e.kind === 'multi') {
      for (const it of e.items) { it.canvas.getContext('2d').putImageData(unpackImage(it.after), it.rect.x, it.rect.y); bumpCanvas(it.canvas, it.rect); }
    } else {
      e.canvas.getContext('2d').putImageData(unpackImage(e.after), e.rect.x, e.rect.y);
      bumpCanvas(e.canvas, e.rect);
    }
    undoStack.push(e);
    store.dirty = true;
    store.version++;
    store.emit('doc:changed', { reason: 'redo', label: e.label, plane: e.plane, rect: e.rect });
    store.emit('history:changed');
    return true;
  },

  /** Marks a plane (name of a doc field, or a canvas) as changed in place; rect limits the change. */
  bump(plane, rect) {
    const canvas = typeof plane === 'string' ? store.doc?.[plane] : plane;
    if (!canvas) return;
    bumpCanvas(canvas, rect);
    store.version++;
    store.emit('doc:changed', { reason: 'bump', plane, rect });
  },

  markSaved() { store.dirty = false; store.emit('history:changed'); },

  setHistoryLimits({ maxSteps, maxBytes } = {}) {
    if (maxSteps != null) limits.maxSteps = maxSteps;
    if (maxBytes != null) limits.maxBytes = maxBytes;
    trimHistory();
  },
  getHistoryLimits() { return { ...limits }; },
};

/** Version counter + dirty-rect log used by render caches for partial updates. */
export function bumpCanvas(canvas, rect) {
  canvas.__v = (canvas.__v || 0) + 1;
  const log = canvas.__log || (canvas.__log = []);
  log.push({ v: canvas.__v, rect: rect ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h } : null });
  if (log.length > 256) log.splice(0, log.length - 256);
}

/**
 * Union of rects changed on `canvas` since version `v`, or null if unknown (then recompute fully),
 * or 'clean' if nothing changed.
 */
export function dirtySince(canvas, v) {
  const cur = canvas.__v || 0;
  if (cur === v) return 'clean';
  const log = canvas.__log;
  if (!log || cur < v) return null;
  let rect = null, n = 0;
  for (const e of log) {
    if (e.v <= v) continue;
    if (!e.rect) return null;
    n++;
    rect = rect ? unionRect(rect, e.rect) : { ...e.rect };
  }
  return n === cur - v ? rect : null;
}

export function unionRect(a, b) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function historyBytes() {
  const doc = store.doc;
  const current = doc ? collectPlanes(doc, new Set()) : new Set();
  const planes = new Set();
  let bytes = 0;
  for (const e of [...undoStack, ...redoStack]) {
    if (e.kind === 'region' || e.kind === 'multi') bytes += entryBytes(e);
    else { collectPlanes(e.before, planes); if (e.after) collectPlanes(e.after, planes); }
  }
  for (const c of planes) if (!current.has(c)) bytes += planeBytes(c);
  return bytes;
}

function trimHistory() {
  let guard = 0;
  while (guard++ < 1000) {
    const over = undoStack.length > limits.maxSteps || historyBytes() > limits.maxBytes;
    if (!over) break;
    if (undoStack.length > 1) { undoStack.shift(); continue; }
    if (redoStack.length > 0) { redoStack.shift(); continue; }
    break; // always keep the newest step
  }
}
