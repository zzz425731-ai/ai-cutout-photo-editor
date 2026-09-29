// core/export-dialog.js — 「导出▾」 dialog: format / quality / size → browser download (or save to 输出).

import { store, cloneData } from './store.js';
import { h, modal, segmented, slider, toast, busy, hint } from './ui.js';
import { exportDoc, docHasTransparency, suggestFilename } from './exporter.js';
import { downloadBlob } from './io.js';
import { nextFrame, saveToOutput } from './actions.js';

const FORMAT_HINT = {
  png: '保留透明背景，画质无损，文件较大',
  jpg: '体积小、到处都能打开，适合发微信、打印',
  webp: '体积最小，也能保留透明；个别旧软件打不开',
};

let last = null; // remembered choices for this session

export function openExportDialog() {
  const doc = store.doc;
  if (!doc) { toast('还没有打开图片', 'warning'); return; }
  const st = {
    format: last?.format || (docHasTransparency(doc) ? 'png' : 'jpg'),
    quality: last?.quality ?? 92,
    size: last?.size || 'orig',
    custom: last?.custom || Math.min(1600, Math.max(doc.width, doc.height)),
  };
  if (docHasTransparency(doc) && st.format === 'jpg' && !last) st.format = 'png';
  const long = Math.max(doc.width, doc.height);

  const fmtHint = hint('');
  const summary = h('div', { class: 'export-summary' });
  const q = slider({ label: '画质', min: 60, max: 100, step: 1, value: st.quality, unit: '%', onInput: (v) => { st.quality = v; update(); } });
  const customInput = h('input', { class: 'num-input', type: 'number', min: 64, max: 8192, value: st.custom, 'aria-label': '长边像素' });
  customInput.addEventListener('input', () => { st.custom = Math.max(64, Math.min(8192, parseInt(customInput.value, 10) || 0)); update(); });
  customInput.addEventListener('keydown', (e) => e.stopPropagation());
  const customRow = h('div', { class: 'custom-size' }, h('span', {}, '长边'), customInput, h('span', {}, '像素'));
  const fmt = segmented({ block: true, value: st.format, options: [
    { value: 'png', label: 'PNG 透明' }, { value: 'jpg', label: 'JPG' }, { value: 'webp', label: 'WebP' }],
  onChange: (v) => { st.format = v; update(); } });
  const size = segmented({ block: true, size: 'sm', value: st.size, options: [
    { value: 'orig', label: '原尺寸' }, { value: '2048', label: '长边2048' }, { value: '1080', label: '长边1080' }, { value: 'custom', label: '自定义' }],
  onChange: (v) => { st.size = v; update(); } });

  const content = h('div', { class: 'export-form' },
    h('div', { class: 'field' }, h('div', { class: 'field-label' }, '格式'), fmt, fmtHint),
    h('div', { class: 'field q-field' }, q),
    h('div', { class: 'field' }, h('div', { class: 'field-label' }, '尺寸'), size, customRow),
    summary);

  function maxSide() {
    if (st.size === 'orig') return null;
    if (st.size === 'custom') return st.custom;
    return +st.size;
  }
  function update() {
    fmtHint.textContent = FORMAT_HINT[st.format];
    content.querySelector('.q-field').hidden = st.format === 'png';
    customRow.hidden = st.size !== 'custom';
    const ms = maxSide();
    const k = ms && ms < long ? ms / long : 1;
    const w = Math.max(1, Math.round(doc.width * k)), hh = Math.max(1, Math.round(doc.height * k));
    const up = ms && ms > long ? '（不放大，保持原尺寸）' : '';
    summary.innerHTML = '';
    summary.append(h('div', { class: 'es-main' }, `输出 ${w} × ${hh} 像素 · ${st.format.toUpperCase()}${st.format === 'png' ? '' : ` · 画质 ${st.quality}%`}${up}`));
    if (st.format === 'jpg' && docHasTransparency(doc)) summary.append(h('div', { class: 'es-warn' }, '注意：JPG 不支持透明，透明部分会变成白色'));
  }
  update();

  const m = modal({
    title: '导出图片', content, width: 420,
    buttons: [
      { text: '保存到「输出」', icon: 'folder', onClick: (close) => { close(); last = { ...st }; saveToOutput({ format: st.format, quality: st.quality / 100, maxSide: maxSide() }); } },
      { text: '下载', primary: true, icon: 'save', id: 'export-download', onClick: (close) => { close(); last = { ...st }; download(); } },
    ],
  });
  async function download() {
    // 美颜等后台任务可能在编码期间替换照片；内容、参数和文件名固定在点击时。
    const snapshot = cloneData(doc);
    const options = { format: st.format, quality: st.quality / 100, maxSide: maxSide() };
    const filename = suggestFilename(snapshot, options.format);
    const b = busy('正在导出…');
    try {
      await nextFrame();
      const blob = await exportDoc(snapshot, options);
      downloadBlob(blob, filename);
      toast(`已导出 ${filename}（${(blob.size / 1024 / 1024).toFixed(1)} MB）`, 'success');
      store.emit('exported', { blob, format: options.format });
    } catch (err) {
      toast(err.message || '导出失败', 'error');
    } finally { b.done(); }
  }
  return m;
}
