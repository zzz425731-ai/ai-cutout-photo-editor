// main.js — app entry: wires layout, top bar, shortcuts, drag & drop, paste, status, panels.

import { store } from './core/store.js';
import { viewport } from './core/viewport.js';
import * as tools from './core/tools.js';
import * as brush from './core/brush.js';
import * as panels from './core/panels.js';
import * as ui from './core/ui.js';
import * as api from './core/api.js';
import * as io from './core/io.js';
import * as render from './core/render.js';
import * as actions from './core/actions.js';
import * as exporter from './core/exporter.js';
import { icon, ICONS } from './core/icons.js';
import { openExportDialog } from './core/export-dialog.js';

const $ = (s) => document.querySelector(s);

// ---------------------------------------------------------------- icons in static HTML
for (const el of document.querySelectorAll('[data-icon]')) {
  el.innerHTML = icon(el.dataset.icon, +(el.dataset.size || 20));
  if (!el.classList.contains('logo') && !el.classList.contains('dz-main')) el.style.display = 'inline-flex';
}

// ---------------------------------------------------------------- core init
ui.initTooltips();
viewport.init($('#stage'), $('#view'), $('#overlay'));
tools.setTool('pan');

const ctx = { store, viewport, tools, brush, api, ui, render, io, actions, exporter, icons: { icon, ICONS }, panels };
panels.initPanels({ rail: $('#rail'), panel: $('#panel'), ctx });

// expose for debugging and for tests driven through CDP
window.__app = ctx;

// ---------------------------------------------------------------- panels (loaded independently: one broken panel can't break the app)
const PANEL_IDS = ['cutout', 'background', 'idphoto', 'adjust', 'beauty', 'crop', 'text', 'sticker', 'erase', 'mosaic', 'batch'];
const panelsReady = Promise.allSettled(PANEL_IDS.map((id) => import(`./panels/${id}.js`))).then((res) => {
  res.forEach((r, i) => { if (r.status === 'rejected') console.error(`[main] panel "${PANEL_IDS[i]}" failed to load:`, r.reason); });
  const first = panels.getPanels()[0];
  if (first) panels.showPanel(first.id);
  document.body.classList.add('ready');
});
window.__ready = panelsReady;

// ---------------------------------------------------------------- top bar
const btn = {
  open: $('#btn-open'), undo: $('#btn-undo'), redo: $('#btn-redo'),
  zoomOut: $('#btn-zoom-out'), zoomIn: $('#btn-zoom-in'), zoom100: $('#btn-zoom-100'), fit: $('#btn-fit'),
  compare: $('#btn-compare'), save: $('#btn-save'), exp: $('#btn-export'),
};
btn.open.addEventListener('click', () => actions.openImage());
$('#file-input').addEventListener('change', (e) => { const f = e.target.files?.[0]; if (f) actions.loadFile(f); });
$('#dropzone').addEventListener('click', () => actions.openImage());
btn.undo.addEventListener('click', () => undo());
btn.redo.addEventListener('click', () => redo());
btn.zoomOut.addEventListener('click', () => viewport.zoomStep(-1));
btn.zoomIn.addEventListener('click', () => viewport.zoomStep(1));
btn.fit.addEventListener('click', () => viewport.fit());
btn.zoom100.addEventListener('click', () => {
  if (Math.abs(viewport.zoom - 1) < 0.001) viewport.fit(); else viewport.setZoom(1);
});
btn.save.addEventListener('click', () => actions.saveToOutput());
btn.exp.addEventListener('click', () => openExportDialog());

// hold-to-compare
const compareOn = () => { if (store.doc) { viewport.setCompare(true); btn.compare.classList.add('pressed'); } };
const compareOff = () => { viewport.setCompare(false); btn.compare.classList.remove('pressed'); };
btn.compare.addEventListener('pointerdown', (e) => { if (e.button === 0) { btn.compare.setPointerCapture(e.pointerId); compareOn(); } });
btn.compare.addEventListener('pointerup', compareOff);
btn.compare.addEventListener('pointercancel', compareOff);
btn.compare.addEventListener('lostpointercapture', compareOff);

// (not while a brush stroke is still being painted: the stroke would land on a replaced plane)
function undo() {
  if (!store.canUndo() || viewport.isStroking) return;
  const label = store.undoLabel();
  store.undo();
  hintFlash(`已撤销：${label}`);
}
function redo() {
  if (!store.canRedo() || viewport.isStroking) return;
  const label = store.redoLabel();
  store.redo();
  hintFlash(`已重做：${label}`);
}

function syncTopbar() {
  const has = !!store.doc;
  document.body.classList.toggle('has-doc', has);
  btn.undo.disabled = !store.canUndo();
  btn.redo.disabled = !store.canRedo();
  btn.undo.dataset.tip = store.canUndo() ? `撤销：${store.undoLabel()}` : '撤销';
  btn.redo.dataset.tip = store.canRedo() ? `重做：${store.redoLabel()}` : '重做';
  for (const b of [btn.zoomOut, btn.zoomIn, btn.zoom100, btn.fit, btn.compare, btn.save, btn.exp]) b.disabled = !has;
  const hist = $('#sb-history');
  hist.textContent = !has ? '' : store.dirty ? '有未保存的修改' : savedOnce ? '已保存' : '';
  hist.classList.toggle('unsaved', has && store.dirty);
}
let savedOnce = false;
store.on('saved', () => { savedOnce = true; syncTopbar(); });
store.on('doc:loaded', () => { savedOnce = false; });
store.on('history:changed', syncTopbar);
store.on('doc:loaded', syncTopbar);
syncTopbar();

// ---------------------------------------------------------------- status bar
const sbSize = $('#sb-size .sb-v'), sbZoom = $('#sb-zoom .sb-v'), sbHint = $('#sb-hint');
let hintTimer = 0, flashText = '';
function syncStatus() {
  const d = store.doc;
  sbSize.textContent = d ? `${d.width} × ${d.height}` : '—';
  const z = d ? `${Math.round(viewport.zoom * 100)}%` : '—';
  sbZoom.textContent = z;
  btn.zoom100.textContent = d ? z : '100%';
  if (flashText) { sbHint.textContent = flashText; return; }
  const t = tools.currentTool();
  sbHint.textContent = !d ? '打开一张图片开始：拖入、点击「打开图片」或 Ctrl+V 粘贴'
    : (t?.hint || '滚轮缩放 · 按住空格拖动画布 · 按住 \\ 对比原图');
}
function hintFlash(text) {
  flashText = text;
  syncStatus();
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { flashText = ''; syncStatus(); }, 1600);
}
for (const e of ['doc:loaded', 'doc:changed', 'view:changed', 'tool:changed', 'brush:changed']) store.on(e, () => requestAnimationFrame(syncStatus));
syncStatus();

// ---------------------------------------------------------------- engine badge
const badge = $('#engine-badge');
async function checkStatus() {
  try {
    const s = await api.status();
    const gpu = /directml|cuda|gpu/i.test(s.provider || '');
    badge.className = `engine-badge ${gpu ? 'gpu' : 'cpu'}`;
    badge.querySelector('.eb-text').textContent = gpu ? 'GPU 加速' : 'CPU 模式';
    const dev = String(s.device || '').replace(/NVIDIA GeForce /i, '').replace(/ Laptop GPU/i, ' 笔记本显卡');
    badge.dataset.tip = gpu ? `AI 使用显卡运行：${dev || s.provider}` : 'AI 使用处理器运行（没有可用的显卡加速，速度会慢一些）';
    store.ui.serverStatus = s;
    return true;
  } catch {
    badge.className = 'engine-badge off';
    badge.querySelector('.eb-text').textContent = '未连接';
    badge.dataset.tip = '无法连接本地 AI 服务：请重新双击「启动抠图P图工具」';
    return false;
  }
}
checkStatus().then((ok) => { if (!ok) setTimeout(checkStatus, 3000); });

// ---------------------------------------------------------------- keyboard
function isTyping(e) {
  const t = e.target;
  return t && (t.isContentEditable || (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !['range', 'checkbox', 'radio', 'button', 'color'].includes(t.type)));
}
window.addEventListener('keydown', (e) => {
  if (document.querySelector('.modal-back')) return; // modal handles its own keys
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'o') { e.preventDefault(); actions.openImage(); return; }
  if (isTyping(e)) return;
  if (ui.isBusy()) { if (mod) e.preventDefault(); return; }
  if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
  if (mod && k === 's') { e.preventDefault(); if (store.doc) actions.saveToOutput(); return; }
  if (mod && k === 'e') { e.preventDefault(); if (store.doc) openExportDialog(); return; }
  if (mod && (e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0')) { e.preventDefault(); viewport.fit(); return; }
  if (mod && (e.key === '1' || e.code === 'Digit1' || e.code === 'Numpad1')) { e.preventDefault(); viewport.setZoom(1); return; }
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); viewport.zoomStep(1); return; }
  if (mod && e.key === '-') { e.preventDefault(); viewport.zoomStep(-1); return; }
  if (!mod && !e.altKey && (e.key === '[' || e.key === ']')) {
    e.preventDefault();
    store.ui.brush.size = brush.brushSizeStep(store.ui.brush.size, e.key === ']' ? 1 : -1);
    store.emit('brush:changed', store.ui.brush);
    viewport.requestOverlay();
    hintFlash(`画笔大小：${store.ui.brush.size}`);
    return;
  }
  if (e.key === '\\' && !e.repeat) { compareOn(); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && store.ui.selectedLayerId && store.doc) {
    const id = store.ui.selectedLayerId;
    if (store.doc.layers?.some((l) => l.id === id)) {
      e.preventDefault();
      store.commit('删除图层', (d) => { d.layers = d.layers.filter((l) => l.id !== id); });
      store.ui.selectedLayerId = null;
      store.emit('layer:selected', { id: null });
    }
  }
});
window.addEventListener('keyup', (e) => { if (e.key === '\\') compareOff(); });
window.addEventListener('blur', compareOff);

// ---------------------------------------------------------------- paste
window.addEventListener('paste', (e) => {
  if (isTyping(e) || document.querySelector('.modal-back')) return;
  const items = [...(e.clipboardData?.items || [])];
  const item = items.find((it) => it.kind === 'file' && it.type.startsWith('image/'));
  if (item) {
    e.preventDefault();
    const f = item.getAsFile();
    if (f) actions.loadFile(f, { name: '粘贴的图片' });
    return;
  }
  const file = [...(e.clipboardData?.files || [])][0];
  if (file) { e.preventDefault(); actions.loadFile(file); return; }
  if (items.some((it) => it.kind === 'string')) ui.toast('剪贴板里没有图片。可以先在别处「复制图片」，再按 Ctrl+V', 'info');
});

// ---------------------------------------------------------------- drag & drop
const dropHint = $('#drop-hint');
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; dropHint.hidden = false; });
window.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropHint.hidden = true; });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0; dropHint.hidden = true;
  const files = [...e.dataTransfer.files];
  if (!files.length) return;
  if (store.ui.panel === 'batch' && files.length > 1) { store.emit('files:dropped', files); return; }
  const img = files.find((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|bmp|gif)$/i.test(f.name)) || files[0];
  actions.loadFile(img);
  if (files.length > 1) ui.toast('一次只能打开一张图片；要处理很多张，请使用左侧「批量」', 'info');
});

// ---------------------------------------------------------------- unsaved-work guard
window.addEventListener('beforeunload', (e) => {
  if (store.doc && store.dirty && !window.__noUnloadPrompt) { e.preventDefault(); e.returnValue = ''; }
});

// ---------------------------------------------------------------- doc loaded
store.on('doc:loaded', () => {
  document.body.classList.add('has-doc');
  document.title = store.doc ? `${store.doc.name} - AI抠图P图工具` : 'AI抠图P图工具';
});
