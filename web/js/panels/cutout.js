// panels/cutout.js — 抠图: 一键抠图 (通用 / 人像发丝), 边缘, 去色边, 手动修补, 恢复AI结果, 取消抠图.

import { registerPanel, showPanel } from '../core/panels.js';
import { store } from '../core/store.js';
import { setTool, currentTool } from '../core/tools.js';
import { h, section, slider, toggle, segmented, button, hint } from '../core/ui.js';
import { icon } from '../core/icons.js';
import { runCutout, cancelCutout, restoreAI, setDecontam, isCutoutRunning } from '../core/actions.js';
import '../tools/mask-brush.js';

const MODE_HINT = {
  general: '适合物品、动物、商品、风景里的主体',
  portrait: '适合人像照片，头发丝抠得更细腻',
};

registerPanel({
  id: 'cutout',
  title: '抠图',
  icon: 'cutout',
  order: 10,
  tip: '一键抠出主体，去掉背景',
  mount(el, ctx) {
    const { viewport } = ctx;

    // ---------------------------------------------------------- AI 抠图
    const modeHint = hint(MODE_HINT[store.ui.cutoutMode] || MODE_HINT.general);
    const mode = segmented({
      block: true,
      value: store.ui.cutoutMode || 'general',
      options: [
        { value: 'general', label: '通用', icon: 'cube', tip: '物品、动物、商品等' },
        { value: 'portrait', label: '人像发丝', icon: 'person', tip: '人像照片，头发更细腻' },
      ],
      onChange: (v) => { store.ui.cutoutMode = v; modeHint.textContent = MODE_HINT[v]; },
    });
    const runBtn = button({ text: '一键抠图', icon: 'wand', primary: true, size: 'lg', block: true, className: 'cut-run',
      onClick: () => runCutout({ mode: store.ui.cutoutMode }) });
    const rerunBtn = button({ text: '重新抠图', icon: 'reset', variant: 'secondary', block: true, className: 'cut-rerun',
      tip: '用上面选择的模式重新识别（会替换当前的修补结果，可撤销）',
      onClick: () => runCutout({ mode: store.ui.cutoutMode, label: '重新抠图' }) });
    const status = h('div', { class: 'cut-status' });
    const intro = h('div', { class: 'cut-intro' },
      h('div', { class: 'ci-art', html: icon('sparkles', 26) }),
      h('div', { class: 'ci-text' },
        h('div', { class: 'ci-title' }, 'AI 自动识别主体'),
        h('div', { class: 'ci-sub' }, '一键去掉背景，抠好后可以换背景、做证件照')));
    const firstRun = hint('第一次抠图要加载 AI 模型，会多等几秒');
    const secAI = section('AI 抠图');
    secAI.append(intro, h('div', { class: 'field-label' }, '选择模式'), mode, modeHint, h('div', { class: 'cut-run-wrap' }, runBtn, rerunBtn), status, firstRun);

    // ---------------------------------------------------------- 边缘
    const feather = slider({ label: '羽化', min: 0, max: 30, step: 0.5, unit: 'px', defaultValue: 0, value: store.doc.edge.feather,
      onInput: (v) => store.commit('边缘羽化', (d) => { d.edge.feather = v; }, { coalesce: 'edge.feather' }) });
    const shift = slider({ label: '收缩 / 扩展', min: -15, max: 15, step: 0.25, unit: 'px', defaultValue: 0, value: store.doc.edge.shift,
      format: (v) => (v > 0 ? `+${v}` : `${v}`),
      onInput: (v) => store.commit('边缘收缩/扩展', (d) => { d.edge.shift = v; }, { coalesce: 'edge.shift' }) });
    const decontam = toggle({ label: '去色边', hint: '去掉发丝边缘残留的旧背景颜色', value: !!store.doc.fg, onChange: (v) => setDecontam(v) });
    const secEdge = section('边缘精修', '发丝建议少羽化；有一圈杂边时，先试着收缩 0.25–0.75 px');
    const resetEdge = button({ text: '重置边缘', variant: 'secondary', size: 'sm',
      tip: '只重置羽化和收缩，保留画笔修补',
      onClick: () => store.commit('重置边缘', (d) => { d.edge = { feather: 0, shift: 0 }; }) });
    secEdge.append(feather, shift, decontam, resetEdge);

    // ---------------------------------------------------------- 检查发丝和杂边（仅预览）
    const checkHint = hint('黑底看白边，白底看暗边；蒙版中白色保留、黑色去除、灰色半透明。');
    const inspection = segmented({ block: true, className: 'cut-inspection', value: viewport.inspection || 'result',
      options: [
        { value: 'result', label: '成品', tip: '显示实际背景和效果' },
        { value: 'black', label: '黑底', tip: '检查浅色残边' },
        { value: 'white', label: '白底', tip: '检查暗边和漏抠' },
        { value: 'green', label: '绿底', tip: '高对比检查发丝空隙' },
        { value: 'alpha', label: '蒙版', tip: '查看透明度，不改变抠图结果' },
      ], onChange: (v) => viewport.setInspection(v) });
    const secCheck = section('检查边缘', '检查底色只用于预览，不会存进图片');
    secCheck.append(inspection, checkHint, h('div', { class: 'row cut-zoom' },
      button({ text: '100% 看细节', variant: 'secondary', size: 'sm', onClick: () => viewport.setZoom(1) }),
      button({ text: '适应画布', variant: 'secondary', size: 'sm', onClick: () => viewport.fit() })));
    ctx.onDispose(() => {
      if (sizeTimer) { clearTimeout(sizeTimer); viewport.pointer.inside = false; viewport.requestOverlay(); }
      viewport.setInspection(null);
    });

    // ---------------------------------------------------------- 手动修补
    const brushMode = segmented({
      block: true, className: 'brush-seg', value: null,
      options: [
        { value: 'keep', label: '保留', icon: 'brush', tip: '涂抹被误删、需要留下的部分', key: 'X 切换' },
        { value: 'erase', label: '擦除', icon: 'eraser', tip: '涂抹多余、需要去掉的部分', key: 'X 切换' },
      ],
      onChange: (v) => setTool('mask-brush', { mode: v }),
      onReselect: () => setTool('pan'),
    });
    // power 2: fine control for small brushes, still reaches 800 px (the [ ] keys' range) for 4096-px photos
    const size = slider({ label: '画笔大小', min: 2, max: 800, step: 1, unit: 'px', power: 2, value: store.ui.brush.size,
      onInput: (v) => { store.ui.brush.size = v; store.emit('brush:changed', store.ui.brush); showSizePreview(); } });
    const hard = slider({ label: '硬度', min: 0, max: 100, step: 1, unit: '%', value: Math.round(store.ui.brush.hardness * 100), defaultValue: 70,
      onInput: (v) => { store.ui.brush.hardness = v / 100; viewport.requestOverlay(); } });
    const showMask = toggle({ label: '显示蒙版', hint: '修补时用红色标出被去掉的部分', value: store.ui.showMask,
      onChange: (v) => { store.ui.showMask = v; viewport.requestRender(); } });
    const doneBtn = button({ text: '完成修补', icon: 'check', variant: 'secondary', size: 'sm', className: 'brush-done', onClick: () => setTool('pan') });
    const secBrush = section('手动修补', 'AI 没抠干净的地方，用画笔涂一涂', { right: doneBtn });
    secBrush.append(brushMode, size, hard, showMask);

    // ---------------------------------------------------------- 恢复 / 取消
    const secReset = section('');
    secReset.classList.add('cut-reset');
    secReset.querySelector('.sec-h').remove();
    const restoreBtn = button({ text: '恢复AI结果', icon: 'reset', variant: 'secondary', tip: '撤掉所有手动修补和边缘调整', onClick: () => restoreAI() });
    secReset.append(h('div', { class: 'row' },
      restoreBtn,
      button({ text: '取消抠图', icon: 'close', variant: 'danger', tip: '回到原图（可以撤销）', onClick: () => cancelCutout() })));

    // ---------------------------------------------------------- next step
    const next = h('button', { type: 'button', class: 'next-card', onclick: () => showPanel('background') },
      h('span', { class: 'nc-ico', html: icon('background', 20) }),
      h('span', { class: 'nc-text' }, h('span', { class: 'nc-title' }, '下一步：换个背景'), h('span', { class: 'nc-sub' }, '纯色、渐变、图片、虚化，还能加阴影和描边')),
      h('span', { class: 'nc-arrow', html: icon('chevronRight', 18) }));

    el.append(secAI, secCheck, secEdge, secBrush, next, secReset);

    // ---------------------------------------------------------- sync
    let sizeTimer = 0;
    function showSizePreview() {
      // brief size preview in the middle of the stage while dragging the size slider
      if (!viewport.pointer.inside) {
        viewport.pointer.sx = viewport.width / 2; viewport.pointer.sy = viewport.height / 2; viewport.pointer.inside = true;
        clearTimeout(sizeTimer);
        sizeTimer = setTimeout(() => { sizeTimer = 0; viewport.pointer.inside = false; viewport.requestOverlay(); }, 700);
      }
      viewport.requestOverlay();
    }
    function sync() {
      const d = store.doc;
      if (!d) return;
      const cut = !!(d.cutout && d.mask);
      el.classList.toggle('is-cut', cut);
      runBtn.hidden = cut;
      rerunBtn.hidden = !cut;
      firstRun.hidden = cut || !!store.ui.lastMatte;
      intro.hidden = cut;
      secEdge.hidden = !cut;
      secCheck.hidden = !cut;
      if (!cut && viewport.inspection) viewport.setInspection(null);
      secBrush.hidden = !cut;
      secReset.hidden = !cut;
      next.hidden = !cut;
      feather.setValue(d.edge.feather);
      shift.setValue(d.edge.shift);
      resetEdge.setDisabled(!d.edge.shift && !d.edge.feather);
      decontam.setValue(!!d.fg);
      const running = isCutoutRunning();
      runBtn.setDisabled(running); rerunBtn.setDisabled(running);
      // AI info travels with the AI mask (per image, survives undo); a PNG opened with transparency has none
      const lm = d.maskAI?.__matte || null;
      status.hidden = !cut;
      status.innerHTML = '';
      if (cut) {
        status.append(h('span', { class: 'cs-ico', html: icon('success', 16) }),
          h('span', {}, lm ? '已抠出主体' : '图片自带透明背景'));
        if (lm) status.append(h('span', { class: 'cs-meta' }, `${lm.mode === 'portrait' ? '人像发丝' : '通用'} · ${((lm.ms || 0) / 1000).toFixed(1)} 秒`));
      }
      restoreBtn.setText(lm || !d.maskAI ? '恢复AI结果' : '恢复初始');
      restoreBtn.dataset.tip = lm || !d.maskAI ? '撤掉所有手动修补和边缘调整' : '撤掉所有手动修补和边缘调整，回到图片原来的透明区域';
      restoreBtn.setDisabled(!d.maskAI);
      // 去色边 belongs to an AI result; a PNG's own soft edge already keeps its original colours
      decontam.hidden = !lm;
      const t = currentTool();
      brushMode.setValue(t.id === 'mask-brush' ? t.mode : null);
      doneBtn.hidden = t.id !== 'mask-brush';
      size.setValue(store.ui.brush.size);
    }
    ctx.on('doc:changed', (p) => { if (p?.reason !== 'bump') sync(); });
    ctx.on('tool:changed', sync);
    ctx.on('cutout:running', sync);
    ctx.on('brush:changed', () => size.setValue(store.ui.brush.size));
    ctx.on('inspection:changed', () => inspection.setValue(viewport.inspection || 'result'));
    sync();
  },
});
