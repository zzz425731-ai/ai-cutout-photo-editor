// panels/text.js — 文字: add text layers, one-click 花字 presets, full text editor, layer list.
// The layer transform tool (tools/layer-tool.js) is active while this panel is open.

import { registerPanel } from '../core/panels.js';
import { store } from '../core/store.js';
import { setTool } from '../core/tools.js';
import { h, section, slider, toggle, segmented, colorSwatches, button, hint } from '../core/ui.js';
import { icon } from '../core/icons.js';
import { createTextLayer, drawLayer, layerSize, layerScale } from '../layers/render-layers.js';
import { selectedLayer, selectLayer, updateLayer, addLayer, placementPoint, kindName } from '../tools/layer-tool.js';
import { layerList } from './text/layer-list.js';
import { fontPicker, pickFont, stackFor, familyOf } from './text/fonts.js';

// ---------------------------------------------------------------- palettes
export const TEXT_COLORS = [
  { value: '#ffffff', name: '白色' }, { value: '#1d2129', name: '黑色' }, { value: '#e8383d', name: '红色' },
  { value: '#ff8a1f', name: '橙色' }, { value: '#ffd83b', name: '黄色' }, { value: '#2fa36b', name: '绿色' },
  { value: '#18a8e8', name: '天蓝' }, { value: '#3464f0', name: '蓝色' }, { value: '#8e5cf7', name: '紫色' },
  { value: '#ff5c93', name: '粉色' },
];
const STROKE_COLORS = [
  { value: '#1d2129', name: '黑色' }, { value: '#ffffff', name: '白色' }, { value: '#e8383d', name: '红色' },
  { value: '#ff8a1f', name: '橙色' }, { value: '#ffd83b', name: '黄色' }, { value: '#3464f0', name: '蓝色' },
  { value: '#6b3d00', name: '棕色' },
];
const SHADOW_COLORS = [
  { value: '#000000', name: '黑色' }, { value: '#5b6270', name: '灰色' }, { value: '#ffffff', name: '白色（发光）' },
  { value: '#18a8ff', name: '蓝色（霓虹）' }, { value: '#ff5c93', name: '粉色' }, { value: '#ffd83b', name: '金色' },
];
const BG_COLORS = [
  { value: '#111111', name: '黑色' }, { value: '#ffffff', name: '白色' }, { value: '#e8383d', name: '红色' },
  { value: '#ff8a1f', name: '橙色' }, { value: '#ffd83b', name: '黄色' }, { value: '#2fa36b', name: '绿色' },
  { value: '#3464f0', name: '蓝色' }, { value: '#ff5c93', name: '粉色' },
];

// ---------------------------------------------------------------- 花字 presets
const OFF = { on: false };
export const PRESETS = [
  { id: 'title', name: '标题黄字', fonts: ['SimHei'], style: {
    color: '#ffd83b', bold: true, italic: false, letterSpacing: 2, gradient: OFF,
    stroke: { on: true, width: 7, color: '#1d1d1f' }, shadow: { on: true, color: '#1d1d1f', opacity: 1, blur: 0, dx: 0, dy: 7 }, bg: OFF } },
  { id: 'cute', name: '可爱粉', fonts: ['YouYuan'], style: {
    color: '#ff5c93', bold: true, italic: false, letterSpacing: 2, gradient: OFF,
    stroke: { on: true, width: 9, color: '#ffffff' }, shadow: { on: true, color: '#ff5c93', opacity: 0.4, blur: 16, dx: 0, dy: 4 }, bg: OFF } },
  { id: 'notice', name: '通知红底', fonts: ['Microsoft YaHei'], style: {
    color: '#ffffff', bold: true, italic: false, letterSpacing: 4, gradient: OFF,
    stroke: { on: false, width: 6, color: '#1d2129' }, shadow: { on: true, color: '#7a0f12', opacity: 0.3, blur: 14, dx: 0, dy: 5 },
    bg: { on: true, color: '#e8383d', opacity: 1, padding: 24, radius: 14, border: 0 } } },
  { id: 'fresh', name: '清新绿', fonts: ['YouYuan'], style: {
    color: '#27a567', bold: true, italic: false, letterSpacing: 2, gradient: OFF,
    stroke: { on: true, width: 8, color: '#ffffff' }, shadow: { on: true, color: '#0b5d3b', opacity: 0.3, blur: 16, dx: 0, dy: 5 }, bg: OFF } },
  { id: 'gold', name: '金色描边', fonts: ['STXinwei', 'LiSu', 'KaiTi'], style: {
    color: '#fff4b8', bold: true, italic: false, letterSpacing: 2, gradient: { on: true, color2: '#e0a21b' },
    stroke: { on: true, width: 6, color: '#6b3d00' }, shadow: { on: true, color: '#000000', opacity: 0.4, blur: 10, dx: 0, dy: 4 }, bg: OFF } },
  { id: 'hand', name: '手写楷体', fonts: ['KaiTi', 'STXingkai'], style: {
    color: '#ffffff', bold: false, italic: false, letterSpacing: 2, gradient: OFF,
    stroke: { on: false, width: 6, color: '#1d2129' }, shadow: { on: true, color: '#000000', opacity: 0.6, blur: 12, dx: 0, dy: 3 }, bg: OFF } },
  { id: 'label', name: '黑底标签', fonts: ['Microsoft YaHei'], style: {
    color: '#ffffff', bold: false, italic: false, letterSpacing: 6, gradient: OFF,
    stroke: { on: false, width: 6, color: '#1d2129' }, shadow: OFF,
    bg: { on: true, color: '#111111', opacity: 0.78, padding: 16, radius: 8, border: 0 } } },
  { id: 'bubble', name: '描边气泡', fonts: ['YouYuan'], style: {
    color: '#333a45', bold: true, italic: false, letterSpacing: 2, gradient: OFF,
    stroke: { on: false, width: 6, color: '#1d2129' }, shadow: { on: true, color: '#000000', opacity: 0.22, blur: 16, dx: 0, dy: 6 },
    bg: { on: true, color: '#ffffff', opacity: 1, padding: 22, radius: 999, border: 5 } } },
  { id: 'neon', name: '霓虹蓝', fonts: ['Microsoft YaHei'], style: {
    color: '#ffffff', bold: true, italic: false, letterSpacing: 3, gradient: OFF,
    stroke: { on: true, width: 3, color: '#3ec5ff' }, shadow: { on: true, color: '#18a8ff', opacity: 1, blur: 26, dx: 0, dy: 0 }, bg: OFF } },
];

/** Applies a preset's style to a text layer object in place (lengths are relative to fontSize 100). */
export function applyPreset(L, p) {
  const f = (L.fontSize || 100) / 100;
  const s = p.style;
  const merge = (base, v, keys) => {
    const o = { ...(base || {}), ...(v || {}) };
    for (const k of keys) if (typeof o[k] === 'number' && v && k in v) o[k] = v[k] * f;
    return o;
  };
  L.color = s.color;
  L.bold = !!s.bold;
  L.italic = !!s.italic;
  L.letterSpacing = (s.letterSpacing || 0) * f;
  L.gradient = { color2: L.gradient?.color2 || '#ffb300', ...(s.gradient || {}), on: !!s.gradient?.on };
  L.stroke = merge(L.stroke, s.stroke, ['width']);
  L.stroke.on = !!s.stroke?.on;
  L.shadow = merge(L.shadow, s.shadow, ['blur', 'dx', 'dy']);
  L.shadow.on = !!s.shadow?.on;
  L.bg = merge(L.bg, s.bg, ['padding', 'radius', 'border']);
  L.bg.on = !!s.bg?.on;
  L.fontFamily = stackFor(pickFont(p.fonts));
  L.preset = p.id;
  return L;
}

// ---------------------------------------------------------------- preset chips (drawn with the real renderer)
const chipCache = new Map();
function presetChip(p) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const key = `${p.id}@${dpr}`;
  if (chipCache.has(key)) return chipCache.get(key);
  const W = 76, H = 44;
  const c = document.createElement('canvas');
  c.width = W * dpr; c.height = H * dpr;
  const ctx = c.getContext('2d');
  const L = applyPreset(createTextLayer({ text: p.name.length > 4 ? p.name.slice(0, 4) : p.name }), p);
  const { w, h } = layerSize(L);
  const k = Math.min((W - 10) / w, (H - 8) / h);
  L.scale = k * dpr;
  L.x = (W * dpr) / 2; L.y = (H * dpr) / 2;
  drawLayer(ctx, L, 1);
  const url = c.toDataURL('image/png');
  chipCache.set(key, url);
  return url;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

registerPanel({
  id: 'text',
  title: '文字',
  icon: icon('text', 22),
  order: 70,
  tip: '在图片上加文字',
  mount(el, ctx) {
    setTool('layer');
    const doc = store.doc;
    const long = Math.max(doc.width, doc.height);
    let composing = false;

    // ---------------------------------------------------------- 添加文字
    const addBtn = button({ text: '添加文字', icon: 'plus', primary: true, size: 'lg', block: true, className: 'text-add', onClick: () => addText() });
    const secAdd = section('添加文字');
    secAdd.append(addBtn, hint('拖动文字可以移动，拖四个角缩放，拖上方的圆点旋转；双击文字直接改字'));

    // ---------------------------------------------------------- 花字
    const presetGrid = h('div', { class: 'text-presets' });
    const chips = [];
    for (const p of PRESETS) {
      const b = h('button', { type: 'button', class: 'text-preset', 'data-tip': p.name, 'aria-label': `花字：${p.name}`, onclick: () => usePreset(p) },
        h('img', { src: presetChip(p), alt: '' }));
      b._p = p; chips.push(b); presetGrid.append(b);
    }
    const presetHint = h('div', { class: 'sec-hint' });
    const secPresets = section('花字样式');
    secPresets.append(presetHint, presetGrid);

    // ---------------------------------------------------------- editor
    const ta = h('textarea', { class: 'text-input text-area', rows: 2, placeholder: '在这里输入文字，回车换行', 'aria-label': '文字内容', spellcheck: 'false' });
    ta.addEventListener('compositionstart', () => { composing = true; });
    ta.addEventListener('compositionend', () => { composing = false; commitText(); });
    ta.addEventListener('input', (e) => { autoGrow(); if (!composing && !e.isComposing) commitText(); });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); ta.blur(); }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) e.preventDefault(); // not the browser's bookmark dialog
    });
    function autoGrow() { ta.style.height = 'auto'; ta.style.height = `${clamp(ta.scrollHeight + 2, 60, 168)}px`; }
    function commitText() {
      const L = sel();
      if (!L || L.text === ta.value) return;
      const v = ta.value;
      updateLayer(L.id, '修改文字', (x) => { x.text = v; }, `text.content.${L.id}`);
    }

    const font = fontPicker({ onChange: (fam) => set('字体', 'font', (L) => { L.fontFamily = stackFor(fam); L.preset = null; }) });
    const sizeMax = Math.max(60, Math.round(long * 0.6));
    const size = slider({ label: '字号', min: 8, max: sizeMax, step: 1, unit: 'px',
      onInput: (v) => set('字号', 'size', (L) => { L.scale = v / (L.fontSize || 100); }, true) });
    const colors = colorSwatches({ colors: TEXT_COLORS, onChange: (v) => set('文字颜色', 'color', (L) => { L.color = v; L.preset = null; }),
      onInput: (v) => set('文字颜色', 'color', (L) => { L.color = v; L.preset = null; }, true) });
    const gradOn = toggle({ label: '渐变色', hint: '从上面的颜色过渡到下面选的颜色', onChange: (v) => set(v ? '渐变色' : '去掉渐变', 'grad', (L) => { L.gradient = { color2: '#ffb300', ...(L.gradient || {}), on: v }; L.preset = null; }) });
    const grad2 = colorSwatches({ colors: TEXT_COLORS, onChange: (v) => set('渐变颜色', 'grad2', (L) => { L.gradient = { ...(L.gradient || {}), on: true, color2: v }; L.preset = null; }),
      onInput: (v) => set('渐变颜色', 'grad2', (L) => { L.gradient = { ...(L.gradient || {}), on: true, color2: v }; }, true) });
    const gradBox = h('div', { class: 'text-sub' }, grad2);

    const boldBtn = h('button', { type: 'button', class: 'text-tbtn text-b', 'data-tip': '加粗', 'aria-label': '加粗', onclick: () => set('加粗', 'bold', (L) => { L.bold = !L.bold; L.preset = null; }) }, 'B');
    const italicBtn = h('button', { type: 'button', class: 'text-tbtn text-i', 'data-tip': '倾斜', 'aria-label': '倾斜', onclick: () => set('倾斜', 'italic', (L) => { L.italic = !L.italic; }) }, 'I');
    const vertBtn = h('button', { type: 'button', class: 'text-tbtn text-v', 'data-tip': '竖排文字（从右往左一列一列排）', 'aria-label': '竖排', onclick: () => set('竖排', 'vertical', (L) => { L.vertical = !L.vertical; }) }, '竖排');
    const alignH = [
      { value: 'left', label: '', icon: 'textAlignLeft', tip: '左对齐' },
      { value: 'center', label: '', icon: 'textAlignCenter', tip: '居中' },
      { value: 'right', label: '', icon: 'textAlignRight', tip: '右对齐' },
    ];
    const alignV = [
      { value: 'left', label: '', icon: 'textAlignTop', tip: '顶端对齐' },
      { value: 'center', label: '', icon: 'textAlignMiddle', tip: '居中' },
      { value: 'right', label: '', icon: 'textAlignBottom', tip: '底端对齐' },
    ];
    let alignSeg = null, alignVertical = null;
    const alignWrap = h('div', { class: 'text-align-wrap' });
    function buildAlign(vertical) {
      if (alignSeg && alignVertical === vertical) return;
      alignVertical = vertical;
      alignSeg = segmented({ size: 'sm', className: 'text-align', value: 'center', options: vertical ? alignV : alignH,
        onChange: (v) => set('对齐方式', 'align', (L) => { L.align = v; }) });
      alignWrap.replaceChildren(alignSeg);
    }
    buildAlign(false);
    const styleRow = h('div', { class: 'text-style-row' }, h('div', { class: 'text-tbtns' }, boldBtn, italicBtn, vertBtn), alignWrap);

    const spacing = slider({ label: '字间距', min: -10, max: 80, step: 1, unit: '%', defaultValue: 0,
      onInput: (v) => set('字间距', 'ls', (L) => { L.letterSpacing = (v / 100) * (L.fontSize || 100); }, true) });
    const lineH = slider({ label: '行距', min: 80, max: 250, step: 5, unit: '%', defaultValue: 125,
      onInput: (v) => set('行距', 'lh', (L) => { L.lineHeight = v / 100; }, true) });
    const opacity = slider({ label: '不透明度', min: 0, max: 100, step: 1, unit: '%', defaultValue: 100,
      onInput: (v) => set('不透明度', 'opacity', (L) => { L.opacity = v / 100; }, true) });

    const secEdit = section('编辑文字');
    const editBody = h('div', { class: 'text-edit-body' },
      ta,
      h('div', { class: 'field-label mt' }, '字体'), font,
      size,
      h('div', { class: 'field-label' }, '颜色'), colors, gradOn, gradBox,
      h('div', { class: 'field-label mt' }, '样式'), styleRow,
      spacing, lineH, opacity);
    const emptyCard = h('div', { class: 'text-empty' },
      h('span', { class: 'te-ico', html: icon('text', 22) }),
      h('div', { class: 'te-title' }, '还没有选中文字'),
      h('div', { class: 'te-text' }, '点上面的「添加文字」，或者点一下图片上已有的文字，就能在这里修改'));
    const otherCard = h('div', { class: 'text-empty other' });
    secEdit.append(editBody, emptyCard, otherCard);

    // ---------------------------------------------------------- effects
    const f = () => (sel()?.fontSize || 100) / 100; // lengths shown as % of the font size
    const strokeOn = toggle({ label: '描边', hint: '给文字加一圈边，在花哨的背景上也看得清', onChange: (v) => set(v ? '添加描边' : '去掉描边', 'strokeOn', (L) => { const o = L.stroke || {}; L.stroke = { ...o, color: o.color || '#1d2129', width: o.width > 0 ? o.width : 6 * f(), on: v }; L.preset = null; }) });
    const strokeW = slider({ label: '粗细', min: 1, max: 30, step: 1, defaultValue: 6,
      onInput: (v) => set('描边粗细', 'strokeW', (L) => { L.stroke = { ...L.stroke, on: true, width: v * f() }; L.preset = null; }, true) });
    const strokeC = colorSwatches({ colors: STROKE_COLORS, onChange: (v) => set('描边颜色', 'strokeC', (L) => { L.stroke = { ...L.stroke, on: true, color: v }; L.preset = null; }),
      onInput: (v) => set('描边颜色', 'strokeC', (L) => { L.stroke = { ...L.stroke, on: true, color: v }; }, true) });
    const strokeBox = h('div', { class: 'text-sub' }, strokeW, h('div', { class: 'field-label' }, '描边颜色'), strokeC);

    const shadowOn = toggle({ label: '阴影', hint: '让文字浮起来，更有立体感', onChange: (v) => set(v ? '添加阴影' : '去掉阴影', 'shadowOn', (L) => {
      const o = L.shadow || {};
      const visible = (o.blur || 0) > 0 || o.dx || o.dy;
      L.shadow = { color: '#000000', opacity: 0.45, ...o, ...(visible ? {} : { blur: 12 * f(), dx: 0, dy: 5 * f() }), on: v };
      if (!(L.shadow.opacity > 0)) L.shadow.opacity = 0.45;
      L.preset = null;
    }) });
    const shBlur = slider({ label: '柔和', min: 0, max: 60, step: 1, defaultValue: 12,
      onInput: (v) => set('阴影柔和', 'shBlur', (L) => { L.shadow = { ...L.shadow, on: true, blur: v * f() }; L.preset = null; }, true) });
    const shDx = slider({ label: '左右', min: -40, max: 40, step: 1, defaultValue: 0,
      onInput: (v) => set('阴影位置', 'shDx', (L) => { L.shadow = { ...L.shadow, on: true, dx: v * f() }; L.preset = null; }, true) });
    const shDy = slider({ label: '上下', min: -40, max: 40, step: 1, defaultValue: 5,
      onInput: (v) => set('阴影位置', 'shDy', (L) => { L.shadow = { ...L.shadow, on: true, dy: v * f() }; L.preset = null; }, true) });
    const shOp = slider({ label: '浓度', min: 0, max: 100, step: 1, unit: '%', defaultValue: 45,
      onInput: (v) => set('阴影浓度', 'shOp', (L) => { L.shadow = { ...L.shadow, on: true, opacity: v / 100, color: /^#/.test(L.shadow?.color) ? L.shadow.color : '#000000' }; L.preset = null; }, true) });
    const shC = colorSwatches({ colors: SHADOW_COLORS, onChange: (v) => set('阴影颜色', 'shC', (L) => { L.shadow = { ...L.shadow, on: true, color: v }; L.preset = null; }),
      onInput: (v) => set('阴影颜色', 'shC', (L) => { L.shadow = { ...L.shadow, on: true, color: v }; }, true) });
    const shadowBox = h('div', { class: 'text-sub' }, shBlur, shDx, shDy, shOp, h('div', { class: 'field-label' }, '阴影颜色'), shC);

    const bgOn = toggle({ label: '背景框', hint: '文字下面垫一块底色，像标签一样', onChange: (v) => set(v ? '添加背景框' : '去掉背景框', 'bgOn', (L) => {
      const o = L.bg || {};
      L.bg = { color: '#000000', padding: 18 * f(), radius: 14 * f(), border: 0, ...o, opacity: o.opacity > 0 ? o.opacity : 0.6, on: v };
      L.preset = null;
    }) });
    const bgC = colorSwatches({ colors: BG_COLORS, onChange: (v) => set('背景框颜色', 'bgC', (L) => { L.bg = { ...L.bg, on: true, color: v }; L.preset = null; }),
      onInput: (v) => set('背景框颜色', 'bgC', (L) => { L.bg = { ...L.bg, on: true, color: v }; }, true) });
    const bgOp = slider({ label: '不透明度', min: 0, max: 100, step: 1, unit: '%', defaultValue: 60,
      onInput: (v) => set('背景框不透明度', 'bgOp', (L) => { L.bg = { ...L.bg, on: true, opacity: v / 100 }; L.preset = null; }, true) });
    const bgR = slider({ label: '圆角', min: 0, max: 100, step: 1, defaultValue: 14,
      onInput: (v) => set('背景框圆角', 'bgR', (L) => { L.bg = { ...L.bg, on: true, radius: v * f() }; L.preset = null; }, true) });
    const bgPad = slider({ label: '留白', min: 0, max: 80, step: 1, defaultValue: 18,
      onInput: (v) => set('背景框留白', 'bgPad', (L) => { L.bg = { ...L.bg, on: true, padding: v * f() }; L.preset = null; }, true) });
    const bgBorder = slider({ label: '边框', min: 0, max: 16, step: 1, defaultValue: 0, hint: '边框颜色跟文字颜色一样',
      onInput: (v) => set('背景框边框', 'bgBorder', (L) => { L.bg = { ...L.bg, on: true, border: v * f() }; L.preset = null; }, true) });
    const bgBox = h('div', { class: 'text-sub' }, h('div', { class: 'field-label' }, '底色'), bgC, bgOp, bgR, bgPad, bgBorder);

    const secFx = section('文字效果');
    secFx.append(strokeOn, strokeBox, shadowOn, shadowBox, bgOn, bgBox);

    // ---------------------------------------------------------- layers
    const secLayers = layerList(ctx);

    el.append(secAdd, secPresets, secEdit, secFx, secLayers);

    // ---------------------------------------------------------- actions
    function sel() { const L = selectedLayer(); return L && L.type === 'text' ? L : null; }
    function set(label, field, fn, coalesce) {
      const L = sel();
      if (!L) return;
      updateLayer(L.id, label, fn, coalesce ? `text.${field}.${L.id}` : null);
    }
    function newTextLayer(props = {}) {
      const d = store.doc;
      const p = placementPoint();
      const px = clamp(Math.round(Math.min(d.width, d.height) * 0.08), 14, 1200);
      const L = createTextLayer({ x: p.x, y: p.y, scale: px / 100, ...props });
      // keep the new text inside the picture
      const { w } = layerSize(L);
      if (w * L.scale > d.width * 0.9) L.scale = (d.width * 0.9) / w;
      return L;
    }
    function addText(preset) {
      const L = newTextLayer();
      if (preset) applyPreset(L, preset);
      addLayer(L, preset ? `添加花字：${preset.name}` : '添加文字');
      focusText(L.id, true);
    }
    function usePreset(p) {
      const L = sel();
      if (L) updateLayer(L.id, `花字：${p.name}`, (x) => applyPreset(x, p));
      else addText(p);
    }
    function focusText(id, selectAll) {
      if (id && store.ui.selectedLayerId !== id) selectLayer(id);
      sync();
      requestAnimationFrame(() => {
        if (!sel()) return;
        ta.focus({ preventScroll: true });
        if (selectAll) ta.select(); else ta.setSelectionRange(ta.value.length, ta.value.length);
        const body = el.closest('.panel-body') || el;
        const r = ta.getBoundingClientRect(), br = body.getBoundingClientRect();
        if (r.top < br.top + 8 || r.bottom > br.bottom - 8) body.scrollTop += r.top - br.top - 60;
      });
    }

    // ---------------------------------------------------------- sync
    function sync() {
      const d = store.doc;
      if (!d) return;
      const any = selectedLayer();
      const L = sel();
      editBody.hidden = !L;
      secFx.hidden = !L;
      emptyCard.hidden = !!L || !!any;
      otherCard.hidden = !any || !!L;
      presetHint.textContent = L ? '点一下，选中的文字就换成这个样式' : '点一下就加一段这种样式的文字';
      if (any && !L) {
        otherCard.replaceChildren(
          h('span', { class: 'te-ico', html: icon('sticker', 22) }),
          h('div', { class: 'te-title' }, `选中的是${kindName(any)}`),
          h('div', { class: 'te-text' }, '可以直接在图上拖动、缩放、旋转。要改透明度或翻转，请到「贴纸」里调整'),
          button({ text: '去贴纸面板', icon: 'sticker', variant: 'secondary', size: 'sm', onClick: () => ctx.panels.showPanel('sticker') }));
      }
      for (const b of chips) b.classList.toggle('on', !!L && L.preset === b._p.id);
      if (!L) return;
      if (!composing && ta.value !== L.text) ta.value = L.text; // (typing commits first, so this only fires on undo / selection)
      autoGrow();
      font.setValue(familyOf(L.fontFamily));
      size.setValue(Math.round((L.fontSize || 100) * layerScale(L).sx));
      colors.setValue(L.color);
      gradOn.setValue(!!L.gradient?.on);
      gradBox.hidden = !L.gradient?.on;
      grad2.setValue(L.gradient?.color2 || '');
      boldBtn.classList.toggle('on', !!L.bold); boldBtn.setAttribute('aria-pressed', L.bold ? 'true' : 'false');
      italicBtn.classList.toggle('on', !!L.italic); italicBtn.setAttribute('aria-pressed', L.italic ? 'true' : 'false');
      vertBtn.classList.toggle('on', !!L.vertical); vertBtn.setAttribute('aria-pressed', L.vertical ? 'true' : 'false');
      buildAlign(!!L.vertical);
      alignSeg.setValue(L.align || 'center');
      const k = (L.fontSize || 100) / 100;
      spacing.setValue(Math.round((L.letterSpacing || 0) / k));
      lineH.setValue(Math.round((L.lineHeight || 1.25) * 100));
      opacity.setValue(Math.round((L.opacity ?? 1) * 100));
      strokeOn.setValue(!!L.stroke?.on);
      strokeBox.hidden = !L.stroke?.on;
      strokeW.setValue(Math.round((L.stroke?.width ?? 6) / k));
      strokeC.setValue(L.stroke?.color || '');
      shadowOn.setValue(!!L.shadow?.on);
      shadowBox.hidden = !L.shadow?.on;
      shBlur.setValue(Math.round((L.shadow?.blur ?? 12) / k));
      shDx.setValue(Math.round((L.shadow?.dx ?? 0) / k));
      shDy.setValue(Math.round((L.shadow?.dy ?? 5) / k));
      shOp.setValue(Math.round((L.shadow?.opacity ?? 1) * 100));
      shC.setValue(/^#/.test(L.shadow?.color || '') ? L.shadow.color : '#000000');
      bgOn.setValue(!!L.bg?.on);
      bgBox.hidden = !L.bg?.on;
      bgC.setValue(L.bg?.color || '');
      bgOp.setValue(Math.round((L.bg?.opacity ?? 0.6) * 100));
      bgR.setValue(Math.round((L.bg?.radius ?? 14) / k));
      bgPad.setValue(Math.round((L.bg?.padding ?? 18) / k));
      bgBorder.setValue(Math.round((L.bg?.border ?? 0) / k));
    }
    ctx.on('doc:changed', (p) => { if (p?.reason !== 'bump') sync(); });
    ctx.on('layer:selected', () => sync());
    ctx.on('layer:edit', (p) => focusText(p?.id, true));
    ctx.onDispose(() => {
      font.close();
      if (store.ui.panel !== 'text' && store.ui.panel !== 'sticker') selectLayer(null);
    });
    sync();
    if (store.ui.textEditPending) {
      const id = store.ui.textEditPending;
      store.ui.textEditPending = null;
      focusText(id, true);
    }
    void secLayers;
  },
});
