// panels/beauty.js — 美颜: 磨皮 / 美白 through /api/retouch (face-aware skin retouch on the local server).
//
// Every result is recomputed from the pre-beauty photo ("base", remembered per result canvas), so moving
// both sliders back to 0 gives the original back exactly, and each slider release is ONE undo step
// (source + fg swapped in one commit). While the server works a small inline indicator shows progress;
// on big photos a quick low-resolution preview is drawn over the canvas first. Photos above ~12 MP are
// sent downscaled and the change is scaled back up onto the full-size photo.
//
// Exports for tests: mergeRetouch(base, sent, out), retouchKey(...), beautyStateOf(canvas), MAX_SEND_PX.

import { registerPanel } from '../core/panels.js';
import { store, uidOf } from '../core/store.js';
import { h, section, slider, toggle, button, toast } from '../core/ui.js';
import { icon } from '../core/icons.js';
import * as api from '../core/api.js';
import { replaceSource, syncFg } from '../core/actions.js';
import { createCanvas, resizeCanvas, canvasToBlob, blobToDataURL, dataURLToCanvas, grayFromMask } from '../core/io.js';
import { renderDoc } from '../core/render.js';

/** Largest photo sent as is (4096 × 3072 ≈ 12.6 MP, the biggest 4:3 photo the app opens). */
export const MAX_SEND_PX = 4096 * 3072;
const PREVIEW_SIDE = 1100;              // quick preview size (long side) for photos bigger than…
const PREVIEW_MIN_PX = 1.6e6;           // …this; smaller photos are fast enough on their own
const PREVIEW_DELAY = 320;              // ms of stillness while dragging before a preview is requested

// ---------------------------------------------------------------- per-result state
// result canvas → { base, fgBase, fgOut, smooth, whiten, personOnly, v }. Undo/redo swap doc.source by
// reference, so looking the current source up here always gives the right slider values and base.
const states = new WeakMap();
export function beautyStateOf(src) {
  const st = src && states.get(src);
  return st && st.v === (src.__v || 0) ? st : null; // edited in place since (brush) → it is a new base
}
const personPref = () => store.ui.beautyPersonOnly ?? true;
function committed(doc) {
  const st = beautyStateOf(doc.source);
  return st ? { smooth: st.smooth, whiten: st.whiten, personOnly: st.personOnly } : { smooth: 0, whiten: 0, personOnly: personPref() };
}
const usesMask = (doc, p) => !!(p.personOnly && doc.cutout && doc.mask);
export function retouchKey(base, p, mask, kind) {
  const m = mask ? `${uidOf(mask)}.${mask.__v || 0}` : '-';
  return `${kind}:${uidOf(base)}.${base.__v || 0}|${p.smooth}|${p.whiten}|${m}`;
}

// ---------------------------------------------------------------- pixel helpers
function readAll(c) { return c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data; }

/**
 * Puts a server result back onto the full-size photo. sent = the canvas that was sent (base itself or a
 * downscaled copy), out = the decoded result (same size as sent). Returns { canvas, rect } where rect is
 * the changed area in base px, or { canvas: base, rect: null } when nothing changed. Unchanged pixels
 * stay bit-identical to base; for a downscaled round trip the change (out − sent) is scaled up bilinearly
 * and added to the full-resolution pixels, so no detail is lost outside the retouched skin.
 */
export function mergeRetouch(base, sent, out, sentPixels = null) {
  const w = sent.width, hh = sent.height, W = base.width, H = base.height;
  if (out.width !== w || out.height !== hh) throw new Error('美颜结果尺寸不对，请重试');
  const a = sentPixels || readAll(sent), b = readAll(out);
  const a32 = new Uint32Array(a.buffer, a.byteOffset, a.length >> 2), b32 = new Uint32Array(b.buffer, b.byteOffset, b.length >> 2);
  let x0 = w, y0 = hh, x1 = -1, y1 = -1;
  for (let y = 0; y < hh; y++) {
    const row = y * w;
    let first = -1, last = -1;
    for (let x = 0; x < w; x++) if (((a32[row + x] ^ b32[row + x]) & 0x00ffffff) !== 0) { if (first < 0) first = x; last = x; }
    if (first >= 0) { if (first < x0) x0 = first; if (last > x1) x1 = last; if (y < y0) y0 = y; y1 = y; }
  }
  if (x1 < 0) return { canvas: base, rect: null };
  if (w === W && hh === H) {
    const c = createCanvas(W, H); // a normal (GPU) canvas like every doc.source
    c.getContext('2d').drawImage(out, 0, 0);
    return { canvas: c, rect: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } };
  }
  // downscaled round trip: delta in the changed box (+1 px so bilinear taps at its edge are defined)
  const bx0 = Math.max(0, x0 - 1), by0 = Math.max(0, y0 - 1), bx1 = Math.min(w - 1, x1 + 1), by1 = Math.min(hh - 1, y1 + 1);
  const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
  const delta = new Int16Array(bw * bh * 3);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = ((by0 + y) * w + bx0 + x) * 4, j = (y * bw + x) * 3;
      delta[j] = b[i] - a[i]; delta[j + 1] = b[i + 1] - a[i + 1]; delta[j + 2] = b[i + 2] - a[i + 2];
    }
  }
  const kx = W / w, ky = H / hh;
  const RX = Math.max(0, Math.floor(bx0 * kx)), RY = Math.max(0, Math.floor(by0 * ky));
  const RW = Math.min(W, Math.ceil((bx1 + 1) * kx)) - RX, RH = Math.min(H, Math.ceil((by1 + 1) * ky)) - RY;
  const res = createCanvas(W, H);
  const ctx = res.getContext('2d');
  ctx.drawImage(base, 0, 0);
  const img = base.getContext('2d', { willReadFrequently: true }).getImageData(RX, RY, RW, RH);
  const d = img.data;
  for (let Y = 0; Y < RH; Y++) {
    const sy = Math.min(bh - 1, Math.max(0, (RY + Y + 0.5) / ky - 0.5 - by0));
    const iy = Math.min(bh - 2, Math.floor(sy)), fy = bh > 1 ? sy - iy : 0;
    for (let X = 0; X < RW; X++) {
      const sx = Math.min(bw - 1, Math.max(0, (RX + X + 0.5) / kx - 0.5 - bx0));
      const ix = Math.min(bw - 2, Math.floor(sx)), fx = bw > 1 ? sx - ix : 0;
      const i00 = (Math.max(0, iy) * bw + Math.max(0, ix)) * 3;
      const i01 = i00 + (bw > 1 ? 3 : 0), i10 = i00 + (bh > 1 ? bw * 3 : 0), i11 = i10 + (bw > 1 ? 3 : 0);
      const o = (Y * RW + X) * 4;
      for (let c = 0; c < 3; c++) {
        const v = (delta[i00 + c] * (1 - fx) + delta[i01 + c] * fx) * (1 - fy) + (delta[i10 + c] * (1 - fx) + delta[i11 + c] * fx) * fy;
        if (v) d[o + c] = d[o + c] + v; // Uint8ClampedArray rounds and clamps
      }
    }
  }
  ctx.putImageData(img, RX, RY);
  return { canvas: res, rect: { x: RX, y: RY, w: RW, h: RH } };
}

// ---------------------------------------------------------------- server round trips
const encCache = new Map(); // `${uid}.${v}@${w}x${h}` → Promise<dataURL> (the photo / mask as sent; last 4)
function encodePNG(key, make) {
  if (!encCache.has(key)) {
    const p = (async () => blobToDataURL(await canvasToBlob(make(), 'image/png')))();
    p.catch(() => encCache.delete(key));
    encCache.set(key, p);
    while (encCache.size > 4) encCache.delete(encCache.keys().next().value);
  }
  return encCache.get(key);
}
function sendSize(base, kind) {
  const W = base.width, H = base.height;
  const k = kind === 'prev' ? Math.min(1, PREVIEW_SIDE / Math.max(W, H)) : Math.min(1, Math.sqrt(MAX_SEND_PX / (W * H)));
  return [Math.max(1, Math.round(W * k)), Math.max(1, Math.round(H * k))];
}
const sentCache = new Map(); // downscaled copies of base (key → canvas), last 2
function sentCanvas(base, w, hh) {
  if (base.width === w && base.height === hh) return base;
  const key = `${uidOf(base)}.${base.__v || 0}@${w}x${hh}`;
  let c = sentCache.get(key);
  if (!c) {
    c = resizeCanvas(base, w, hh, { willRead: true });
    sentCache.set(key, c);
    while (sentCache.size > 2) sentCache.delete(sentCache.keys().next().value);
  }
  return c;
}

// pixels of the photo as sent (read once per photo — repeated slider releases reuse them)
let sentPix = null; // { key, data }
function sentPixels(c) {
  const key = `${uidOf(c)}.${c.__v || 0}`;
  if (sentPix?.key !== key) sentPix = { key, data: readAll(c) };
  return sentPix.data;
}

/** One /api/retouch call. kind 'prev' → { canvas: small result } · 'full' → mergeRetouch() result. */
async function computeRetouch(req, kind) {
  const { base, p, mask } = req;
  if (!p.smooth && !p.whiten) return { canvas: base, rect: null, ms: 0 };
  const [w, hh] = sendSize(base, kind);
  const sent = sentCanvas(base, w, hh);
  const image = await encodePNG(`${uidOf(base)}.${base.__v || 0}@${w}x${hh}`, () => sent);
  const maskURL = mask ? await encodePNG(`m${uidOf(mask)}.${mask.__v || 0}@${w}x${hh}`,
    () => { const g = grayFromMask(mask); return g.width === w && g.height === hh ? g : resizeCanvas(g, w, hh); }) : null;
  const r = await api.retouch({ image, smooth: p.smooth, whiten: p.whiten, mask: maskURL });
  const out = await dataURLToCanvas(r.image, { willRead: true });
  if (kind === 'prev') {
    if (out.width !== w || out.height !== hh) throw new Error('美颜结果尺寸不对，请重试');
    return { canvas: out, ms: r.ms };
  }
  return { ...mergeRetouch(base, sent, out, sentPixels(sent)), ms: r.ms };
}

// ---------------------------------------------------------------- job queue (module level: a release keeps
// its commit even if the panel is switched meanwhile). One request at a time — the server queues them anyway.
// key → result. Full-size results are big (48 MB each on 12 MP) → only the last 2 are kept; previews are small.
const results = new Map();
function remember(key, res) {
  results.set(key, res);
  for (const [kind, max] of [['full:', 2], ['prev:', 4]]) {
    const keys = [...results.keys()].filter((k) => k.startsWith(kind));
    for (let i = 0; i < keys.length - max; i++) results.delete(keys[i]);
  }
}
const job = { wantFull: null, wantPrev: null, running: null, t0: 0, listeners: new Set(), lastMs: 0, error: null };
let panelShown = 0; // while the panel is open its status line shows errors → no extra toast
const emit = () => { for (const fn of job.listeners) { try { fn(); } catch (err) { console.error(err); } } };

function makeReq(doc, p) {
  const st = beautyStateOf(doc.source);
  const base = st ? st.base : doc.source;
  const mask = usesMask(doc, p) ? doc.mask : null;
  const req = { doc, from: doc.source, fromV: doc.source.__v || 0, base, p: { ...p }, mask, maskV: mask?.__v || 0 };
  req.full = retouchKey(base, req.p, mask, 'full');
  req.prev = retouchKey(base, req.p, mask, 'prev');
  req.big = base.width * base.height > PREVIEW_MIN_PX;
  return req;
}
const stillValid = (req) => store.doc === req.doc && req.doc.source === req.from && (req.from.__v || 0) === req.fromV
  && (usesMask(req.doc, req.p) ? req.doc.mask : null) === req.mask && (req.mask?.__v || 0) === req.maskV;
const isNoop = (req) => !req.p.smooth && !req.p.whiten;

function nextTask() {
  const f = job.wantFull;
  if (f && !stillValid(f)) job.wantFull = null;
  if (job.wantPrev && !stillValid(job.wantPrev)) job.wantPrev = null;
  if (job.wantFull) {
    if (!results.has(f.full)) return f.big && !results.has(f.prev) && !isNoop(f) ? [f, 'prev'] : [f, 'full'];
    return null;
  }
  const pv = job.wantPrev;
  if (pv && !isNoop(pv) && !results.has(pv.prev) && !results.has(pv.full)) return [pv, pv.big ? 'prev' : 'full'];
  return null;
}

async function pump() {
  if (job.running) return;
  for (let t = nextTask(); t; t = nextTask()) {
    const [req, kind] = t;
    job.running = { req, kind };
    job.t0 = performance.now();
    job.error = null;
    emit();
    try {
      const res = await computeRetouch(req, kind);
      remember(kind === 'prev' ? req.prev : req.full, res);
      if (kind === 'full') job.lastMs = res.ms;
    } catch (err) {
      job.running = null;
      job.error = err.message || '美颜失败，请重试';
      job.wantFull = null; // the server is failing — nothing stays queued; the user can simply try again
      job.wantPrev = null;
      if (!panelShown) toast(job.error, 'error');
      emit();
      return;
    }
    job.running = null;
    tryCommit();
    emit();
  }
  tryCommit();
  emit();
}

const LABEL = { smooth: '美颜：磨皮', whiten: '美颜：美白', personOnly: '美颜：仅人物区域', reset: '取消美颜' };

function tryCommit() {
  const req = job.wantFull;
  if (!req) return;
  if (!stillValid(req)) { job.wantFull = null; return; }
  const res = isNoop(req) ? { canvas: req.base, rect: null } : results.get(req.full);
  if (!res) return;
  job.wantFull = null;
  if (job.wantPrev && job.wantPrev.full === req.full) job.wantPrev = null;
  const doc = req.doc;
  if (!isNoop(req) && !res.rect) {
    // the server found nothing to retouch (no skin) — keep the photo as it is
    job.error = '这张照片里没找到需要美颜的皮肤，照片没有改动';
    if (!panelShown) toast(job.error, 'warning');
    return;
  }
  if (res.canvas === doc.source) return; // already showing exactly this
  const out = res.canvas;
  const st = beautyStateOf(doc.source);
  // the fg (去色边 copy of the photo for the cut-out subject) must follow; computed from the pre-beauty
  // fg when we still know it, so going back to 0 also restores the fg exactly
  const fgBase = st ? (doc.fg === st.fgOut ? st.fgBase : undefined) : doc.fg;
  const label = LABEL[req.what] || '美颜';
  let fgOut;
  if (fgBase === undefined) {
    replaceSource(label, out, { rect: null });          // unknown history → classic sync against the current fg
    fgOut = store.doc.fg;
  } else if (!fgBase) {
    replaceSource(label, out, { rect: res.rect });       // no cut-out: fg stays null
    fgOut = null;
  } else {
    fgOut = out === req.base ? fgBase : syncFg(req.base, out, fgBase, res.rect);
    store.commit(label, (d) => { d.source = out; d.fg = fgOut; });
  }
  if (out !== req.base) {
    states.set(out, { base: req.base, fgBase, fgOut, smooth: req.p.smooth, whiten: req.p.whiten, personOnly: req.p.personOnly, v: out.__v || 0 });
  }
}

/** The user let go of a control: compute and commit these values (one undo step). */
function wantCommit(doc, p, what) {
  const req = makeReq(doc, p);
  req.what = what;
  const cur = committed(doc);
  if (cur.smooth === req.p.smooth && cur.whiten === req.p.whiten && (cur.personOnly === req.p.personOnly || isNoop(req))) {
    job.wantFull = null; job.wantPrev = null; emit();
    return;
  }
  job.wantFull = req;
  job.wantPrev = req;
  if (isNoop(req)) { tryCommit(); emit(); return; }
  pump();
  emit();
}
/** Values are being dragged: after a short pause ask for a quick preview. */
function wantPreview(doc, p) {
  const req = makeReq(doc, p);
  job.wantPrev = req;
  pump();
  emit();
}

/**
 * Retouches the current photo exactly like the sliders do (from its pre-beauty base, one undo step).
 * values: { smooth?, whiten?, personOnly? } (missing ones keep the current values). Resolves true when a
 * new photo was committed, false when nothing changed or the server failed (the error is shown as a toast).
 */
export function applyBeauty(values = {}, what = 'smooth') {
  const doc = store.doc;
  if (!doc) return Promise.resolve(false);
  const p = { ...committed(doc), ...values };
  return new Promise((resolve) => {
    const before = doc.source;
    const done = () => {
      if (job.wantFull || job.running) return;
      job.listeners.delete(done);
      resolve(store.doc === doc && doc.source !== before);
    };
    job.listeners.add(done);
    wantCommit(doc, p, what);
    done();
  });
}

// ---------------------------------------------------------------- face check (hint only; /api/faces is fast)
const faceChecks = new WeakMap(); // base canvas → Promise<number|null>
function countFaces(base) {
  if (!faceChecks.has(base)) {
    const p = (async () => {
      const k = Math.min(1, 1280 / Math.max(base.width, base.height));
      const small = k < 1 ? resizeCanvas(base, base.width * k, base.height * k) : base;
      const r = await api.faces(await canvasToBlob(small, 'image/jpeg', 0.9));
      return (r.faces || []).filter((f) => (f.score ?? 1) >= 0.6).length;
    })().catch(() => null);
    faceChecks.set(base, p);
  }
  return faceChecks.get(base);
}

// ---------------------------------------------------------------- panel
registerPanel({
  id: 'beauty',
  title: '美颜',
  icon: icon('beauty', 22),
  order: 50,
  tip: '磨皮、美白',
  mount(el, ctx) {
    const { viewport } = ctx;
    const faceLine = h('div', { class: 'bt-face', hidden: true });
    const intro = h('div', { class: 'bt-intro' },
      h('div', { class: 'bt-art', html: icon('beauty', 24) }),
      h('div', { class: 'bt-text' },
        h('div', { class: 'bt-title' }, '自然美颜'),
        h('div', { class: 'bt-sub' }, '自动找到人脸，只美化皮肤，眼睛、眉毛和嘴唇保持清晰')));

    const ui = { ...committed(store.doc) }; // values shown on the sliders (may be ahead of the photo)
    let pauseTimer = 0;
    const onDrag = () => {
      clearTimeout(pauseTimer);
      pauseTimer = setTimeout(() => { if (store.doc) wantPreview(store.doc, ui); }, PREVIEW_DELAY);
      render();
    };
    const smooth = slider({ label: '磨皮', min: 0, max: 100, defaultValue: 0, value: ui.smooth, hint: '让皮肤更光滑，保留自然质感',
      onInput: (v) => { ui.smooth = v; onDrag(); },
      onChange: (v) => { ui.smooth = v; clearTimeout(pauseTimer); wantCommit(store.doc, ui, 'smooth'); } });
    const whiten = slider({ label: '美白', min: 0, max: 100, defaultValue: 0, value: ui.whiten, hint: '提亮肤色，减少发黄、暗沉',
      onInput: (v) => { ui.whiten = v; onDrag(); },
      onChange: (v) => { ui.whiten = v; clearTimeout(pauseTimer); wantCommit(store.doc, ui, 'whiten'); } });
    smooth.classList.add('bt-smooth'); whiten.classList.add('bt-whiten');
    const person = toggle({ label: '仅人物区域', hint: '只美化抠出来的人物，背景一点都不动', value: ui.personOnly,
      onChange: (v) => {
        ui.personOnly = v; store.ui.beautyPersonOnly = v;
        if (ui.smooth || ui.whiten) wantCommit(store.doc, ui, 'personOnly'); else render();
      } });
    person.classList.add('bt-person');

    const statusIco = h('span', { class: 'bt-st-ico' });
    const statusText = h('span', { class: 'bt-st-text' });
    const status = h('div', { class: 'bt-status', role: 'status', 'aria-live': 'polite', hidden: true }, statusIco, statusText);

    // hold to see the photo before 美颜 (drawn over the canvas while pressed)
    let comparing = false;
    const cmpBtn = button({ text: '按住对比', icon: 'compare', variant: 'secondary', tip: '按住看美颜前的样子，松开恢复', className: 'bt-compare' });
    const endCompare = () => { if (comparing) { comparing = false; cmpBtn.classList.remove('pressed'); refreshOverlay(); } };
    cmpBtn.addEventListener('pointerdown', (e) => {
      if (cmpBtn.disabled || e.button !== 0) return;
      comparing = true; cmpBtn.classList.add('pressed');
      try { cmpBtn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      refreshOverlay();
    });
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) cmpBtn.addEventListener(t, endCompare);
    const resetBtn = button({ text: '恢复原样', icon: 'reset', variant: 'secondary', tip: '去掉磨皮和美白（可以撤销）',
      onClick: () => { ui.smooth = 0; ui.whiten = 0; smooth.setValue(0); whiten.setValue(0); wantCommit(store.doc, ui, 'reset'); } });

    const sec = section('');
    sec.querySelector('.sec-h').remove();
    sec.append(intro, faceLine, smooth, whiten, person, status, h('div', { class: 'row bt-actions' }, cmpBtn, resetBtn),
      h('div', { class: 'hint' }, '松开滑块后稍等片刻就能看到效果'));
    el.append(sec);

    // ---------------------------------------------------------- overlay: quick preview / 对比
    let ov = null; // { key, canvas }
    const removeOverlay = viewport.addOverlay((octx, vp) => {
      if (!ov || !store.doc) return;
      const r = vp.docRect();
      octx.imageSmoothingEnabled = true; octx.imageSmoothingQuality = 'high';
      octx.drawImage(ov.canvas, r.x, r.y, r.w, r.h);
      if (ov.badge) {
        octx.font = '600 13px "Microsoft YaHei UI", sans-serif';
        const tw = octx.measureText(ov.badge).width + 24;
        const x = vp.width / 2 - tw / 2, y = 14;
        octx.fillStyle = 'rgba(17, 20, 28, 0.72)';
        octx.beginPath(); octx.roundRect(x, y, tw, 28, 14); octx.fill();
        octx.fillStyle = '#fff'; octx.textAlign = 'center'; octx.textBaseline = 'middle';
        octx.fillText(ov.badge, vp.width / 2, y + 14.5);
      }
    });
    ctx.onDispose(removeOverlay);
    function overlayDoc(source, fg) {
      const d = store.doc;
      const s = Math.min(1, Math.max(0.05, (viewport.zoom * viewport.dpr) || 1));
      return renderDoc({ ...d, source, fg }, { scale: s });
    }
    function refreshOverlay() {
      const d = store.doc;
      let next = null;
      if (d && comparing) {
        const st = beautyStateOf(d.source);
        const base = st ? st.base : d.source;
        const key = `cmp:${uidOf(base)}:${d.source === base}`;
        next = ov?.key === key ? ov : { key, zoom: viewport.zoom, canvas: base === d.source ? null : overlayDoc(base, st && d.fg === st.fgOut && st.fgBase !== undefined ? st.fgBase : d.fg), badge: '美颜前' };
        if (!next.canvas) next = null;
      } else if (d) {
        const want = job.wantFull || job.wantPrev;
        if (want && stillValid(want)) {
          const full = results.get(want.full), prev = results.get(want.prev);
          const src = isNoop(want) ? want.base : full ? full.canvas : prev ? prev.canvas : null;
          const key = src ? `pv:${uidOf(src)}` : null;
          if (src && src !== d.source) next = ov?.key === key ? ov : { key, zoom: viewport.zoom, canvas: overlayDoc(src, null) };
          else if (!src && ov && ov.key.startsWith('pv:')) next = ov; // keep the last preview until the next one arrives
        }
      }
      if (next !== ov) { ov = next; viewport.requestOverlay(); }
    }

    // ---------------------------------------------------------- face hint
    let faceFor = null;
    function checkFaces() {
      const d = store.doc;
      if (!d) return;
      const st = beautyStateOf(d.source);
      const base = st ? st.base : d.source;
      if (faceFor === base) return;
      faceFor = base;
      faceLine.hidden = false;
      faceLine.className = 'bt-face working';
      faceLine.innerHTML = '';
      faceLine.append(h('span', { class: 'bt-spin' }), h('span', {}, '正在识别人脸…'));
      countFaces(base).then((n) => {
        if (faceFor !== base) return;
        faceLine.innerHTML = '';
        if (n == null) { faceLine.hidden = true; faceLine.className = 'bt-face'; return; }
        if (n > 0) {
          faceLine.className = 'bt-face ok';
          faceLine.append(h('span', { html: icon('success', 16) }), h('span', {}, n === 1 ? '已识别到人脸' : `已识别到 ${n} 张人脸`));
        } else {
          faceLine.className = 'bt-face warn';
          faceLine.append(h('span', { html: icon('alert', 16) }),
            h('span', {}, '没找到清晰的人脸。美颜会按肤色大致处理，效果可能不明显；人像照片效果最好。'));
        }
      });
    }

    // ---------------------------------------------------------- status + sync
    let tick = 0;
    function render() {
      const d = store.doc;
      if (!d) return;
      const cut = !!(d.cutout && d.mask);
      person.hidden = !cut;
      const cur = committed(d);
      const pending = !!(job.wantFull || job.running);
      resetBtn.setDisabled(!cur.smooth && !cur.whiten && !(job.wantFull && (job.wantFull.p.smooth || job.wantFull.p.whiten)));
      cmpBtn.setDisabled(!beautyStateOf(d.source) && !(ov && !comparing) && !comparing);
      clearInterval(tick);
      status.classList.remove('working', 'ok', 'err', 'warn');
      if (pending) {
        const r = job.running;
        const previewing = r?.kind === 'prev';
        const upd = () => {
          const s = Math.floor((performance.now() - job.t0) / 1000);
          statusText.textContent = (previewing ? '正在生成预览…' : ov && !comparing ? '预览中，正在生成高清效果…' : '正在美颜…') + (s >= 1 && !previewing ? ` ${s} 秒` : '');
        };
        status.hidden = false;
        status.classList.add('working');
        statusIco.className = 'bt-st-ico bt-spin';
        statusIco.innerHTML = '';
        upd();
        tick = setInterval(upd, 500);
      } else if (ov && !comparing && ov.key.startsWith('pv:')) {
        status.hidden = false;
        statusIco.className = 'bt-st-ico';
        statusIco.innerHTML = icon('eye', 16);
        statusText.textContent = '这是预览，松开滑块就会应用';
      } else if (job.error) {
        status.hidden = false;
        status.classList.add(job.error.includes('没找到') ? 'warn' : 'err');
        statusIco.className = 'bt-st-ico';
        statusIco.innerHTML = icon('alert', 16);
        statusText.textContent = job.error;
      } else if (cur.smooth || cur.whiten) {
        status.hidden = false;
        status.classList.add('ok');
        statusIco.className = 'bt-st-ico';
        statusIco.innerHTML = icon('success', 16);
        statusText.textContent = job.lastMs ? `美颜已应用 · 用时 ${(job.lastMs / 1000).toFixed(1)} 秒` : '美颜已应用';
      } else status.hidden = true;
    }
    function sync() {
      const d = store.doc;
      if (!d) return;
      // slider values follow the photo unless the user is ahead of it (a pending release / drag)
      const busyForThis = (job.wantFull && stillValid(job.wantFull)) || (job.wantPrev && stillValid(job.wantPrev));
      if (!busyForThis) {
        Object.assign(ui, committed(d));
        smooth.setValue(ui.smooth); whiten.setValue(ui.whiten); person.setValue(ui.personOnly);
      }
      checkFaces();
      refreshOverlay();
      render();
    }
    const onJob = () => { if (!store.doc) return; sync(); };
    job.listeners.add(onJob);
    panelShown++;
    ctx.onDispose(() => { panelShown--; job.listeners.delete(onJob); clearInterval(tick); clearTimeout(pauseTimer); comparing = false; });
    ctx.on('doc:changed', (p) => { if (p?.reason !== 'bump') { job.error = null; sync(); } });
    // zoom changed → redraw the overlay at the new resolution (a pan just moves it)
    ctx.on('view:changed', () => { if (ov && ov.zoom !== viewport.zoom) { ov = null; refreshOverlay(); viewport.requestOverlay(); } });
    sync();
  },
});
