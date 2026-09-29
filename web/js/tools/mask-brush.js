// tools/mask-brush.js — 手动修补: paints the subject mask (保留) or removes from it (擦除).
//   setTool('mask-brush', { mode: 'keep' | 'erase' })
//   X toggles keep/erase while the tool is active. Size/hardness come from store.ui.brush.

import { store } from '../core/store.js';
import { registerTool } from '../core/tools.js';
import { createBrushStroke, drawBrushCursor } from '../core/brush.js';
import { toast } from '../core/ui.js';

let mode = 'keep';
let stroke = null;
let strokeMask = null;

function finish() {
  if (!stroke) return;
  const res = stroke.end();
  const m = mode;
  stroke = null;
  store.ui.brushing = false;
  if (res && store.doc && store.doc.mask === strokeMask) {
    store.commitRegion(m === 'keep' ? '画笔保留' : '画笔擦除', 'mask', res.rect, res.before, res.after);
  }
  strokeMask = null;
}

export const maskBrush = registerTool({
  id: 'mask-brush',
  cursor: 'none',
  maskView: true,
  get hint() {
    return mode === 'keep'
      ? '保留画笔：涂抹被误删、需要留下的部分 · [ ] 调大小 · X 切换擦除 · 空格拖动画布'
      : '擦除画笔：涂抹多余、需要去掉的部分 · [ ] 调大小 · X 切换保留 · 空格拖动画布';
  },
  get mode() { return mode; },
  activate(opts = {}) {
    if (opts.mode === 'keep' || opts.mode === 'erase') mode = opts.mode;
  },
  deactivate() { finish(); },
  onPointerDown(pt) {
    const doc = store.doc;
    if (!doc?.mask || !doc.cutout) { toast('请先点「一键抠图」，再用画笔修补', 'warning'); return; }
    strokeMask = doc.mask;
    stroke = createBrushStroke({
      plane: doc.mask,
      mode: mode === 'keep' ? 'paint' : 'erase',
      linear: true, // keep/erase over the same spot cancel exactly (no ghost rim)
      size: store.ui.brush.size,
      hardness: store.ui.brush.hardness,
    });
    store.ui.brushing = true;
    const r = stroke.addPoint(pt.x, pt.y);
    if (r) store.bump('mask', r);
  },
  onPointerMove(pt) {
    if (!stroke) return;
    const r = stroke.addPoint(pt.x, pt.y);
    if (r) store.bump('mask', r);
  },
  onPointerUp(pt) {
    if (!stroke) return;
    const r = stroke.addPoint(pt.x, pt.y);
    if (r) store.bump('mask', r);
    finish();
  },
  onKey(e) {
    if ((e.key === 'x' || e.key === 'X') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      mode = mode === 'keep' ? 'erase' : 'keep';
      store.emit('tool:changed', { id: 'mask-brush', opts: { mode } });
    }
  },
  drawOverlay(ctx, vp) {
    drawBrushCursor(ctx, vp, { size: store.ui.brush.size, hardness: store.ui.brush.hardness, mode });
  },
});
