// panels/erase.js — 消除: 消除笔 paints over passers-by / clutter / watermarks / text, AI (LaMa) fills them in.
// The brush and the /api/inpaint round trip live in tools/inpaint-brush.js; this file is the UI.

import { registerPanel } from '../core/panels.js';
import { store } from '../core/store.js';
import { setTool, currentTool } from '../core/tools.js';
import { h, section, slider, toggle, button } from '../core/ui.js';
import { icon } from '../core/icons.js';
import { hasPaint, clearPaint, runErase, isErasing } from '../tools/inpaint-brush.js';

registerPanel({
  id: 'erase',
  title: '消除',
  icon: icon('erase', 22),
  order: 90,
  tip: '涂抹去掉路人、杂物、水印',
  mount(el, ctx) {
    const { viewport } = ctx;
    if (store.ui.eraseAuto === undefined) store.ui.eraseAuto = true;

    // ---------------------------------------------------------- intro
    const intro = h('div', { class: 'er-intro' },
      h('div', { class: 'er-art', html: icon('erase', 24) }),
      h('div', { class: 'er-text' },
        h('div', { class: 'er-title' }, '涂一涂，AI 自动补好背景'),
        h('div', { class: 'er-sub' }, '涂住要去掉的路人、杂物、水印、文字，松手即可消除')));

    // ---------------------------------------------------------- 消除笔
    const size = slider({ label: '画笔大小', min: 2, max: 800, step: 1, unit: 'px', power: 2, value: store.ui.brush.size,
      onInput: (v) => { store.ui.brush.size = v; store.emit('brush:changed', store.ui.brush); showSizePreview(); } });
    const auto = toggle({ label: '松手自动消除', hint: '关掉后可以先涂好几处，再一起消除', value: store.ui.eraseAuto !== false,
      onChange: (v) => { store.ui.eraseAuto = v; store.emit('tool:changed', { id: currentTool().id }); sync(); } });
    const runBtn = button({ text: '开始消除', icon: 'wand', primary: true, size: 'lg', block: true, className: 'er-run', key: '回车',
      tip: '把涂成红色的地方消除掉', onClick: () => runErase() });
    const clearBtn = button({ text: '清除涂抹', icon: 'reset', variant: 'secondary', block: true, className: 'er-clear', key: 'Esc',
      tip: '去掉红色涂抹，不消除', onClick: () => clearPaint() });
    const status = h('div', { class: 'er-status', hidden: true });
    const secBrush = section('消除笔', '红色涂到哪里，哪里就会被消除');
    secBrush.append(size, auto, h('div', { class: 'er-actions' }, runBtn, clearBtn), status);

    // ---------------------------------------------------------- tips
    const tip = (ico, text) => h('li', {}, h('span', { class: 'er-tip-ico', html: icon(ico, 15) }), h('span', {}, text));
    const secTips = section('小技巧');
    secTips.append(h('ul', { class: 'er-tips' },
      tip('brush', '涂得比要去掉的东西稍大一圈，效果更自然'),
      tip('reset', '一次没去干净？在原处再涂一遍就好'),
      tip('keyboard', '按 [ ] 调画笔大小，按住空格拖动画布'),
      tip('undo', '消除错了按 Ctrl+Z 撤销')));

    el.append(intro, secBrush, secTips);
    setTool('inpaint-brush');

    // ---------------------------------------------------------- sync
    let sizeTimer = 0;
    function showSizePreview() {
      if (!viewport.pointer.inside) {
        viewport.pointer.sx = viewport.width / 2; viewport.pointer.sy = viewport.height / 2; viewport.pointer.inside = true;
        clearTimeout(sizeTimer);
        sizeTimer = setTimeout(() => { viewport.pointer.inside = false; viewport.requestOverlay(); }, 700);
      }
      viewport.requestOverlay();
    }
    ctx.onDispose(() => clearTimeout(sizeTimer));
    function sync() {
      const manual = store.ui.eraseAuto === false;
      const has = hasPaint();
      const busyNow = isErasing();
      runBtn.hidden = !manual;
      runBtn.setDisabled(!has || busyNow);
      clearBtn.setDisabled(!has || busyNow);
      auto.setValue(!manual);
      size.setValue(store.ui.brush.size);
    }
    ctx.on('erase:paint', () => { status.hidden = true; sync(); });
    ctx.on('erase:running', sync);
    ctx.on('erase:done', ({ ms, n } = {}) => {
      status.hidden = false;
      status.innerHTML = '';
      status.append(h('span', { class: 'er-st-ico', html: icon('success', 16) }),
        h('span', {}, n > 1 ? `已消除 ${n} 处` : '已消除'),
        h('span', { class: 'er-st-meta' }, `${((ms || 0) / 1000).toFixed(1)} 秒`));
      sync();
    });
    ctx.on('doc:changed', (p) => { if (p?.reason !== 'bump') { if (p?.reason === 'undo' || p?.reason === 'redo') status.hidden = true; sync(); } });
    ctx.on('brush:changed', () => size.setValue(store.ui.brush.size));
    sync();
  },
});
