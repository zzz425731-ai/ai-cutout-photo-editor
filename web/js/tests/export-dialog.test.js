import { suite, test, assert, assertEq, canvasOf, px, blobToCanvasT } from './harness.js';
import { store, createDoc } from '../core/store.js';
import { openExportDialog } from '../core/export-dialog.js';

suite('下载导出 / 后台编辑');

test('下载期间后台替换源图和参数：内容、尺寸与文件名来自点击时同一版本', async () => {
  const source = canvasOf(20, 10, (c) => { c.fillStyle = '#ff0000'; c.fillRect(0, 0, 20, 10); });
  store.setDoc(createDoc({ source, name: '红图' }));
  const dialog = openExportDialog();
  dialog.el.querySelector('[data-value="png"]').click();
  let clicked = null;
  const originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download && this.href.startsWith('blob:')) { clicked = { filename: this.download }; return; }
    return originalClick.call(this);
  };
  let off;
  const exported = new Promise((resolve) => { off = store.on('exported', resolve); });
  let timeout;
  try {
    dialog.el.querySelector('#export-download').click();
    store.commit('后台处理完成', (d) => {
      d.source = canvasOf(8, 8, (c) => { c.fillStyle = '#0000ff'; c.fillRect(0, 0, 8, 8); });
      d.width = 8; d.height = 8; d.name = '蓝图'; d.adjust.brightness = -100;
    });
    const result = await Promise.race([exported, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('下载导出超时')), 5000);
    })]);
    assertEq(clicked?.filename, '红图_编辑.png', '下载文件名属于点击时的照片');
    assertEq(result.format, 'png');
    const out = await blobToCanvasT(result.blob);
    assertEq(`${out.width}x${out.height}`, '20x10', '保留点击时的尺寸');
    assertEq(px(out, 5, 5).join(','), '255,0,0,255', '照片像素及调整参数来自原版本');
    assertEq(store.doc.name, '蓝图', '导出没有回滚后台的新结果');
    assert(store.dirty, '新结果仍未保存');
  } finally {
    clearTimeout(timeout); off?.(); HTMLAnchorElement.prototype.click = originalClick;
    dialog.close();
    document.querySelectorAll('#toasts .toast').forEach((t) => t.remove());
  }
});
