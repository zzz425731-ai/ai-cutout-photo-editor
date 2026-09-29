// panels/mosaic.js — 打码: 一键人脸打码 (马赛克 / 模糊 / 表情遮挡) + 手动打码 (马赛克笔, 模糊笔, 框选打码, 涂鸦).
// Pixel effects live in tools/mosaic-brush.js, the doodle pen in tools/doodle-brush.js. Faces come from
// /api/faces; for big photos small faces are also searched tile by tile, for small photos on an enlarged copy.

import { registerPanel } from '../core/panels.js';
import { store } from '../core/store.js';
import { setTool, currentTool } from '../core/tools.js';
import { h, section, slider, toggle, segmented, button, colorSwatches, toast, busy } from '../core/ui.js';
import { icon, ICONS } from '../core/icons.js';
import * as api from '../core/api.js';
import { nextFrame } from '../core/actions.js';
import { createCanvas, cropCanvas, canvasToBlob } from '../core/io.js';
import { createEmojiLayer } from '../layers/render-layers.js';
import { selectLayer } from '../tools/layer-tool.js';
import { mosaicSettings, applyRegions, releasePattern } from '../tools/mosaic-brush.js';
import { DOODLE_COLORS } from '../tools/doodle-brush.js';

ICONS.mzBlur = '<path d="M12 3.6c3.3 3.9 5.6 7.1 5.6 10.1a5.6 5.6 0 0 1-11.2 0c0-3 2.3-6.2 5.6-10.1z"/><path d="M9.4 14.2a2.7 2.7 0 0 0 2.4 2.6" opacity=".6"/>';
ICONS.mzBox = '<rect x="4" y="5" width="16" height="14" rx="2" stroke-dasharray="3.2 2.6"/><rect x="8.5" y="9" width="3.5" height="3" fill="currentColor" stroke="none" opacity=".55"/><rect x="12" y="12" width="3.5" height="3" fill="currentColor" stroke="none" opacity=".55"/>';
ICONS.mzPen = '<path d="M15.2 4.8l4 4L9 19H5v-4z"/><path d="M13 7l4 4"/>';
ICONS.mzFace = '<circle cx="12" cy="12" r="8.6"/><path d="M8.6 14.3c.9 1.4 2.1 2.1 3.4 2.1s2.5-.7 3.4-2.1"/><path d="M9.2 9.6v.6M14.8 9.6v.6" stroke-width="2.4"/>';

export const FACE_EMOJIS = ['😊', '😄', '🥰', '😎', '🐱', '🌸'];

// ---------------------------------------------------------------- face helpers (pure, unit-tested)
/** Overlapping tiles (≈ 1280 px, 20 % overlap) covering W×H, so small faces are seen at full resolution. */
export function tileRects(W, H, { tile = 1280, overlap = 0.2 } = {}) {
  const T = Math.max(tile, Math.round(Math.max(W, H) / 2.5));
  const axis = (n) => {
    if (n <= T) return [[0, n]];
    const k = Math.ceil((n - T) / (T * (1 - overlap))) + 1;
    const s = (n - T) / (k - 1);
    return Array.from({ length: k }, (_, i) => [Math.round(i * s), T]);
  };
  const out = [];
  for (const [y, th] of axis(H)) for (const [x, tw] of axis(W)) out.push({ x, y, w: tw, h: th });
  return out;
}

const area = (f) => Math.max(0, f.w) * Math.max(0, f.h);
function inter(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const hh = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && hh > 0 ? w * hh : 0;
}
/** Merges detections of the same face from several passes: heavy overlap → one box (their union). */
export function mergeFaces(faces, thresh = 0.3) {
  const keep = [];
  for (const f of [...faces].filter((x) => x.w > 1 && x.h > 1).sort((a, b) => b.score - a.score)) {
    const k = keep.find((g) => inter(g, f) / Math.max(1, Math.min(area(g), area(f))) > thresh);
    if (!k) { keep.push({ ...f }); continue; }
    const x = Math.min(k.x, f.x), y = Math.min(k.y, f.y);
    k.w = Math.max(k.x + k.w, f.x + f.w) - x; k.h = Math.max(k.y + k.h, f.y + f.h) - y; k.x = x; k.y = y;
  }
  return keep.sort((a, b) => area(b) - area(a));
}

/** The area hidden for one detected face (YuNet boxes run brow→chin): a soft ellipse incl. forehead / hair. */
export function faceRegion(f, kind = 'mosaic', strength = 60) {
  const cx = f.x + f.w / 2, cy = f.y + f.h * 0.44;
  const rx = f.w * 0.72, ry = f.h * 0.74;
  const size = Math.max(f.w, f.h);
  const t = Math.max(0, Math.min(100, strength)) / 100;
  const param = kind === 'blur' ? Math.max(2, size * (0.08 + 0.2 * t)) : Math.max(3, Math.round(size / (12 - 8 * t)));
  return { rect: { x: cx - rx, y: cy - ry, w: 2 * rx, h: 2 * ry }, shape: 'ellipse', ellipse: { cx, cy, rx, ry }, feather: Math.max(1.5, size * 0.05), param };
}

/** Emoji layer props covering one face. */
export function faceEmoji(f, char) {
  return { char, size: Math.round(Math.max(f.w, f.h) * 1.5), x: f.x + f.w / 2, y: f.y + f.h * 0.42 };
}

/**
 * Finds faces in a photo canvas: one pass on the whole photo, plus (long side > 1600) overlapping tiles at
 * full resolution or (long side < 1000) an enlarged copy — tiny faces in group photos are otherwise missed.
 */
export async function detectFaces(src, { detect = api.faces, onProgress = null } = {}) {
  const W = src.width, H = src.height, L = Math.max(W, H);
  const found = [];
  const pass = async (canvas, k, ox, oy) => {
    const r = await detect(await canvasToBlob(canvas, 'image/jpeg', 0.92));
    for (const f of r?.faces || []) found.push({ ...f, x: f.x / k + ox, y: f.y / k + oy, w: f.w / k, h: f.h / k });
  };
  await pass(src, 1, 0, 0);
  if (L < 1000) {
    const k = 1280 / L;
    const up = createCanvas(W * k, H * k);
    const c = up.getContext('2d');
    c.imageSmoothingQuality = 'high';
    c.drawImage(src, 0, 0, up.width, up.height);
    await pass(up, up.width / W, 0, 0);
  } else if (L > 1600) {
    const tiles = tileRects(W, H);
    for (let i = 0; i < tiles.length; i++) {
      onProgress?.(`正在仔细找小的脸… ${i + 1}/${tiles.length}`);
      await pass(cropCanvas(src, tiles[i]), 1, tiles[i].x, tiles[i].y);
    }
  }
  return mergeFaces(found);
}

// ---------------------------------------------------------------- panel
const TOOLS = [
  { id: 'mosaic', label: '马赛克', icon: 'mosaic', tip: '马赛克笔：涂哪里，哪里变成格子' },
  { id: 'blur', label: '模糊', icon: 'mzBlur', tip: '模糊笔：涂哪里，哪里变模糊' },
  { id: 'box', label: '框选', icon: 'mzBox', tip: '框选打码：拖出方框，一下遮住一块' },
  { id: 'doodle', label: '涂鸦', icon: 'mzPen', tip: '涂鸦：用彩色画笔在图上画' },
];
const TOOL_HINT = {
  mosaic: '在要遮住的地方涂一涂，每一笔都能撤销',
  blur: '在要遮住的地方涂一涂，涂过的地方会变模糊',
  box: '在图上拖出一个方框，松手就遮住',
  doodle: '随手画，圈重点、写记号都可以',
};
let faceFlashOff = null;
let lastFace = null;      // { doc, version, faces } of the last 一键人脸打码 (for live re-apply)
let reapplying = false;

registerPanel({
  id: 'mosaic',
  title: '打码',
  icon: icon('mosaic', 22),
  order: 100,
  tip: '马赛克、模糊，一键给人脸打码',
  mount(el, ctx) {
    const { viewport } = ctx;
    const s = mosaicSettings();

    // ---------------------------------------------------------- 一键人脸打码
    const faceMode = segmented({
      block: true, value: s.face, className: 'mz-face-seg',
      options: [
        { value: 'mosaic', label: '马赛克', tip: '把脸变成格子' },
        { value: 'blur', label: '模糊', tip: '把脸变模糊' },
        { value: 'emoji', label: '表情 😊', tip: '用可爱的表情盖住脸，之后还能拖动' },
      ],
      onChange: (v) => { s.face = v; syncFace(); scheduleReapply(); },
    });
    const emojiRow = h('div', { class: 'mz-emojis' }, ...FACE_EMOJIS.map((ch) =>
      h('button', { type: 'button', class: 'mz-emoji', 'data-char': ch, 'data-tip': '用这个表情遮脸', onclick: () => { s.emoji = ch; syncFace(); scheduleReapply(); } }, ch)));
    const faceStrength = slider({ label: '遮挡强度', min: 1, max: 100, step: 1, value: s.faceStrength, defaultValue: 60,
      onInput: (v) => { s.faceStrength = v; scheduleReapply(); } });
    const faceBtn = button({ text: '一键人脸打码', icon: 'mzFace', primary: true, size: 'lg', block: true, className: 'mz-face-run',
      tip: '自动找出照片里所有的脸并遮住（可撤销）', onClick: () => runFaces() });
    const faceStatus = h('div', { class: 'mz-face-status', hidden: true });
    const faceCard = h('div', { class: 'mz-face' },
      h('div', { class: 'mz-face-head' },
        h('div', { class: 'mz-face-art', html: icon('mzFace', 24) }),
        h('div', {},
          h('div', { class: 'mz-face-title' }, '一键人脸打码'),
          h('div', { class: 'mz-face-sub' }, '发合影前，一键遮住小朋友的脸'))),
      h('div', { class: 'field-label' }, '遮挡方式'), faceMode, emojiRow, faceStrength, faceBtn, faceStatus);
    const secFace = section('');
    secFace.querySelector('.sec-h').remove();
    secFace.append(faceCard);

    // ---------------------------------------------------------- 手动打码
    const toolBtns = TOOLS.map((t) => h('button', { type: 'button', class: 'mz-tool', 'data-tool': t.id, 'data-tip': t.tip, onclick: () => pickTool(t.id) },
      h('span', { class: 'mz-tool-ico', html: icon(t.icon, 22) }), h('span', { class: 'mz-tool-label' }, t.label)));
    const toolGrid = h('div', { class: 'mz-tools' }, ...toolBtns);
    const toolHint = h('div', { class: 'hint mz-tool-hint' });

    const size = slider({ label: '画笔大小', min: 2, max: 800, step: 1, unit: 'px', power: 2, value: store.ui.brush.size,
      onInput: (v) => { store.ui.brush.size = v; store.emit('brush:changed', store.ui.brush); showSizePreview(); } });
    const block = slider({ label: '格子大小', min: 1, max: 100, step: 1, value: s.block, defaultValue: 50,
      onInput: (v) => { s.block = v; } });
    const blur = slider({ label: '模糊程度', min: 1, max: 100, step: 1, value: s.blur, defaultValue: 50,
      onInput: (v) => { s.blur = v; } });
    const boxKind = segmented({
      block: true, size: 'sm', value: s.boxKind,
      options: [{ value: 'mosaic', label: '马赛克' }, { value: 'blur', label: '模糊' }],
      onChange: (v) => { s.boxKind = v; pickTool('box'); },
    });
    const boxKindField = h('div', { class: 'mz-field' }, h('div', { class: 'field-label' }, '框里的效果'), boxKind);
    const colors = colorSwatches({ colors: DOODLE_COLORS, value: s.color, custom: true,
      onChange: (hex) => { s.color = hex; viewport.requestOverlay(); }, onInput: (hex) => { s.color = hex; viewport.requestOverlay(); } });
    const colorField = h('div', { class: 'mz-field' }, h('div', { class: 'field-label' }, '颜色'), colors);
    const highlighter = toggle({ label: '荧光笔', hint: '半透明，像荧光笔一样透出底下的图', value: s.highlighter,
      onChange: (v) => { s.highlighter = v; store.emit('tool:changed', { id: currentTool().id }); viewport.requestOverlay(); } });
    const doneBtn = button({ text: '完成', icon: 'check', variant: 'secondary', size: 'sm', className: 'mz-done', tip: '放下画笔，可以拖动画布', onClick: () => setTool('pan') });
    const secManual = section('手动打码', '选一个工具，在图上涂抹或拖框', { right: doneBtn });
    secManual.append(toolGrid, toolHint, boxKindField, colorField, size, block, blur, highlighter);

    el.append(secFace, secManual);

    // ---------------------------------------------------------- behaviour
    function pickTool(id) {
      s.tool = id;
      if (id === 'mosaic' || id === 'blur') setTool('mosaic-brush', { kind: id });
      else if (id === 'box') setTool('mosaic-box', { kind: s.boxKind });
      else setTool('doodle-brush');
    }
    function activeTool() {
      const t = currentTool();
      if (t.id === 'mosaic-brush') return t.kind;
      if (t.id === 'mosaic-box') return 'box';
      if (t.id === 'doodle-brush') return 'doodle';
      return null;
    }

    function showFaceStatus(kind, text, sub) {
      faceStatus.hidden = false;
      faceStatus.className = `mz-face-status ${kind}`;
      faceStatus.innerHTML = '';
      faceStatus.append(h('span', { class: 'mz-fs-ico', html: icon(kind === 'ok' ? 'success' : 'alert', 16) }),
        h('span', { class: 'mz-fs-text' }, h('span', { class: 'mz-fs-main' }, text), sub ? h('span', { class: 'mz-fs-sub' }, sub) : ''));
    }

    async function runFaces() {
      const doc = store.doc, src = doc?.source;
      if (!doc) return;
      const b = busy('正在找人脸…');
      try {
        await nextFrame();
        const faces = await detectFaces(src, { onProgress: (m) => b.update(m) });
        if (store.doc !== doc || doc.source !== src) return;
        if (!faces.length) {
          lastFace = null;
          showFaceStatus('warn', '没有找到人脸', '脸太小、侧脸或被挡住时可能找不到，可以用下面的「框选」手动遮住');
          toast('没有找到人脸，可以用「框选」手动遮住', 'warning');
          return;
        }
        applyFaces(faces, true);
      } catch (err) {
        console.warn('[mosaic] faces failed:', err);
        toast(err.message || '找人脸失败了，请再试一次', 'error');
      } finally {
        b.done();
      }
    }

    /** Hides the given faces with the current style — ONE undo step. */
    function applyFaces(faces, flash) {
      const n = faces.length;
      if (s.face === 'emoji') {
        const layers = faces.map((f) => createEmojiLayer(faceEmoji(f, s.emoji)));
        store.commit('表情遮脸', (d) => { d.layers = [...(d.layers || []), ...layers]; });
        setTool('layer');
        selectLayer(layers[0].id);
        showFaceStatus('ok', `找到 ${n} 张脸，已用表情盖住`, '表情可以拖动、缩放；按 Delete 删掉多余的');
      } else {
        const regions = faces.map((f) => faceRegion(f, s.face, s.faceStrength));
        applyRegions(s.face === 'blur' ? '人脸模糊' : '人脸马赛克', regions, { kind: s.face });
        if (flash) flashFaces(regions);
        showFaceStatus('ok', `找到 ${n} 张脸，已全部遮住`, '拖「遮挡强度」可以直接调；漏掉的脸用「框选」补上');
      }
      lastFace = { doc: store.doc, version: store.version, faces };
    }

    /** Style / strength changed right after 一键人脸打码 → redo that step with the new settings (still one step). */
    function reapplyFaces() {
      const lf = lastFace;
      if (!lf || lf.doc !== store.doc || lf.version !== store.version || !store.canUndo()) return false;
      const wasEmoji = currentTool().id === 'layer' && s.face !== 'emoji';
      faceFlashOff?.();
      reapplying = true;
      try {
        store.undo();
        if (wasEmoji) { selectLayer(null); pickTool(s.tool || 'mosaic'); }
        applyFaces(lf.faces, false);
      } finally { reapplying = false; }
      return true;
    }
    let reRaf = 0;
    const scheduleReapply = () => { if (!reRaf) reRaf = requestAnimationFrame(() => { reRaf = 0; reapplyFaces(); }); };
    ctx.onDispose(() => cancelAnimationFrame(reRaf));

    // green rings around the faces just hidden, fading out (so the user sees what was covered)
    function flashFaces(regions) {
      faceFlashOff?.();
      const t0 = performance.now(), DUR = 1800;
      let raf = 0;
      const remove = viewport.addOverlay((c, vp) => {
        const t = (performance.now() - t0) / DUR;
        if (t >= 1) return;
        c.save();
        c.globalAlpha = 1 - t * t;
        for (const g of regions) {
          const p = vp.toScreen(g.ellipse.cx, g.ellipse.cy);
          c.beginPath();
          c.ellipse(p.x, p.y, g.ellipse.rx * vp.zoom + 4, g.ellipse.ry * vp.zoom + 4, 0, 0, Math.PI * 2);
          c.lineWidth = 4; c.strokeStyle = 'rgba(0,0,0,0.25)'; c.stroke();
          c.lineWidth = 2.5; c.strokeStyle = '#22c55e'; c.stroke();
        }
        c.restore();
      });
      const tick = () => {
        if (performance.now() - t0 >= DUR) { off(); return; }
        viewport.requestOverlay();
        raf = requestAnimationFrame(tick);
      };
      const off = () => { cancelAnimationFrame(raf); remove(); viewport.requestOverlay(); if (faceFlashOff === off) faceFlashOff = null; };
      faceFlashOff = off;
      raf = requestAnimationFrame(tick);
    }

    let sizeTimer = 0;
    function showSizePreview() {
      if (!viewport.pointer.inside) {
        viewport.pointer.sx = viewport.width / 2; viewport.pointer.sy = viewport.height / 2; viewport.pointer.inside = true;
        clearTimeout(sizeTimer);
        sizeTimer = setTimeout(() => { viewport.pointer.inside = false; viewport.requestOverlay(); }, 700);
      }
      viewport.requestOverlay();
    }
    ctx.onDispose(() => { clearTimeout(sizeTimer); faceFlashOff?.(); releasePattern(); });

    function syncFace() {
      faceMode.setValue(s.face);
      const emoji = s.face === 'emoji';
      emojiRow.hidden = !emoji;
      faceStrength.hidden = emoji;
      for (const btn of emojiRow.children) btn.classList.toggle('on', btn.dataset.char === s.emoji);
    }
    function syncTool() {
      const t = activeTool();
      for (const btn of toolBtns) btn.classList.toggle('on', btn.dataset.tool === t);
      const shown = t || s.tool;
      toolHint.textContent = t ? TOOL_HINT[t] : currentTool().id === 'layer' ? '拖动表情可以调整位置，拖角上的圆点可以缩放' : '点上面的工具开始打码';
      const brushy = t === 'mosaic' || t === 'blur' || t === 'doodle';
      size.hidden = !brushy;
      block.hidden = !(t === 'mosaic' || (t === 'box' && s.boxKind === 'mosaic'));
      blur.hidden = !(t === 'blur' || (t === 'box' && s.boxKind === 'blur'));
      boxKindField.hidden = t !== 'box';
      colorField.hidden = t !== 'doodle';
      highlighter.hidden = t !== 'doodle';
      doneBtn.hidden = !t;
      boxKind.setValue(s.boxKind);
      colors.setValue(s.color);
      highlighter.setValue(s.highlighter);
      size.setValue(store.ui.brush.size);
      block.setValue(s.block);
      blur.setValue(s.blur);
      el.dataset.tool = shown || '';
    }
    ctx.on('tool:changed', syncTool);
    ctx.on('brush:changed', () => size.setValue(store.ui.brush.size));
    ctx.on('doc:changed', (p) => {
      if (!reapplying && (p?.reason === 'undo' || p?.reason === 'redo')) faceStatus.hidden = true;
      if (p?.reason === 'load') faceStatus.hidden = true;
    });
    syncFace();
    pickTool(s.tool || 'mosaic');
    syncTool();
  },
});
