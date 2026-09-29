// tools/doodle-brush.js — 涂鸦: draw on the photo with a colour pen or a semi-transparent 荧光笔.
//   setTool('doodle-brush')
// Colour / 荧光笔 come from store.ui.mosaic (mosaicSettings), size from store.ui.brush.size ([ ] keys).
// Paints doc.source with doc.fg as mirror; each stroke is ONE undo step (store.commitRegions).

import { store } from '../core/store.js';
import { registerTool } from '../core/tools.js';
import { createBrushStroke, drawBrushCursor } from '../core/brush.js';
import { mosaicSettings } from './mosaic-brush.js';

export const DOODLE_COLORS = [
  { value: '#ff3b30', name: '红色' },
  { value: '#ff9500', name: '橙色' },
  { value: '#ffd60a', name: '黄色' },
  { value: '#34c759', name: '绿色' },
  { value: '#0a84ff', name: '蓝色' },
  { value: '#af52de', name: '紫色' },
  { value: '#1c1c1e', name: '黑色' },
  { value: '#ffffff', name: '白色' },
];
export const HIGHLIGHTER_OPACITY = 0.4;

let stroke = null, planes = null;

function step(pt) {
  const r = stroke.addPoint(pt.x, pt.y);
  if (r) { store.bump('source', r); if (planes.fg) store.bump('fg', r); }
}
function finish() {
  if (!stroke) return;
  const res = stroke.end();
  stroke = null;
  const p = planes;
  planes = null;
  const d = store.doc;
  if (!res || !d || d.source !== p.src) return;
  store.commitRegions(p.hl ? '荧光笔' : '涂鸦',
    [{ plane: 'source', ...res }, res.mirror && d.fg === p.fg && { plane: 'fg', rect: res.rect, ...res.mirror }]);
}

export const doodleBrush = registerTool({
  id: 'doodle-brush',
  cursor: 'none',
  get hint() {
    return (mosaicSettings().highlighter ? '荧光笔：半透明，适合圈重点' : '涂鸦笔：在图上随手画') + ' · [ ] 调大小 · 空格拖动画布';
  },
  deactivate() { finish(); },
  onPointerDown(pt) {
    const d = store.doc;
    if (!d || stroke) return;
    const s = mosaicSettings();
    planes = { src: d.source, fg: d.fg, hl: !!s.highlighter };
    stroke = createBrushStroke({
      plane: d.source, mirror: d.fg || null, mode: 'paint', color: s.color,
      opacity: s.highlighter ? HIGHLIGHTER_OPACITY : 1, hardness: s.highlighter ? 0.95 : 0.85,
      size: Math.max(2, store.ui.brush.size), spacing: 0.06,
    });
    step(pt);
  },
  onPointerMove(pt) { if (stroke) step(pt); },
  onPointerUp(pt) { if (stroke) { step(pt); finish(); } },
  drawOverlay(ctx, vp) {
    const s = mosaicSettings();
    drawBrushCursor(ctx, vp, { size: store.ui.brush.size, hardness: 0.95 });
    const p = vp.pointer;
    if (!p.inside || vp.spaceHeld || vp.isPanning) return;
    ctx.save();
    ctx.globalAlpha = s.highlighter ? 0.6 : 1;
    ctx.fillStyle = s.color;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(p.sx, p.sy, Math.min(4, Math.max(2.5, (store.ui.brush.size / 2) * vp.zoom - 2)), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  },
});
