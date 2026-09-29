// core/actions.js — app-level actions shared by the top bar, panels and shortcuts.
//
//   openImage()                       file picker → loadFile
//   loadFile(file, { name })          confirm-if-unsaved → decode → new document
//   runCutout({ mode, then, label })  /api/matte → mask/maskAI/fg, cutout=true (one undo step; `then(doc)` runs inside it)
//   ensureCutout(then, reason?)       if not cut out yet → offers 一键抠图 first (then(doc) applied in the same step)
//   cancelCutout()  restoreAI()  setDecontam(on)
//   replaceSource(label, newSource, { rect, then })   one undo step: swap in an edited photo, keep fg in sync
//   syncFg(oldSource, newSource, fg, rect?) → new fg canvas (changed pixels take the new photo)
//   saveToOutput()                    render → /api/save → toast with 「打开文件夹」
//   nextFrame()                       resolves after the browser painted (use before heavy sync work)

import { store, createDoc, cloneData } from './store.js';
import * as api from './api.js';
import { toast, busy, confirm, pickFiles } from './ui.js';
import { loadImageFile, splitAlpha, cloneCanvas, createCanvas } from './io.js';
import { clearRenderCache } from './render.js';
import { exportDoc, defaultSaveFormat, suggestFilename } from './exporter.js';

export const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

// ---------------------------------------------------------------- open
export async function openImage() {
  const input = document.getElementById('file-input');
  if (input) { input.value = ''; input.click(); return true; } // change handler (main.js) calls loadFile
  const files = await pickFiles({ accept: 'image/*,.jpg,.jpeg,.png,.webp,.bmp,.gif' });
  if (files[0]) return loadFile(files[0]);
  return false;
}

export async function loadFile(file, { name } = {}) {
  if (!file) return false;
  if (store.doc && store.dirty) {
    const ok = await confirm('当前图片的修改还没有保存。打开新图片后，这些修改会丢失。', { title: '打开新图片？', okText: '打开新图片', cancelText: '先不打开' });
    if (!ok) return false;
  }
  const b = busy('正在打开图片…');
  try {
    await nextFrame();
    const c = await loadImageFile(file);
    const meta = c.meta;
    let doc;
    if (meta.hasAlpha) {
      const { source, mask, fg } = splitAlpha(c);
      doc = createDoc({ source, name: name || meta.name });
      doc.mask = mask;
      doc.fg = fg; // original colours of the soft edge (no white halo); 去色边 off/on toggles it
      if (fg) fgCache.set(source, fg);
      doc.maskAI = cloneCanvas(mask);
      doc.cutout = true;
      doc.bg.type = 'transparent';
    } else {
      doc = createDoc({ source: c, name: name || meta.name });
    }
    store.ui.brush.size = Math.max(8, Math.min(300, Math.round(Math.min(doc.width, doc.height) * 0.04)));
    store.emit('brush:changed', store.ui.brush);
    clearRenderCache();
    store.setDoc(doc);
    if (meta.downscaled) toast(`图片很大（${meta.origWidth}×${meta.origHeight}），已缩小到 ${doc.width}×${doc.height}，处理更流畅`, 'info', { duration: 5000 });
    if (meta.hasAlpha) toast('这张图片本身带透明背景，已当作抠好的图打开', 'info', { duration: 5000 });
    return true;
  } catch (err) {
    toast(err.message || '打开图片失败', 'error');
    return false;
  } finally {
    b.done();
  }
}

// ---------------------------------------------------------------- cutout
const fgCache = new WeakMap(); // source canvas → decontaminated fg (kept while 去色边 is off)
let cutoutRunning = false;
export const isCutoutRunning = () => cutoutRunning;

/** The server sends only a 去色边 patch (opaque where the soft-edge colour was corrected, transparent
 *  elsewhere); painting it over a copy of the photo gives the fg plane, lossless everywhere else. */
function mergeFg(source, patch) {
  const out = createCanvas(source.width, source.height);
  const octx = out.getContext('2d');
  octx.drawImage(source, 0, 0);
  octx.drawImage(patch.canvas, patch.x, patch.y);
  return out;
}

function maskCoverage(mask) {
  const t = createCanvas(64, 64);
  const ctx = t.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(mask, 0, 0, 64, 64);
  const d = ctx.getImageData(0, 0, 64, 64).data;
  let sum = 0;
  for (let i = 3; i < d.length; i += 4) sum += d[i];
  return sum / (64 * 64 * 255);
}

export async function runCutout({ mode = store.ui.cutoutMode || 'general', then = null, label = '一键抠图' } = {}) {
  const doc = store.doc;
  if (!doc) { toast('请先打开一张图片', 'warning'); return false; }
  if (cutoutRunning) return false;
  cutoutRunning = true;
  store.emit('cutout:running', true);
  const b = busy(mode === 'portrait' ? '正在抠人像（发丝模式），首次会稍慢…' : '正在抠图，首次会稍慢…');
  const src = doc.source, version = store.version;
  const stale = () => store.doc !== doc || doc.source !== src || store.version !== version;
  try {
    await nextFrame();
    if (stale()) return false;
    const r = await api.matteCanvas(src, { mode, decontam: true });
    if (stale()) return false;
    b.update('正在整理边缘…');
    await nextFrame();
    if (stale()) return false;
    const fg = r.fg ? mergeFg(src, r.fg) : null;
    if (fg) fgCache.set(src, fg);
    const maskAI = cloneCanvas(r.mask);
    maskAI.__matte = { mode: r.mode, ms: r.ms }; // per-result info for the 抠图 panel (survives undo/redo: kept by reference)
    const wasCut = doc.cutout;
    store.commit(label, (d) => {
      d.mask = r.mask;
      d.maskAI = maskAI;
      d.fg = fg;
      d.cutout = true;
      if (!wasCut && d.bg.type === 'original') d.bg.type = 'transparent';
      then?.(d);
    });
    store.ui.lastMatte = { mode: r.mode, ms: r.ms };
    const cov = maskCoverage(r.mask);
    if (cov < 0.004) toast('没有找到明显的主体。可以换「人像发丝」模式试试，或用下方画笔手动涂出要保留的部分', 'warning', { duration: 7000 });
    else if (r.warning) toast(`抠图完成。${r.warning}`, 'warning', { duration: 7000 });
    else toast(`抠图完成，用时 ${((r.ms || 0) / 1000).toFixed(1)} 秒`, 'success');
    return true;
  } catch (err) {
    toast(err.message || '抠图失败，请重试', 'error');
    return false;
  } finally {
    b.done();
    cutoutRunning = false;
    store.emit('cutout:running', false);
  }
}

/** Runs `then(doc)` (inside a commit) — if there is no cutout yet, first offers 一键抠图. */
export async function ensureCutout(then, { label = '更换背景', reason = '换背景需要先把主体抠出来。' } = {}) {
  const doc = store.doc;
  if (!doc) { toast('请先打开一张图片', 'warning'); return false; }
  if (doc.cutout && doc.mask) { store.commit(label, then); return true; }
  const ok = await confirm(`${reason}现在自动「一键抠图」吗？`, { title: '需要先抠图', okText: '一键抠图', cancelText: '取消' });
  if (!ok) return false;
  return runCutout({ then, label: `一键抠图 + ${label}` });
}

export function cancelCutout() {
  if (!store.doc?.cutout) return;
  store.commit('取消抠图', (d) => {
    d.cutout = false;
    d.mask = null;
    d.maskAI = null;
    d.fg = null;
    if (d.bg.type === 'transparent') d.bg.type = 'original';
  });
  toast('已取消抠图，可按 Ctrl+Z 撤销', 'info');
}

export function restoreAI() {
  const d0 = store.doc;
  if (!d0?.maskAI) return;
  const ai = !!d0.maskAI.__matte; // false: a PNG opened with its own transparency
  store.commit(ai ? '恢复AI结果' : '恢复初始', (d) => {
    d.mask = cloneCanvas(d.maskAI);
    d.edge = { feather: 0, shift: 0 };
  });
  toast(ai ? '已恢复为 AI 抠图结果' : '已恢复到图片原来的透明区域', 'success');
}

export async function setDecontam(on) {
  const doc = store.doc;
  if (!doc?.cutout) return;
  if (!on) {
    if (doc.fg) fgCache.set(doc.source, doc.fg);
    store.commit('关闭去色边', (d) => { d.fg = null; });
    return;
  }
  const cached = fgCache.get(doc.source);
  if (cached) { store.commit('开启去色边', (d) => { d.fg = cached; }); return; }
  const b = busy('正在去除边缘杂色…');
  const src = doc.source, version = store.version;
  try {
    await nextFrame();
    if (store.doc !== doc || doc.source !== src || store.version !== version) return;
    const r = await api.matteCanvas(src, { mode: store.ui.cutoutMode || 'general', decontam: true });
    if (store.doc !== doc || doc.source !== src || store.version !== version) return;
    if (!r.fg) { toast('当前版本不支持去色边', 'warning'); return; }
    const fg = mergeFg(src, r.fg);
    fgCache.set(src, fg);
    store.commit('开启去色边', (d) => { d.fg = fg; });
  } catch (err) {
    toast(err.message, 'error');
  } finally { b.done(); }
}

// ---------------------------------------------------------------- source edits
/**
 * New fg for an edited source: pixels the edit changed take the new photo, untouched pixels keep the
 * 去色边 colours. rect (doc px) limits the comparison (outside it fg is kept as is).
 */
export function syncFg(oldSource, newSource, fg, rect = null) {
  if (!fg) return null;
  const w = fg.width, h = fg.height;
  const out = createCanvas(w, h);
  const octx = out.getContext('2d');
  octx.drawImage(fg, 0, 0);
  const r = rect ? clampR(rect, w, h) : { x: 0, y: 0, w, h };
  if (r.w <= 0 || r.h <= 0) return out;
  const read = (c) => c.getContext('2d', { willReadFrequently: true }).getImageData(r.x, r.y, r.w, r.h).data;
  const a = read(oldSource), b = read(newSource);
  const id = octx.getImageData(r.x, r.y, r.w, r.h);
  const f = id.data;
  for (let i = 0; i < f.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) { f[i] = b[i]; f[i + 1] = b[i + 1]; f[i + 2] = b[i + 2]; f[i + 3] = 255; }
  }
  octx.putImageData(id, r.x, r.y);
  return out;
}
function clampR(r, w, h) {
  const x = Math.max(0, Math.floor(r.x)), y = Math.max(0, Math.floor(r.y));
  return { x, y, w: Math.max(0, Math.min(w, Math.ceil(r.x + r.w)) - x), h: Math.max(0, Math.min(h, Math.ceil(r.y + r.h)) - y) };
}

/**
 * One undo step that swaps doc.source for an edited copy (消除 / 美颜 / 马赛克框 results …) and keeps
 * doc.fg (the 去色边 copy used for the cut-out subject) in sync. newSource must have the doc's size.
 * rect optionally limits the fg comparison to the edited area. then(doc) runs inside the same commit.
 */
export function replaceSource(label, newSource, { rect = null, then = null } = {}) {
  const doc = store.doc;
  if (!doc) return false;
  if (newSource.width !== doc.width || newSource.height !== doc.height) throw new Error('replaceSource: 尺寸不一致');
  const fg = doc.fg ? syncFg(doc.source, newSource, doc.fg, rect) : null;
  store.commit(label, (d) => { d.source = newSource; d.fg = fg; then?.(d); });
  return true;
}

// ---------------------------------------------------------------- save
const baseName = (p) => String(p || '').split(/[\\/]/).pop();

export async function saveToOutput({ format = null, quality = 0.92, maxSide = null } = {}) {
  const doc = store.doc;
  if (!doc) { toast('还没有打开图片', 'warning'); return null; }
  const snapshot = cloneData(doc), version = store.version;
  const fmt = format || defaultSaveFormat(snapshot);
  const b = busy('正在保存…');
  try {
    await nextFrame();
    const blob = await exportDoc(snapshot, { format: fmt, quality, maxSide });
    b.update('正在写入文件…');
    const r = await api.save(blob, suggestFilename(snapshot, fmt), { dpi: snapshot.dpi || null });
    // Background beauty/AI work can finish while export or disk I/O awaits.
    // The saved snapshot must never mark those newer edits (or another image) saved.
    if (store.doc === doc && store.version === version) store.markSaved();
    toast(`已保存到「输出」文件夹：${baseName(r.path)}`, 'success', {
      action: { text: '打开文件夹', onClick: () => api.openOutput(r.path).catch((e) => toast(e.message, 'error')) },
    });
    store.emit('saved', r);
    return r;
  } catch (err) {
    toast(err.message || '保存失败', 'error');
    return null;
  } finally {
    b.done();
  }
}
