// core/panels.js — left-rail panel registry and mount lifecycle.
//
//   registerPanel({ id, title, icon /* svg string or icons.js name */, order, tip?, requiresDoc = true,
//                   mount(el, ctx), unmount?() })
//   showPanel(id)   currentPanelId()   getPanels()   refreshPanel()
//
// mount(el, ctx) is called with an empty container each time the panel becomes visible and again when a
// new image is opened. ctx = { store, viewport, tools, api, ui, render, io, brush, actions, icons, panels,
//   on(evt, fn)         store.on that is removed automatically when the panel unmounts
//   onDispose(fn)       cleanup callback on unmount
//   el }
// When the panel switches, the active tool is reset to 'pan' (a panel re-activates its tool in mount).

import { store } from './store.js';
import { h } from './ui.js';
import { icon as iconSvg } from './icons.js';

const panels = new Map();
let railEl = null, panelEl = null, baseCtx = null;
let current = null, currentId = null, disposers = [];
let renderRailQueued = false;

export function registerPanel(p) {
  if (!p || !p.id) throw new Error('registerPanel: id required');
  panels.set(p.id, { requiresDoc: true, order: 999, ...p });
  queueRail();
  if (panelEl && !currentId) { /* first panel shows once main calls showPanel */ }
  return p;
}

export function getPanels() { return [...panels.values()].sort((a, b) => a.order - b.order); }
export function currentPanelId() { return currentId; }

export function initPanels({ rail, panel, ctx }) {
  railEl = rail; panelEl = panel; baseCtx = ctx;
  renderRail();
  store.on('doc:loaded', () => { renderRail(); mountCurrent(); });
}

function queueRail() {
  if (!railEl || renderRailQueued) return;
  renderRailQueued = true;
  queueMicrotask(() => { renderRailQueued = false; renderRail(); });
}

function renderRail() {
  if (!railEl) return;
  railEl.innerHTML = '';
  for (const p of getPanels()) {
    const svg = typeof p.icon === 'string' && p.icon.trim().startsWith('<svg') ? p.icon : iconSvg(p.icon || 'info', 22);
    const b = h('button', {
      type: 'button', class: `rail-btn${p.id === currentId ? ' on' : ''}${p.requiresDoc && !store.doc ? ' needs-doc' : ''}`,
      'data-panel': p.id, 'data-tip': p.tip || null, 'aria-label': p.title, 'aria-pressed': p.id === currentId ? 'true' : 'false',
      onclick: () => showPanel(p.id),
    }, h('span', { class: 'rail-ico', html: svg }), h('span', { class: 'rail-label' }, p.title));
    railEl.append(b);
  }
}

export function showPanel(id) {
  if (!panels.has(id)) return;
  if (id === currentId) return;
  currentId = id;
  store.ui.panel = id;
  for (const b of railEl?.querySelectorAll('.rail-btn') || []) {
    const on = b.dataset.panel === id;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  mountCurrent();
  store.emit('panel:changed', { id });
}

export function refreshPanel() { mountCurrent(); }

function unmountCurrent() {
  for (const d of disposers.splice(0)) { try { d(); } catch (err) { console.error('[panels] dispose failed:', err); } }
  if (current) { try { current.unmount?.(); } catch (err) { console.error(`[panels] ${current.id}.unmount failed:`, err); } }
  current = null;
}

function mountCurrent() {
  if (!panelEl || !currentId) return;
  unmountCurrent();
  const p = panels.get(currentId);
  baseCtx.tools?.setTool?.('pan');
  panelEl.innerHTML = '';
  const head = h('div', { class: 'panel-head' },
    h('div', { class: 'panel-title' }, p.title),
    p.subtitle ? h('div', { class: 'panel-sub' }, p.subtitle) : null);
  const body = h('div', { class: 'panel-body' });
  panelEl.append(head, body);
  if (p.requiresDoc && !store.doc) {
    body.append(h('div', { class: 'panel-empty' },
      h('div', { class: 'pe-ico', html: iconSvg('imagePlus', 36) }),
      h('div', { class: 'pe-title' }, '先打开一张图片'),
      h('div', { class: 'pe-text' }, '把图片拖到右边，或点击下面的按钮'),
      h('button', { type: 'button', class: 'btn primary', onclick: () => baseCtx.actions?.openImage?.() }, '打开图片')));
    current = null;
    return;
  }
  const ctx = {
    ...baseCtx,
    el: body,
    on(evt, fn) { const off = store.on(evt, fn); disposers.push(off); return off; },
    onDispose(fn) { disposers.push(fn); },
  };
  current = p;
  try {
    p.mount(body, ctx);
  } catch (err) {
    console.error(`[panels] ${p.id}.mount failed:`, err);
    body.innerHTML = '';
    body.append(h('div', { class: 'panel-error' }, '这个功能暂时出了点问题，请刷新页面后重试。'));
  }
}
