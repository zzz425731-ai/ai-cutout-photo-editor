// core/tools.js — canvas tool registry.
//
//   registerTool(tool)       tool = { id, cursor?, hint?, pans?, maskView?,
//                                     activate?(opts), deactivate?(), onPointerDown(pt,e), onPointerMove(pt,e),
//                                     onPointerUp(pt,e), onDoubleClick?(pt,e), onKey?(e), drawOverlay?(ctx, viewport) }
//                            pt = {x,y} in doc px. drawOverlay ctx is in stage css px (use viewport.toScreen).
//                            onPointerMove is called for hover moves too (check e.buttons / your own state).
//                            maskView: true → while active (and 显示蒙版 is on) the stage shows photo + red removed area.
//   setTool(id, opts?)       activates a tool (unknown id → 'pan'); emits 'tool:changed'
//   currentTool() → tool
//   getTool(id)
// Space-drag and middle-drag always pan, whatever tool is active.

import { store } from './store.js';
import { viewport } from './viewport.js';

const tools = new Map();
let current = null;

export function registerTool(tool) {
  tools.set(tool.id, tool);
  return tool;
}
export function getTool(id) { return tools.get(id); }
export function currentTool() { return current || tools.get('pan'); }

export function setTool(id, opts = {}) {
  const t = tools.get(id) || tools.get('pan');
  if (current && current !== t) {
    try { current.deactivate?.(); } catch (err) { console.error('[tools] deactivate failed:', err); }
  }
  const prev = current;
  current = t;
  store.ui.tool = t.id;
  try { t.activate?.(opts); } catch (err) { console.error('[tools] activate failed:', err); }
  if (prev !== t || opts) store.emit('tool:changed', { id: t.id, opts });
  return t;
}

registerTool({
  id: 'pan',
  cursor: 'grab',
  pans: true,
  hint: '拖动画布查看 · 滚轮缩放 · Ctrl+0 适应窗口',
});
