// panels/batch.js — 批量: 一次处理很多张（批量抠图 / 抠图+换底色 / 只改尺寸和压缩）。
//
// Works without an open image and never touches store.doc. Every file gets its own temporary doc that goes
// through the editor's own pipeline (exporter.exportDoc → render.js, incl. the 去色边 fg patch), so a batch
// result looks exactly like 抠图 / 换背景 + 保存 in the editor. Strictly one image at a time; after each item
// every canvas it created is released (width = 0) and the render cache is cleared, so long batches stay
// light on RAM.
//
// The list, the settings and the running job live in module scope on purpose: they are not document state,
// and they must survive panel switches and the remount that happens when an image is opened in the editor.
// A batch keeps running while the user works in other panels.

import { registerPanel, showPanel, currentPanelId } from '../core/panels.js';
import { store, createDoc } from '../core/store.js';
import { h, section, slider, segmented, button, colorSwatches, hint, toast } from '../core/ui.js';
import { icon, ICONS } from '../core/icons.js';
import { loadImageFile, splitAlpha, createCanvas } from '../core/io.js';
import { matteCanvas, save as apiSave, openOutput } from '../core/api.js';
import { exportDoc } from '../core/exporter.js';
import { renderDoc, clearRenderCache } from '../core/render.js';

ICONS.batchPause = '<rect x="6.5" y="5" width="3.6" height="14" rx="1"/><rect x="13.9" y="5" width="3.6" height="14" rx="1"/>';
ICONS.batchPlay = '<path d="M8 5.6v12.8l10.2-6.4z" stroke-linejoin="round"/>';
ICONS.batchCompress = '<path d="M4 14h6v6M20 10h-6V4M14 10l6.5-6.5M3.5 20.5 10 14"/>';

// ---------------------------------------------------------------- options
export const MODES = [
  { id: 'cutout', icon: 'cutout', title: '抠图（透明PNG）', sub: '去掉背景，保存成透明底图片', suffix: '_抠图' },
  { id: 'color', icon: 'background', title: '抠图 + 换底色', sub: '抠出主体，换成纯色背景', suffix: '_换底' },
  { id: 'resize', icon: 'batchCompress', title: '只改尺寸和压缩', sub: '不抠图，把图片变小变轻', suffix: '_压缩' },
];
export const COLORS = [
  { value: '#ffffff', name: '白色' },
  { value: '#438edb', name: '蓝色' },
  { value: '#d9001b', name: '红色' },
];
export const SIZES = [
  { value: 'orig', label: '原尺寸' },
  { value: 2048, label: '2048' },
  { value: 1920, label: '1920' },
  { value: 1080, label: '1080' },
  { value: 800, label: '800' },
  { value: 'custom', label: '自定义' },
];
const MATTE_HINT = {
  general: '适合物品、动物、商品、风景里的主体',
  portrait: '适合人像照片，头发丝抠得更细腻',
};
const CUSTOM_MIN = 50, CUSTOM_MAX = 4096;

// ---------------------------------------------------------------- pure helpers (exported for tests)
const pad2 = (n) => String(n).padStart(2, '0');
const BAD_CHARS = /[\\/:*?"<>|\x00-\x1f]/g;

/** Output sub-folder for one run: 批量_YYYYMMDD_HHMM */
export function folderName(d = new Date()) {
  return `批量_${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}
export function cleanSuffix(s) { return String(s ?? '').replace(BAD_CHARS, '').slice(0, 30); }
/** 原名 + 后缀 + 扩展名 */
export function outputName(base, suffix, format) {
  const b = String(base || '').replace(BAD_CHARS, '').trim() || '图片';
  return `${b}${cleanSuffix(suffix)}.${format === 'jpg' ? 'jpg' : 'png'}`;
}
/** size setting → maxSide for exportDoc (null = 原尺寸) */
export function maxSideOf(size, custom) {
  if (size === 'orig' || size == null) return null;
  if (size === 'custom') {
    const n = Math.round(Number(custom));
    return Number.isFinite(n) && n >= CUSTOM_MIN ? Math.min(CUSTOM_MAX, n) : null;
  }
  return Number(size) > 0 ? Number(size) : null;
}
/** size of the exported image: shrink so the long side ≤ maxSide, never enlarge (same maths as exportCanvas) */
export function outSize(w, hh, maxSide) {
  const long = Math.max(w, hh);
  const k = maxSide && maxSide < long ? maxSide / long : 1;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(hh * k)) };
}
export function fmtBytes(n) {
  if (!(n >= 0)) return '';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
export function summaryText(s) { return `完成 ${s.done} 张，失败 ${s.failed} 张`; }
const baseOf = (name) => String(name || '').replace(/\.[^.]+$/, '') || '图片';
const dirOf = (p) => String(p || '').replace(/[\\/][^\\/]*$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); // not rAF: a minimised window must not stall the batch
const isHeic = (f) => /heic|heif/i.test(f.type || '') || /\.(heic|heif)$/i.test(f.name || '');
const isImage = (f) => (f.type || '').startsWith('image/') || /\.(jpe?g|png|webp|bmp|gif)$/i.test(f.name || '');
const isNetErr = (e) => !e?.status && /无法连接到本地服务/.test(e?.message || '');
const CANCELLED = Symbol('cancelled');

// ---------------------------------------------------------------- state (module scope, see header)
let uid = 0, jobSeq = 0;
const S = {
  items: [],       // { id, file, name, size, w, h, thumb, status:'wait'|'run'|'done'|'error', stage, progress, cap, reason, out, runId }
  opt: {
    mode: 'cutout',
    matte: null,   // null → store.ui.cutoutMode on first mount
    color: '#ffffff',
    format: { color: 'jpg', resize: 'jpg' }, // 抠图（透明PNG） is always PNG
    quality: 90,
    size: 'orig',
    custom: 1600,
    suffix: Object.fromEntries(MODES.map((m) => [m.id, m.suffix])),
  },
  job: null,       // running job
  summary: null,   // last finished run { done, failed, left, cancelled, folder, subdir }
};
export const batchState = S; // tests / debugging

/** injectable for tests: load / matte / save / afterItem */
export const DEPS = {
  load: (file) => loadImageFile(file),
  matte: (canvas, opts) => matteCanvas(canvas, opts),
  save: (blob, name, opts) => apiSave(blob, name, opts),
  afterItem: () => clearRenderCache(),
};

let view = null; // update function of the mounted panel (null when another panel is shown)
function notify(what, it) { try { view?.(what, it); } catch (e) { console.error(e); } }

// ---------------------------------------------------------------- list
export function addFiles(files) {
  let added = 0, dup = 0, notImg = 0, heic = 0;
  for (const f of files || []) {
    if (!f) continue;
    if (isHeic(f)) { heic++; continue; }
    if (!isImage(f)) { notImg++; continue; }
    if (S.items.some((it) => it.file.name === f.name && it.file.size === f.size && it.file.lastModified === f.lastModified)) { dup++; continue; }
    const it = { id: ++uid, file: f, name: f.name || '图片', size: f.size, w: 0, h: 0, thumb: null,
      status: 'wait', stage: '', progress: 0, cap: 0, reason: '', out: null, runId: S.job ? S.job.id : 0 };
    S.items.push(it);
    thumbQ.push(it);
    added++;
  }
  if (added) { pumpThumbs(); notify('list'); }
  const skipped = [];
  if (notImg) skipped.push(`${notImg} 个文件不是图片`);
  if (heic) skipped.push(`${heic} 张是苹果 HEIC 格式（请先转成 JPG）`);
  if (dup) skipped.push(`${dup} 张已经在列表里了`);
  if (skipped.length) toast(`已跳过：${skipped.join('，')}`, added ? 'info' : 'warning', { duration: 5000 });
  return added;
}
export function removeItem(id) {
  const it = S.items.find((i) => i.id === id);
  if (!it || it.status === 'run') return false;
  S.items = S.items.filter((i) => i !== it);
  notify('list');
  return true;
}
export function clearItems() {
  if (S.job) return false;
  S.items = [];
  S.summary = null;
  thumbQ.length = 0;
  notify('list');
  return true;
}

// small preview thumbnails, made one at a time (a 24-MP photo decodes to ~100 MB for a moment)
const thumbQ = [];
let thumbBusy = false;
async function pumpThumbs() {
  if (thumbBusy) return;
  thumbBusy = true;
  try {
    while (thumbQ.length) {
      const it = thumbQ.shift();
      if (!S.items.includes(it) || it.thumb) continue;
      await makeThumb(it);
      notify('item', it);
    }
  } finally { thumbBusy = false; }
}
async function makeThumb(it) {
  const url = URL.createObjectURL(it.file);
  const img = new Image();
  try {
    img.src = url;
    await img.decode();
    it.w = img.naturalWidth; it.h = img.naturalHeight;
    const k = Math.min(1, 96 / Math.max(it.w, it.h));
    const c = createCanvas(Math.max(1, Math.round(it.w * k)), Math.max(1, Math.round(it.h * k)));
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(img, 0, 0, c.width, c.height);
    it.thumb = c.toDataURL('image/webp', 0.85);
    c.width = c.height = 0;
  } catch {
    it.thumb = null; // unreadable: processing will report the reason
  } finally {
    img.src = '';
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------- one image
/** The server sends only the 去色边 patch; painting it over a copy of the photo gives the fg plane (as actions.runCutout). */
function mergeFg(source, patch) {
  const out = createCanvas(source.width, source.height);
  const x = out.getContext('2d');
  x.drawImage(source, 0, 0);
  x.drawImage(patch.canvas, patch.x, patch.y);
  return out;
}
function maskCoverage(mask) {
  const t = createCanvas(64, 64, { willRead: true });
  const x = t.getContext('2d', { willReadFrequently: true });
  x.drawImage(mask, 0, 0, 64, 64);
  const d = x.getImageData(0, 0, 64, 64).data;
  let sum = 0;
  for (let i = 3; i < d.length; i += 4) sum += d[i];
  t.width = t.height = 0;
  return sum / (64 * 64 * 255);
}
function resultThumb(doc, format) {
  const c = renderDoc(doc, { scale: Math.min(1, 96 / Math.max(doc.width, doc.height)) });
  let out = c;
  if (format === 'jpg') { // what the JPG will look like (transparent parts become white)
    out = createCanvas(c.width, c.height);
    const x = out.getContext('2d');
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, out.width, out.height); x.drawImage(c, 0, 0);
    c.width = c.height = 0;
  }
  const url = out.toDataURL('image/webp', 0.85);
  out.width = out.height = 0;
  return url;
}

/**
 * Processes one file with a frozen run config and saves it. Returns { path, w, h, bytes, format, thumb, note }.
 * cfg = { mode, matte, color, format, quality (0..100), maxSide, suffix, subdir }
 * stage(text, progress, cap?) reports progress; alive() throws to stop between steps (取消).
 */
export async function processFile(file, cfg, { deps = {}, stage = () => {}, alive = () => {} } = {}) {
  const dp = { ...DEPS, ...deps };
  const own = []; // every canvas made for this item → released in finally
  try {
    stage('正在读取…', 0.04, 0.1);
    const c = await dp.load(file);
    own.push(c);
    alive();
    const meta = c.meta || {};
    let source = c, mask = null, fg = null;
    if (meta.hasAlpha) { // a PNG that is already cut out: keep its own transparency (like opening it in the editor)
      ({ source, mask, fg } = splitAlpha(c));
      own.push(source, mask, fg);
    }
    const doc = createDoc({ source, name: meta.name || baseOf(file.name) });
    let note = '';
    if (cfg.mode !== 'resize' && !mask) {
      stage(cfg.matte === 'portrait' ? 'AI 抠人像…' : 'AI 抠图中…', 0.12, 0.78);
      const r = await dp.matte(source, { mode: cfg.matte === 'portrait' ? 'portrait' : 'general', decontam: true });
      own.push(r.mask, r.fg?.canvas);
      alive();
      if (r.mask.width !== source.width || r.mask.height !== source.height) throw new Error('抠图结果尺寸不对，请重试');
      mask = r.mask;
      if (r.fg) { fg = mergeFg(source, r.fg); own.push(fg); }
      if (maskCoverage(mask) < 0.004) note = '没找到明显的主体';
    }
    if (mask) { doc.mask = mask; doc.fg = fg; doc.cutout = true; }
    if (cfg.mode === 'color') { doc.bg.type = 'color'; doc.bg.color = cfg.color || '#ffffff'; }
    else doc.bg.type = 'transparent'; // resize mode: an alpha PNG keeps its transparency (flattened on white for JPG)
    const format = cfg.mode === 'cutout' ? 'png' : (cfg.format === 'png' ? 'png' : 'jpg');
    stage('正在合成…', 0.8, 0.88);
    await sleep(0);
    const blob = await exportDoc(doc, { format, quality: (cfg.quality ?? 90) / 100, maxSide: cfg.maxSide || null, background: '#ffffff' });
    alive();
    const size = outSize(doc.width, doc.height, cfg.maxSide);
    const thumb = resultThumb(doc, format);
    stage('正在保存…', 0.9, 0.98);
    const r = await dp.save(blob, outputName(doc.name, cfg.suffix, format), { subdir: cfg.subdir || null });
    const alpha = format === 'png' && doc.cutout && doc.bg.type === 'transparent';
    return { path: r.path, w: size.w, h: size.h, bytes: blob.size, format, alpha, thumb, note };
  } finally {
    for (const c of own) if (c && c.width) { c.width = 0; c.height = 0; }
    try { dp.afterItem?.(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- the run
function runConfig() {
  const o = S.opt;
  return {
    mode: o.mode,
    matte: o.matte || store.ui.cutoutMode || 'general',
    color: o.color,
    format: o.mode === 'cutout' ? 'png' : o.format[o.mode],
    quality: o.quality,
    maxSide: maxSideOf(o.size, o.custom),
    suffix: o.suffix[o.mode],
    subdir: folderName(),
  };
}
export function pendingItems() { return S.items.filter((i) => i.status !== 'done' && i.status !== 'run'); }

export async function startBatch(deps = {}) {
  if (S.job) return null;
  const d = { ...DEPS, ...deps };
  let todo = pendingItems();
  if (!todo.length) todo = S.items.slice(); // 全部处理过 → 用新设置再处理一遍
  if (!todo.length) return null;
  const job = S.job = { id: ++jobSeq, cfg: runConfig(), paused: false, cancel: false, resume: null, current: null, done: 0, failed: 0, folder: null };
  for (const it of todo) Object.assign(it, { status: 'wait', stage: '', progress: 0, cap: 0, reason: '', out: null, runId: job.id });
  S.summary = null;
  notify('all');
  const ticker = setInterval(creep, 200);
  try {
    for (;;) {
      if (job.cancel) break;
      if (job.paused) {
        notify('job');
        await new Promise((r) => { job.resume = r; });
        job.resume = null;
        continue;
      }
      const it = S.items.find((i) => i.runId === job.id && i.status === 'wait');
      if (!it) break;
      await runOne(it, job, d);
      await sleep(30); // let the page breathe (and the GC free the last image) between items
    }
  } finally {
    clearInterval(ticker);
    const left = S.items.filter((i) => i.runId === job.id && i.status === 'wait').length;
    S.summary = { done: job.done, failed: job.failed, left, cancelled: job.cancel, folder: job.folder, subdir: job.cfg.subdir };
    S.job = null;
    notify('all');
    if (currentPanelId() !== 'batch' && !job.cancel) {
      toast(`批量处理完成：${summaryText(S.summary)}`, job.failed ? 'warning' : 'success', { action: { text: '查看', onClick: () => showPanel('batch') } });
    }
  }
  return S.summary;
}

async function runOne(it, job, d) {
  job.current = it;
  Object.assign(it, { status: 'run', stage: '正在读取…', progress: 0.02, cap: 0.1, reason: '' });
  notify('item', it); notify('job');
  const stage = (text, p, cap = p) => {
    it.stage = text; it.progress = Math.max(it.progress, p); it.cap = Math.max(cap, it.progress);
    notify('item', it); notify('job');
  };
  const alive = () => { if (job.cancel) throw CANCELLED; };
  try {
    const out = await processFile(it.file, job.cfg, { deps: d, stage, alive });
    Object.assign(it, { status: 'done', stage: '', progress: 1, out });
    job.done++;
    job.folder ??= dirOf(out.path);
  } catch (err) {
    if (err === CANCELLED) {
      Object.assign(it, { status: 'wait', stage: '', progress: 0 });
    } else if (isNetErr(err)) { // server gone: keep the image, pause instead of failing everything
      Object.assign(it, { status: 'wait', stage: '', progress: 0 });
      job.paused = true;
      toast(`${err.message}。批量已暂停，恢复后点「继续」`, 'error', { duration: 8000 });
    } else {
      Object.assign(it, { status: 'error', stage: '', progress: 0, reason: err?.message || '处理失败' });
      job.failed++;
    }
  } finally {
    job.current = null;
    notify('item', it); notify('job');
  }
}

function creep() { // the AI step has no progress events: ease the bar toward the stage's cap
  const it = S.job?.current;
  if (!it || !(it.cap > it.progress + 0.002)) return;
  it.progress += (it.cap - it.progress) * 0.045;
  notify('item', it); notify('job');
}

export function pauseBatch() { if (S.job && !S.job.cancel) { S.job.paused = true; notify('job'); } }
export function resumeBatch() {
  const job = S.job;
  if (!job || !job.paused) return;
  job.paused = false;
  job.resume?.();
  notify('job');
}
export function cancelBatch() {
  const job = S.job;
  if (!job) return;
  job.cancel = true;
  job.resume?.();
  notify('job');
}

// closing the tab mid-run would silently drop the rest of the batch
window.addEventListener('beforeunload', (e) => { if (S.job) { e.preventDefault(); e.returnValue = ''; } });

// ---------------------------------------------------------------- panel UI
function statusOf(it) {
  switch (it.status) {
    case 'run': return { cls: 'run', text: `${it.stage || '处理中…'} ${Math.round(it.progress * 100)}%` };
    case 'done': {
      const o = it.out;
      if (o?.note) return { cls: 'warn', text: `完成 · ${o.note}`, tip: '已保存。建议打开这张单独检查一下，或换「人像发丝」模式再试' };
      return { cls: 'done', text: o ? `完成 · ${o.w}×${o.h} · ${fmtBytes(o.bytes)}` : '完成' };
    }
    case 'error': return { cls: 'error', text: `失败：${it.reason}`, tip: it.reason };
    default: return { cls: 'wait', text: `等待 · ${it.w ? `${it.w}×${it.h} · ` : ''}${fmtBytes(it.size)}` };
  }
}

function hasFiles(e) { return [...(e.dataTransfer?.types || [])].includes('Files'); }
/** We stop our drop from reaching main.js (it would open the file in the editor), so its drag counter
 *  never hears about it: send it the dragleave events it is waiting for, until its drop hint is hidden. */
function resetGlobalDropHint() {
  const hintEl = document.getElementById('drop-hint');
  if (!hintEl || hintEl.hidden) return;
  try {
    const dt = new DataTransfer();
    dt.items.add(new File([''], 'x.png', { type: 'image/png' }));
    for (let i = 0; i < 64 && !hintEl.hidden; i++) window.dispatchEvent(new DragEvent('dragleave', { dataTransfer: dt }));
  } catch { /* ignore */ }
  hintEl.hidden = true;
}

registerPanel({
  id: 'batch',
  title: '批量',
  icon: icon('batch', 22),
  order: 110,
  tip: '一次处理很多张图片',
  subtitle: '一次处理很多张：抠图、换底色、压缩',
  requiresDoc: false,
  mount(el, ctx) {
    const o = S.opt;
    if (!o.matte) o.matte = store.ui.cutoutMode || 'general';
    el.classList.add('batch-panel');
    ctx.onDispose(() => el.classList.remove('batch-panel', 'bt-dragging'));

    // ------------------------------------------------------------ 1. 图片
    const input = h('input', { type: 'file', class: 'batch-file-input', accept: 'image/*,.jpg,.jpeg,.png,.webp,.bmp,.gif', multiple: true, hidden: true });
    input.addEventListener('change', () => { const f = [...input.files]; input.value = ''; addFiles(f); });
    const pick = () => input.click();

    const drop = h('div', { class: 'bt-drop', role: 'button', tabindex: '0', onclick: pick,
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } } },
    h('div', { class: 'bt-drop-ico', html: icon('imagePlus', 26) }),
    h('div', { class: 'bt-drop-title' }, '添加要处理的图片'),
    h('div', { class: 'bt-drop-sub' }, '可以一次选很多张，也可以直接拖到这里'),
    h('span', { class: 'btn primary bt-drop-btn' }, h('span', { class: 'btn-ico', html: icon('plus', 18) }), h('span', { class: 'btn-text' }, '添加图片')));

    const count = h('span', { class: 'bt-count' });
    const addBtn = button({ text: '添加', icon: 'plus', variant: 'secondary', size: 'sm', className: 'bt-add', tip: '再添加一些图片', onClick: pick });
    const clearBtn = button({ text: '清空', icon: 'trash', variant: 'ghost', size: 'sm', className: 'bt-clear', tip: '清空列表（不会删除电脑里的图片）', onClick: () => clearItems() });
    const listHead = h('div', { class: 'bt-list-head' }, count, addBtn, clearBtn);
    const list = h('div', { class: 'bt-list' });
    const dropTip = h('div', { class: 'bt-drop-tip' }, '松开鼠标，添加到列表');
    const secFiles = section('图片', null);
    secFiles.append(input, drop, listHead, list, dropTip);

    const rows = new Map();
    function makeRow(it) {
      const thumb = h('div', { class: 'bt-thumb' });
      const name = h('div', { class: 'bt-name' }, it.name);
      const st = h('div', { class: 'bt-st' });
      const bar = h('div', { class: 'bt-bar' }, h('i'));
      const rm = h('button', { type: 'button', class: 'icon-btn bt-rm', 'data-tip': '从列表移除', 'aria-label': '从列表移除', html: icon('close', 16), onclick: () => removeItem(it.id) });
      const row = h('div', { class: 'bt-item', 'data-id': String(it.id) }, thumb, h('div', { class: 'bt-info' }, name, st), rm, bar);
      name.dataset.tip = it.name;
      let shownThumb = null;
      row.update = () => {
        const s = statusOf(it);
        row.className = `bt-item is-${it.status}`;
        st.className = `bt-st ${s.cls}`;
        st.textContent = s.text;
        if (s.tip) st.dataset.tip = s.tip; else delete st.dataset.tip;
        const src = it.out?.thumb || it.thumb || (it.status === 'error' ? 'error' : 'none');
        if (src !== shownThumb) {
          shownThumb = src;
          thumb.innerHTML = '';
          if (src === 'error') thumb.innerHTML = icon('alert', 20);
          else if (src === 'none') thumb.innerHTML = icon('image', 20);
          else thumb.append(h('img', { src, alt: '', draggable: 'false' }));
        }
        thumb.classList.toggle('is-bad', src === 'error');
        thumb.classList.toggle('is-alpha', !!(it.out?.thumb && it.out.alpha)); // transparent result: checkerboard + whole subject
        bar.firstChild.style.width = `${Math.round(it.progress * 1000) / 10}%`;
        rm.hidden = it.status === 'run';
      };
      row.update();
      return row;
    }
    function renderCount() {
      const n = S.items.length;
      const done = S.items.filter((i) => i.status === 'done').length;
      const failed = S.items.filter((i) => i.status === 'error').length;
      count.textContent = `共 ${n} 张`;
      if (done || failed) count.dataset.tip = `完成 ${done} 张${failed ? `，失败 ${failed} 张` : ''}`;
      else delete count.dataset.tip;
      clearBtn.setDisabled(!!S.job);
    }
    function renderList() {
      const n = S.items.length;
      drop.hidden = n > 0;
      listHead.hidden = list.hidden = n === 0;
      renderCount();
      const keep = new Set(S.items.map((i) => i.id));
      for (const [id, r] of rows) if (!keep.has(id)) { r.remove(); rows.delete(id); }
      let prev = null;
      for (const it of S.items) {
        let r = rows.get(it.id);
        if (!r) { r = makeRow(it); rows.set(it.id, r); }
        else r.update();
        if ((prev ? prev.nextSibling : list.firstChild) !== r) list.insertBefore(r, prev ? prev.nextSibling : list.firstChild);
        prev = r;
      }
    }

    // ------------------------------------------------------------ 2. 处理方式
    const modeBtns = new Map();
    const modes = h('div', { class: 'bt-modes', role: 'radiogroup' });
    for (const m of MODES) {
      const b = h('button', { type: 'button', class: 'bt-mode', role: 'radio', 'data-mode': m.id, onclick: () => setMode(m.id) },
        h('span', { class: 'bt-mode-ico', html: icon(m.icon, 20) }),
        h('span', { class: 'bt-mode-text' }, h('span', { class: 'bt-mode-title' }, m.title), h('span', { class: 'bt-mode-sub' }, m.sub)),
        h('span', { class: 'bt-radio' }));
      modeBtns.set(m.id, b);
      modes.append(b);
    }
    const matteHint = hint(MATTE_HINT[o.matte] || MATTE_HINT.general);
    const matte = segmented({
      block: true, value: o.matte,
      options: [
        { value: 'general', label: '通用', icon: 'cube', tip: '物品、动物、商品等' },
        { value: 'portrait', label: '人像发丝', icon: 'person', tip: '人像照片，头发更细腻' },
      ],
      onChange: (v) => { o.matte = v; matteHint.textContent = MATTE_HINT[v]; },
    });
    const matteBox = h('div', { class: 'bt-sub' }, h('div', { class: 'field-label' }, '抠图模式'), matte, matteHint);
    const colorName = h('span', { class: 'bt-color-name' });
    const swatches = colorSwatches({ colors: COLORS, value: o.color, custom: true,
      onChange: (v) => { o.color = v; syncSettings(); }, onInput: (v) => { o.color = v; syncSettings(); } });
    const colorBox = h('div', { class: 'bt-sub' }, h('div', { class: 'field-label bt-row-label' }, h('span', {}, '底色'), colorName), swatches);
    const secMode = section('处理方式');
    secMode.append(modes, matteBox, colorBox);

    // ------------------------------------------------------------ 3. 保存设置
    const sizeBtns = new Map();
    const sizes = h('div', { class: 'bt-sizes' });
    for (const s of SIZES) {
      const b = h('button', { type: 'button', class: 'bt-chip', 'data-size': String(s.value), onclick: () => { o.size = s.value; syncSettings(); if (s.value === 'custom') customInput.focus(); } }, s.label);
      sizeBtns.set(s.value, b);
      sizes.append(b);
    }
    const customInput = h('input', { type: 'number', class: 'num-input bt-custom-input', min: String(CUSTOM_MIN), max: String(CUSTOM_MAX), step: '1', value: String(o.custom), 'aria-label': '长边像素' });
    const commitCustom = () => {
      const n = Math.round(Number(customInput.value));
      o.custom = Number.isFinite(n) && n > 0 ? Math.max(CUSTOM_MIN, Math.min(CUSTOM_MAX, n)) : 1600;
      customInput.value = String(o.custom);
      syncSettings();
    };
    customInput.addEventListener('change', commitCustom);
    customInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitCustom(); customInput.blur(); } });
    const customRow = h('div', { class: 'bt-custom' }, h('span', {}, '长边'), customInput, h('span', {}, '像素'));
    const sizeHint = hint('');

    const fmt = segmented({ block: true, value: 'png',
      options: [{ value: 'png', label: 'PNG', tip: '画质无损，支持透明背景' }, { value: 'jpg', label: 'JPG', tip: '文件小，适合发微信、上传' }],
      onChange: (v) => { if (o.mode !== 'cutout') o.format[o.mode] = v; syncSettings(); } });
    const fmtHint = hint('');
    const quality = slider({ label: 'JPG 画质', min: 50, max: 100, step: 1, value: o.quality, defaultValue: 90,
      onInput: (v) => { o.quality = v; } });
    const qualityHint = hint('数值越小，文件越小；90 左右看不出区别');
    const qualityBox = h('div', { class: 'bt-quality' }, quality, qualityHint);

    const suffixInput = h('input', { type: 'text', class: 'text-input bt-suffix', maxlength: '30', spellcheck: 'false', 'aria-label': '文件名后缀' });
    suffixInput.addEventListener('input', () => {
      const clean = cleanSuffix(suffixInput.value);
      if (clean !== suffixInput.value) suffixInput.value = clean;
      o.suffix[o.mode] = clean;
      syncExample();
    });
    const example = hint('');
    const secOut = section('保存设置');
    secOut.append(
      h('div', { class: 'field-label' }, '尺寸（按长边缩小）'), sizes, customRow, sizeHint,
      h('div', { class: 'field-label mt' }, '格式'), fmt, fmtHint, qualityBox,
      h('div', { class: 'field-label mt' }, '文件名'), h('div', { class: 'bt-name-row' }, h('span', { class: 'bt-name-base' }, '原名 +'), suffixInput), example,
    );
    const settings = h('div', { class: 'bt-settings' }, secMode, secOut);

    function syncExample() {
      const mode = o.mode;
      const f = mode === 'cutout' ? 'png' : o.format[mode];
      const base = S.items[0] ? baseOf(S.items[0].name) : '照片';
      example.textContent = `例如：${outputName(base, o.suffix[mode], f)}`;
    }
    function syncSettings() {
      const mode = o.mode;
      for (const [id, b] of modeBtns) { const on = id === mode; b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); }
      matteBox.hidden = mode === 'resize';
      colorBox.hidden = mode !== 'color';
      swatches.setValue(o.color);
      colorName.textContent = COLORS.find((c) => c.value === o.color)?.name || `自定义 ${o.color.toUpperCase()}`;
      for (const [v, b] of sizeBtns) b.classList.toggle('on', v === o.size);
      customRow.hidden = o.size !== 'custom';
      const ms = maxSideOf(o.size, o.custom);
      sizeHint.textContent = ms ? `长边超过 ${ms} 像素的会等比例缩小，小图保持原样` : '保持原来的大小（超过 4096 像素的大图会缩小到 4096）';
      const f = mode === 'cutout' ? 'png' : o.format[mode];
      fmt.setValue(f);
      fmt.querySelector('[data-value="jpg"]').disabled = mode === 'cutout';
      fmt.classList.toggle('bt-fmt-locked', mode === 'cutout');
      fmtHint.textContent = mode === 'cutout' ? '透明背景只能保存成 PNG'
        : f === 'png' ? (mode === 'resize' ? 'PNG 画质无损，但文件比 JPG 大很多' : '画质无损，文件较大')
          : '文件小，适合发微信、上传网站';
      qualityBox.hidden = f !== 'jpg';
      quality.setValue(o.quality);
      if (document.activeElement !== suffixInput) suffixInput.value = o.suffix[mode];
      syncExample();
      const locked = !!S.job;
      settings.inert = locked;
      settings.classList.toggle('is-locked', locked);
    }
    function setMode(id) {
      if (S.job || o.mode === id) return;
      o.mode = id;
      suffixInput.value = o.suffix[id];
      syncSettings();
    }

    // ------------------------------------------------------------ 4. footer (sticky): start / progress / summary
    const summaryIco = h('span', { class: 'bt-sum-ico' });
    const summaryTitle = h('div', { class: 'bt-sum-title' });
    const summarySub = h('div', { class: 'bt-sum-sub' });
    const summaryFolder = h('div', { class: 'bt-sum-folder' }, h('span', { class: 'bt-sum-fico', html: icon('folder', 14) }), h('span', {}));
    const openBtn = button({ text: '打开输出文件夹', icon: 'folderOpen', variant: 'secondary', block: true, className: 'bt-open',
      onClick: () => { const f = S.summary?.folder; openOutput(f || null).catch((e) => toast(e.message || '无法打开文件夹', 'error')); } });
    const summary = h('div', { class: 'bt-summary' }, h('div', { class: 'bt-sum-head' }, summaryIco, h('div', { class: 'bt-sum-text' }, summaryTitle, summaryFolder, summarySub)), openBtn);

    const startBtn = button({ text: '开始处理', icon: 'sparkles', primary: true, size: 'lg', block: true, className: 'bt-start', onClick: () => startBatch() });
    const idleHint = h('div', { class: 'bt-foot-hint' });
    const idle = h('div', { class: 'bt-idle' }, startBtn, idleHint);

    const runTitle = h('span', { class: 'bt-run-title' });
    const runPct = h('span', { class: 'bt-run-pct' });
    const runBar = h('div', { class: 'bt-run-bar' }, h('i'));
    const runName = h('div', { class: 'bt-run-name' });
    const pauseBtn = button({ text: '暂停', icon: 'batchPause', variant: 'secondary', className: 'bt-pause', onClick: () => (S.job?.paused ? resumeBatch() : pauseBatch()) });
    const cancelBtn = button({ text: '取消', icon: 'close', variant: 'secondary', className: 'bt-cancel', tip: '停止处理，已完成的图片会保留', onClick: () => cancelBatch() });
    const running = h('div', { class: 'bt-running' }, h('div', { class: 'bt-run-head' }, runTitle, runPct), runBar, runName, h('div', { class: 'row bt-run-btns' }, pauseBtn, cancelBtn));
    const foot = h('div', { class: 'bt-foot' }, summary, running, idle);

    let lastPauseState = null;
    function updateFoot() {
      const job = S.job;
      running.hidden = !job;
      idle.hidden = !!job;
      summary.hidden = !!job || !S.summary;
      if (job) {
        const runItems = S.items.filter((i) => i.runId === job.id);
        const fin = runItems.filter((i) => i.status === 'done' || i.status === 'error').length;
        const cur = job.current;
        const total = runItems.length;
        const frac = total ? Math.min(1, (fin + (cur ? cur.progress : 0)) / total) : 0;
        runTitle.textContent = job.cancel ? '正在取消…'
          : job.paused ? (cur ? '这张处理完就暂停…' : '已暂停')
            : `正在处理第 ${Math.min(fin + 1, total)} / ${total} 张`;
        runPct.textContent = `${Math.floor(frac * 100)}%`;
        runBar.firstChild.style.width = `${Math.round(frac * 1000) / 10}%`;
        runBar.classList.toggle('paused', !!job.paused);
        runName.textContent = cur ? cur.name : job.paused && !job.cancel ? '点「继续」接着处理剩下的图片' : '';
        const ps = `${!!job.paused}${!!job.cancel}`;
        if (ps !== lastPauseState) {
          lastPauseState = ps;
          pauseBtn.querySelector('.btn-ico').innerHTML = icon(job.paused ? 'batchPlay' : 'batchPause', 18);
          pauseBtn.setText(job.paused ? '继续' : '暂停');
          pauseBtn.dataset.tip = job.paused ? '接着处理剩下的图片' : '处理完当前这张后暂停';
          pauseBtn.setDisabled(job.cancel);
          cancelBtn.setDisabled(job.cancel);
        }
        return;
      }
      lastPauseState = null;
      const n = S.items.length, pend = pendingItems().length;
      const failed = S.items.filter((i) => i.status === 'error').length;
      const s = S.summary;
      const redo = !!(n && !pend); // everything done: a small 「再处理一遍」 instead of the big button
      startBtn.setDisabled(!n);
      startBtn.classList.toggle('primary', !redo);
      startBtn.classList.toggle('lg', !redo);
      startBtn.classList.toggle('ghost', redo);
      startBtn.classList.toggle('bt-redo', redo);
      startBtn.setText(!n ? '开始处理' : redo ? `换个设置，全部重新处理（${n} 张）` : failed === pend ? `重试失败的 ${failed} 张` : `开始处理（${pend} 张）`);
      if (redo) startBtn.dataset.tip = '改好上面的设置后，把列表里的图片全部再处理一遍';
      else delete startBtn.dataset.tip;
      idleHint.hidden = !!s && !!n;
      idleHint.textContent = !n ? '先添加要处理的图片' : '一张一张处理，结果保存在「输出」文件夹';
      if (s) {
        const bad = s.failed > 0 || s.cancelled;
        summary.classList.toggle('bad', bad);
        summaryIco.innerHTML = icon(bad ? 'alert' : 'success', 20);
        summaryTitle.textContent = `${s.cancelled ? '已取消：' : ''}${summaryText(s)}`;
        const parts = [];
        if (!s.done) parts.push('这次没有保存任何图片');
        if (s.failed) parts.push('失败的原因写在列表里');
        if (s.left) parts.push(`还有 ${s.left} 张没处理`);
        summarySub.textContent = parts.join('，');
        summarySub.hidden = !parts.length;
        summaryFolder.hidden = !s.done;
        summaryFolder.lastChild.textContent = `输出 › ${s.subdir}`;
        openBtn.hidden = !s.done;
      }
    }

    el.append(secFiles, settings, foot);

    // ------------------------------------------------------------ drag & drop onto the panel
    el.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; el.classList.add('bt-dragging'); });
    el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('bt-dragging'); });
    el.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation(); // don't let main.js open the file in the editor
      el.classList.remove('bt-dragging');
      resetGlobalDropHint();
      addFiles([...e.dataTransfer.files]);
    });
    // 2+ files dropped on the canvas area while this panel is open (main.js)
    ctx.on('files:dropped', (files) => { el.classList.remove('bt-dragging'); addFiles(files); });

    // ------------------------------------------------------------ wiring
    let lastRunRow = null;
    function keepVisible(r) { // scroll the list (not the panel) so the image being processed stays in view
      const top = r.offsetTop, bottom = top + r.offsetHeight;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
    }
    const update = (what, it) => {
      if (what === 'item' && it) {
        const r = rows.get(it.id);
        if (!r) return;
        r.update();
        if (it.status === 'run' && r !== lastRunRow) { lastRunRow = r; keepVisible(r); }
        return;
      }
      if (what === 'job') { updateFoot(); renderCount(); return; }
      renderList();
      updateFoot();
      syncSettings();
    };
    view = update;
    ctx.onDispose(() => { if (view === update) view = null; });
    update('all');
  },
});
