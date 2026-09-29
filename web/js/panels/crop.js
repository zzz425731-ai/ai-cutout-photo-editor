// panels/crop.js — 裁剪: 比例裁剪框, 左转/右转 90°, 水平/垂直翻转, 拉直, 调整尺寸.
// Everything is a pending preview (tools/crop-tool.js) until 「应用」 (Enter), which is ONE undo step;
// 「取消」 (Esc) or leaving the panel discards it.

import { registerPanel } from '../core/panels.js';
import { setTool } from '../core/tools.js';
import { h, section, slider, button } from '../core/ui.js';
import { icon, ICONS } from '../core/icons.js';
import * as crop from '../tools/crop-tool.js';

ICONS.cropRotL = '<rect x="3.5" y="10" width="11" height="10.5" rx="1.8"/><path d="M9 6.5h5.5a5 5 0 0 1 5 5V14"/><path d="m11.5 4-2.5 2.5 2.5 2.5"/>';
ICONS.cropRotR = '<rect x="9.5" y="10" width="11" height="10.5" rx="1.8"/><path d="M15 6.5H9.5a5 5 0 0 0-5 5V14"/><path d="m12.5 4 2.5 2.5-2.5 2.5"/>';
ICONS.cropFlipH = '<path d="M12 3v18" stroke-dasharray="2 2.4"/><path d="M9 7 3.5 17H9Z"/><path d="M15 7l5.5 10H15Z" fill="currentColor" fill-opacity=".22"/>';
ICONS.cropFlipV = '<path d="M3 12h18" stroke-dasharray="2 2.4"/><path d="M7 9 17 3.5V9Z"/><path d="M7 15l10 5.5V15Z" fill="currentColor" fill-opacity=".22"/>';
ICONS.cropUnlock = '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 7.7-1.6"/>';

const SIZE_PRESETS = [{ mode: 'orig', label: '原尺寸', tip: '保持裁剪后的大小' }, ...crop.LONG_SIDES.map((v) => ({ mode: 'long', v, label: String(v), tip: `最长的一边缩放到 ${v} 像素` }))];

/** mini aspect shape inside a 24×18 box */
function shapeSize(aspect) {
  if (!(aspect > 0)) return { w: 20, h: 15 };
  return aspect >= 24 / 18 ? { w: 24, h: 24 / aspect } : { w: 18 * aspect, h: 18 };
}

/** small text box for integers; commits on Enter / blur, Esc reverts */
function intInput({ label, max = crop.MAX_OUT, onCommit }) {
  const inp = h('input', { class: 'num-input crop-int', type: 'text', inputmode: 'numeric', 'aria-label': label, autocomplete: 'off' });
  let shown = '';
  inp.show = (v) => { shown = String(v); if (document.activeElement !== inp) inp.value = shown; };
  const commit = () => {
    const v = Math.round(parseFloat(String(inp.value).replace(/[^\d.]/g, '')));
    if (Number.isFinite(v) && v >= 1 && String(v) !== shown) onCommit(Math.min(max, v));
    inp.value = shown;
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); inp.blur(); }
    else if (e.key === 'Escape') { inp.value = shown; inp.blur(); }
    e.stopPropagation();
  });
  inp.addEventListener('blur', commit);
  inp.addEventListener('focus', () => inp.select());
  return inp;
}

registerPanel({
  id: 'crop',
  title: '裁剪',
  icon: icon('crop', 22),
  order: 60,
  tip: '裁剪比例、旋转、翻转、改尺寸',
  mount(el, ctx) {
    // ---------------------------------------------------------- 裁剪比例
    const chips = new Map();
    const grid = h('div', { class: 'crop-ratios', role: 'radiogroup', 'aria-label': '裁剪比例' });
    for (const R of crop.RATIOS) {
      const shape = h('span', { class: 'cr-shape' });
      const lab = h('span', { class: 'cr-label' }, R.label);
      const b = h('button', { type: 'button', class: `crop-ratio cr-${R.id.replace(':', 'x')}`, role: 'radio', 'aria-checked': 'false',
        'data-ratio': R.id, 'data-tip': R.tip, onclick: () => crop.setRatio(R.id) },
      h('span', { class: 'cr-box' }, shape), lab);
      if (R.w) { const s = shapeSize(R.w / R.h); shape.style.width = `${s.w}px`; shape.style.height = `${s.h}px`; }
      chips.set(R.id, { b, shape, lab });
      grid.append(b);
    }
    const cw = intInput({ label: '比例的宽', max: 9999, onCommit: (v) => crop.setCustomRatio(v, crop.cropState().custom[1]) });
    const chh = intInput({ label: '比例的高', max: 9999, onCommit: (v) => crop.setCustomRatio(crop.cropState().custom[0], v) });
    const customRow = h('div', { class: 'crop-custom' },
      h('span', { class: 'cc-k' }, '宽'), cw, h('span', { class: 'cc-colon' }, ':'), chh, h('span', { class: 'cc-k' }, '高'));
    const secRatio = section('裁剪比例', '拖动框的四角和边来调整，在框外拖动可以重新画框');
    secRatio.append(grid, customRow);

    // ---------------------------------------------------------- 旋转和翻转
    const tbtn = (ico, text, tip, fn) => h('button', { type: 'button', class: 'crop-tbtn', 'data-tip': tip, 'aria-label': text, onclick: fn },
      h('span', { class: 'ct-ico', html: icon(ico, 22) }), h('span', { class: 'ct-label' }, text));
    const tools = h('div', { class: 'crop-tools' },
      tbtn('cropRotL', '左转90°', '向左转 90 度（不损失画质）', () => crop.turn(-1)),
      tbtn('cropRotR', '右转90°', '向右转 90 度（不损失画质）', () => crop.turn(1)),
      tbtn('cropFlipH', '水平翻转', '左右镜像', () => crop.flip('h')),
      tbtn('cropFlipV', '垂直翻转', '上下颠倒', () => crop.flip('v')));
    const straight = slider({ label: '拉直', min: -45, max: 45, step: 0.1, unit: '°', value: 0, defaultValue: 0,
      format: (v) => (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1)),
      hint: '照片拍歪了？拖动把它摆正，四周的空白会自动裁掉',
      onInput: (v) => crop.setStraighten(v) });
    straight.classList.add('crop-straight');
    const secRotate = section('旋转和翻转');
    secRotate.append(tools, straight);

    // ---------------------------------------------------------- 调整尺寸
    const wIn = intInput({ label: '宽度', onCommit: (v) => setSize('w', v) });
    const hIn = intInput({ label: '高度', onCommit: (v) => setSize('h', v) });
    const lockBtn = h('button', { type: 'button', class: 'crop-lock', 'aria-label': '锁定比例',
      onclick: () => {
        const s = crop.cropState(), o = crop.outputSize();
        const on = !s.lock;
        if (on && s.resize.mode === 'exact') crop.setResize({ mode: 'w', v: o.w });
        if (!on && s.resize.mode !== 'orig') crop.setResize({ mode: 'exact', w: o.w, h: o.h });
        crop.setLock(on);
      } });
    const szField = (label, inp) => h('label', { class: 'crop-sz' }, h('span', { class: 'field-label' }, label), h('span', { class: 'sz-box' }, inp, h('span', { class: 'sz-u' }, 'px')));
    const sizeRow = h('div', { class: 'crop-size' }, szField('宽度', wIn), lockBtn, szField('高度', hIn));
    const presetBtns = [];
    const presets = h('div', { class: 'crop-presets' });
    for (const P of SIZE_PRESETS) {
      const b = h('button', { type: 'button', class: 'crop-preset', 'data-tip': P.tip,
        onclick: () => crop.setResize(P.mode === 'orig' ? { mode: 'orig' } : { mode: 'long', v: P.v }) }, P.label);
      b._p = P; presetBtns.push(b); presets.append(b);
    }
    const resV = h('span', { class: 'crr-v' });
    const resSub = h('span', { class: 'crr-sub' });
    const result = h('div', { class: 'crop-result' }, h('span', { class: 'crr-k' }, '最终尺寸'), h('span', { class: 'crr-right' }, resV, resSub));
    const warn = h('div', { class: 'crop-warn' });
    const secSize = section('调整尺寸', '缩小尺寸能让文件变小，发微信、传网站更方便');
    secSize.append(sizeRow, h('div', { class: 'field-label mt' }, '按长边缩放（像素）'), presets, result, warn);

    // ---------------------------------------------------------- 应用 / 取消 (sticky at the bottom)
    const status = h('div', { class: 'ca-status' });
    const cancelBtn = button({ text: '取消', variant: 'secondary', tip: '放弃这次的裁剪和旋转', key: 'Esc', onClick: () => crop.cancelCrop() });
    const applyBtn = button({ text: '应用', icon: 'check', primary: true, tip: '确认修改（可以撤销）', key: 'Enter', onClick: () => crop.applyCrop() });
    const bar = h('div', { class: 'crop-actions' }, status, h('div', { class: 'row' }, cancelBtn, applyBtn));

    el.classList.add('crop-body');
    el.append(secRatio, secRotate, secSize, bar);

    function setSize(which, v) {
      const s = crop.cropState(), o = crop.outputSize();
      if (s.lock) crop.setResize({ mode: which, v });
      else crop.setResize({ mode: 'exact', w: which === 'w' ? v : o.w, h: which === 'h' ? v : o.h });
    }

    // ---------------------------------------------------------- sync
    function sync() {
      const s = crop.cropState();
      if (!s.crop) return;
      for (const [id, c] of chips) {
        const on = id === s.ratio;
        c.b.classList.toggle('on', on);
        c.b.setAttribute('aria-checked', on ? 'true' : 'false');
      }
      const so = shapeSize(s.W2 / s.H2);
      Object.assign(chips.get('orig').shape.style, { width: `${so.w}px`, height: `${so.h}px` });
      const custom = chips.get('custom');
      const sc = shapeSize(s.custom[0] / s.custom[1]);
      Object.assign(custom.shape.style, { width: `${sc.w}px`, height: `${sc.h}px` });
      custom.lab.textContent = s.ratio === 'custom' ? `自定义 ${s.custom[0]}:${s.custom[1]}` : '自定义';
      customRow.hidden = s.ratio !== 'custom';
      cw.show(s.custom[0]); chh.show(s.custom[1]);
      if (Math.abs(straight.getValue() - s.theta) > 1e-6) straight.setValue(s.theta);

      const c = crop.cropRectInt(), o = crop.outputSize();
      wIn.show(o.w); hIn.show(o.h);
      if (lockBtn._on !== s.lock) {
        lockBtn._on = s.lock;
        lockBtn.classList.toggle('on', s.lock);
        lockBtn.innerHTML = icon(s.lock ? 'lock' : 'cropUnlock', 17);
        lockBtn.dataset.tip = s.lock ? '已锁定比例：改宽度时高度自动跟着变' : '没锁定比例：宽和高可以分别设置（图片会被拉伸）';
      }
      for (const b of presetBtns) {
        const P = b._p;
        b.classList.toggle('on', P.mode === 'orig' ? s.resize.mode === 'orig' : s.resize.mode === 'long' && s.resize.v === P.v);
      }
      resV.textContent = `${o.w} × ${o.h}`;
      resSub.textContent = o.w !== c.w || o.h !== c.h ? `裁剪后 ${c.w} × ${c.h}` : '像素';
      const warns = [];
      if (o.capped) warns.push(`最大 ${crop.MAX_OUT} 像素，已自动缩小`);
      else if (o.w > c.w * 1.01 || o.h > c.h * 1.01) warns.push('比裁剪后的尺寸大，放大后可能会变模糊');
      if (Math.abs(o.w / o.h - c.w / c.h) > 0.01 * (c.w / c.h) + 1 / Math.min(o.h, c.h)) warns.push('宽高比例和裁剪框不同，图片会被拉伸');
      const wkey = warns.join('|');
      if (warn._k !== wkey) {
        warn._k = wkey;
        warn.innerHTML = '';
        for (const t of warns) warn.append(h('div', { class: 'cw-line' }, h('span', { html: icon('alert', 14) }), h('span', {}, t)));
        warn.hidden = !warns.length;
      }

      const pending = crop.isPending();
      applyBtn.setDisabled(!pending);
      cancelBtn.setDisabled(!pending);
      bar.classList.toggle('pending', pending);
      status.textContent = pending ? `预览中：${crop.planLabel(crop.planFromState(), 5)}，点「应用」后生效` : '选择比例或拖动画面上的框开始';
    }
    ctx.on('crop:changed', sync);
    ctx.on('doc:changed', (p) => { if (p?.reason !== 'bump') sync(); });
    setTool('crop');
    sync();
  },
});
