// panels/text/fonts.js — installed-font detection + a font picker whose items are drawn in their own font.
//
//   FONT_CANDIDATES                 [{ family, name }]
//   installedFonts() → [{family,name}]   (canvas measureText comparison; cached)
//   isInstalled(family) → bool
//   pickFont([family…]) → first installed family (or 'Microsoft YaHei')
//   stackFor(family) → CSS font stack stored in text layers
//   familyOf(stack) → family name (maps the default UI stack to 'Microsoft YaHei')
//   fontName(family) → display name
//   fontPicker({ value, onChange }) → element (+ setValue, setDisabled, close)

import { h } from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { DEFAULT_FONT, fontStack } from '../../layers/render-layers.js';

export const FONT_CANDIDATES = [
  { family: 'Microsoft YaHei', name: '微软雅黑' },
  { family: 'SimHei', name: '黑体' },
  { family: 'DengXian', name: '等线' },
  { family: 'SimSun', name: '宋体' },
  { family: 'KaiTi', name: '楷体' },
  { family: 'FangSong', name: '仿宋' },
  { family: 'LiSu', name: '隶书' },
  { family: 'YouYuan', name: '幼圆' },
  { family: 'STXingkai', name: '华文行楷' },
  { family: 'STCaiyun', name: '华文彩云' },
  { family: 'STHupo', name: '华文琥珀' },
  { family: 'STXinwei', name: '华文新魏' },
  { family: 'FZShuTi', name: '方正舒体' },
  { family: 'FZYaoTi', name: '方正姚体' },
  { family: 'Arial', name: 'Arial' },
  { family: 'Georgia', name: 'Georgia' },
  { family: 'Impact', name: 'Impact' },
];
const DEFAULT_FAMILY = 'Microsoft YaHei';

let installed = null;
/** A font counts as installed when text set in it measures differently from every generic fallback. */
export function installedFonts() {
  if (installed) return installed;
  const ctx = document.createElement('canvas').getContext('2d');
  const sample = 'abcXYZ永和汉字123';
  const generics = ['monospace', 'serif', 'sans-serif'];
  const base = generics.map((g) => { ctx.font = `40px ${g}`; return ctx.measureText(sample).width; });
  installed = FONT_CANDIDATES.filter((f) => {
    if (f.family === DEFAULT_FAMILY) return true;
    return generics.some((g, i) => { ctx.font = `40px "${f.family}",${g}`; return Math.abs(ctx.measureText(sample).width - base[i]) > 0.5; });
  });
  return installed;
}
export const isInstalled = (family) => installedFonts().some((f) => f.family === family);
export function pickFont(prefs = []) { return prefs.find(isInstalled) || DEFAULT_FAMILY; }

export function stackFor(family) { return !family || family === DEFAULT_FAMILY ? DEFAULT_FONT : fontStack(family); }
export function familyOf(stack) {
  const m = String(stack || '').match(/^\s*"?([^",]+)"?/);
  const f = m ? m[1].trim() : DEFAULT_FAMILY;
  return /^Microsoft YaHei/i.test(f) || f === 'PingFang SC' || f === 'system-ui' || f === 'sans-serif' ? DEFAULT_FAMILY : f;
}
export function fontName(family) { return FONT_CANDIDATES.find((f) => f.family === family)?.name || family; }

// ---------------------------------------------------------------- picker
export function fontPicker({ value = DEFAULT_FAMILY, onChange }) {
  let cur = value;
  let pop = null;
  const label = h('span', { class: 'text-font-name' });
  const btn = h('button', { type: 'button', class: 'text-font-btn', 'aria-haspopup': 'listbox', 'aria-label': '选择字体', onclick: () => (pop ? close() : open()) },
    label, h('span', { class: 'text-font-caret', html: icon('chevronDown', 16) }));
  const el = h('div', { class: 'text-font' }, btn);

  function paint() {
    label.textContent = fontName(cur);
    label.style.fontFamily = stackFor(cur);
  }
  function onDocDown(e) { if (pop && !pop.contains(e.target) && !btn.contains(e.target)) close(); }
  function onKey(e) {
    if (!pop) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); btn.focus(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      const items = [...pop.querySelectorAll('.text-font-item')];
      const i = items.indexOf(document.activeElement);
      const j = i < 0 ? items.findIndex((x) => x.classList.contains('on')) : i + (e.key === 'ArrowDown' ? 1 : -1);
      items[Math.max(0, Math.min(items.length - 1, j))]?.focus();
    }
  }
  function open() {
    if (btn.disabled) return;
    pop = h('div', { class: 'text-font-pop', role: 'listbox', 'aria-label': '字体' });
    for (const f of installedFonts()) {
      const latin = /^[A-Za-z]/.test(f.name) && f.name === f.family;
      const it = h('button', {
        type: 'button', class: `text-font-item${f.family === cur ? ' on' : ''}`, role: 'option', 'aria-selected': f.family === cur ? 'true' : 'false',
        style: { fontFamily: stackFor(f.family) },
        onclick: () => { close(); if (f.family !== cur) { cur = f.family; paint(); onChange?.(f.family); } },
      }, h('span', { class: 'tfi-name' }, f.name), latin ? h('span', { class: 'tfi-sample' }, 'Abc 123') : null,
      f.family === cur ? h('span', { class: 'tfi-check', html: icon('check', 16) }) : null);
      pop.append(it);
    }
    document.body.append(pop);
    const r = btn.getBoundingClientRect();
    const spaceBelow = innerHeight - r.bottom - 12, spaceAbove = r.top - 12;
    const want = Math.min(360, pop.scrollHeight + 2);
    pop.style.left = `${Math.round(r.left)}px`;
    pop.style.width = `${Math.round(r.width)}px`;
    if (spaceBelow >= Math.min(want, 240) || spaceBelow >= spaceAbove) {
      pop.style.top = `${Math.round(r.bottom + 4)}px`;
      pop.style.maxHeight = `${Math.max(160, Math.min(360, spaceBelow))}px`;
    } else {
      const hgt = Math.min(want, spaceAbove);
      pop.style.top = `${Math.round(r.top - 4 - hgt)}px`;
      pop.style.maxHeight = `${hgt}px`;
    }
    btn.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    btn.closest('.panel-body')?.addEventListener('scroll', close, { once: true });
    requestAnimationFrame(() => pop?.querySelector('.text-font-item.on')?.scrollIntoView({ block: 'nearest' }));
  }
  function close() {
    if (!pop) return;
    pop.remove();
    pop = null;
    btn.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
  }
  el.setValue = (v) => { cur = v || DEFAULT_FAMILY; paint(); };
  el.getValue = () => cur;
  el.setDisabled = (d) => { btn.disabled = !!d; if (d) close(); };
  el.close = close;
  paint();
  return el;
}
