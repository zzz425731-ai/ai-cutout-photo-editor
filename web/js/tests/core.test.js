// tests/core.test.js — core helpers added for phase-2 panels + regression tests for core bugs found in QA.
import { suite, test, assert, assertEq, canvasOf, px } from './harness.js';
import { store, createDoc } from '../core/store.js';
import { createCanvas } from '../core/io.js';
import { createBrushStroke } from '../core/brush.js';
import { syncFg, replaceSource } from '../core/actions.js';
import { matteCanvas } from '../core/api.js';
import { runCutout } from '../core/actions.js';

function docWithFg(w = 60, h = 40) {
  const src = canvasOf(w, h, (c) => { c.fillStyle = '#808080'; c.fillRect(0, 0, w, h); });
  const doc = createDoc({ source: src, name: '测试' });
  // fg differs from the photo only in a 1-px "edge band" column at x=30 (去色边 colour)
  doc.fg = canvasOf(w, h, (c) => { c.drawImage(src, 0, 0); c.fillStyle = '#00ff00'; c.fillRect(30, 0, 1, h); });
  doc.mask = createCanvas(w, h, { willRead: true });
  doc.cutout = true;
  store.setDoc(doc);
  return doc;
}

suite('核心 / 多平面撤销与去色边同步');

test('commitRegions：一步撤销/重做两个平面', () => {
  const doc = docWithFg();
  const s = createBrushStroke({ plane: doc.source, mirror: doc.fg, mode: 'paint', color: '#ff0000', size: 10, hardness: 1 });
  s.addPoint(10, 20); s.addPoint(40, 20);
  const res = s.end();
  assert(res.mirror && res.mirror.before && res.mirror.after, '应返回镜像平面的撤销数据');
  store.commitRegions('涂鸦', [{ plane: 'source', ...res }, { plane: 'fg', rect: res.rect, ...res.mirror }]);
  assertEq(store.historyInfo().undo, 1, '只有一步');
  assertEq(px(doc.source, 20, 20)[0], 255, 'source 已涂红');
  assertEq(px(doc.fg, 20, 20)[0], 255, 'fg 同步涂红');
  assertEq(px(doc.fg, 30, 20)[0], 255, 'fg 边缘带也涂红');
  store.undo();
  assertEq(px(doc.source, 20, 20)[0], 128, '撤销 source');
  assertEq(px(doc.fg, 20, 20)[0], 128, '撤销 fg');
  assertEq(px(doc.fg, 30, 20)[1], 255, '撤销后边缘带恢复去色边颜色');
  store.redo();
  assertEq(px(doc.fg, 20, 20)[0], 255, '重做 fg');
});

test('画笔 mirror：取消时两个平面都恢复', () => {
  const doc = docWithFg();
  const s = createBrushStroke({ plane: doc.source, mirror: doc.fg, mode: 'paint', color: '#0000ff', size: 8 });
  s.addPoint(30, 10);
  assertEq(px(doc.fg, 30, 10)[2], 255);
  s.cancel();
  assertEq(px(doc.fg, 30, 10)[1], 255, 'fg 恢复');
  assertEq(px(doc.source, 30, 10)[2], 128, 'source 恢复');
});

test('syncFg：改动过的像素取新照片，未改动的保留去色边', () => {
  const doc = docWithFg();
  const edited = canvasOf(60, 40, (c) => { c.drawImage(doc.source, 0, 0); c.fillStyle = '#000000'; c.fillRect(0, 0, 20, 40); });
  const fg = syncFg(doc.source, edited, doc.fg);
  assertEq(px(fg, 5, 5)[0], 0, '改动区域');
  assertEq(px(fg, 30, 5)[1], 255, '未改动的边缘带保留');
  assertEq(px(fg, 50, 5)[0], 128, '其他保持');
});

test('replaceSource：一步撤销，fg 跟随', () => {
  const doc = docWithFg();
  const oldSrc = doc.source, oldFg = doc.fg;
  const edited = canvasOf(60, 40, (c) => { c.drawImage(oldSrc, 0, 0); c.fillStyle = '#ffffff'; c.fillRect(25, 0, 10, 40); });
  replaceSource('消除', edited);
  assert(doc.source === edited, 'source 替换');
  assertEq(px(doc.fg, 30, 5)[1], 255, 'fg 边缘带被编辑覆盖为新照片（白色）');
  assertEq(px(doc.fg, 30, 5)[0], 255);
  store.undo();
  assert(doc.source === oldSrc && doc.fg === oldFg, '撤销恢复原平面');
});

// ---------------------------------------------------------------- regressions from QA session 2
import { slider } from '../core/ui.js';

suite('核心 / QA 回归（第二轮）');

test('endCoalesce：松开滑块后，下一次拖动是新的一步', () => {
  docWithFg();
  store.commit('羽化', (d) => { d.edge.feather = 4; }, { coalesce: 'edge.feather' });
  store.commit('羽化', (d) => { d.edge.feather = 8; }, { coalesce: 'edge.feather' });
  store.endCoalesce();
  store.commit('羽化', (d) => { d.edge.feather = 12; }, { coalesce: 'edge.feather' });
  assertEq(store.historyInfo().undo, 2, '两次拖动 = 两步');
  store.undo();
  assertEq(store.doc.edge.feather, 8, '撤销回到第一次拖动的结果');
  store.endCoalesce('别的键'); // other key: no effect, no throw
});

test('滑块：鼠标拖动松开会结束合并；数字框相同值不产生新步骤', () => {
  docWithFg();
  const sl = slider({ label: '羽化', min: 0, max: 30, value: 0,
    onInput: (v) => store.commit('羽化', (d) => { d.edge.feather = v; }, { coalesce: 'edge.feather' }) });
  document.body.append(sl);
  try {
    const r = sl.input;
    r.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    for (const v of [3, 6, 9]) { r.value = v; r.dispatchEvent(new Event('input', { bubbles: true })); }
    r.dispatchEvent(new Event('change', { bubbles: true }));
    r.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    r.value = 20; r.dispatchEvent(new Event('input', { bubbles: true }));
    r.dispatchEvent(new Event('change', { bubbles: true }));
    assertEq(store.historyInfo().undo, 2, '两次拖动');
    const num = sl.querySelector('.num');
    num.dispatchEvent(new Event('blur')); // focus/blur without typing
    assertEq(store.historyInfo().undo, 2, '失去焦点不应多记一步');
    assertEq(sl.getValue(), 20);
  } finally { sl.remove(); }
});

test('滑块 power：非线性刻度，setValue/getValue 往返一致', () => {
  const seen = [];
  const sl = slider({ label: '画笔大小', min: 2, max: 800, power: 2, value: 40, onInput: (v) => seen.push(v) });
  assertEq(sl.getValue(), 40, '初始值');
  assertEq(sl.querySelector('.num').value, '40');
  for (const v of [2, 7, 48, 333, 800]) { sl.setValue(v); assertEq(sl.getValue(), v, `往返 ${v}`); }
  sl.setValue(5000); assertEq(sl.getValue(), 800, '超出上限被夹住');
  const r = sl.input;
  r.value = 500; r.dispatchEvent(new Event('input'));
  assertEq(seen[0], Math.round(2 + 798 * 0.25), '中点 = 1/4 数值（平方曲线）');
  r.value = 1000; r.dispatchEvent(new Event('input'));
  assertEq(seen[1], 800);
});

test('蒙版笔触的撤销数据只存透明度（¼ 内存），撤销/重做逐像素一致', () => {
  const doc = docWithFg(200, 100);
  const s = createBrushStroke({ plane: doc.mask, mode: 'paint', linear: true, size: 30, hardness: 0.5 });
  for (let x = 20; x <= 180; x += 10) s.addPoint(x, 50);
  const res = s.end();
  store.commitRegion('画笔保留', 'mask', res.rect, res.before, res.after);
  const px4 = res.rect.w * res.rect.h * 4;
  assertEq(store.historyInfo().bytes, px4 / 2, 'before+after 各 w×h 字节');
  const snap = () => Array.from(doc.mask.getContext('2d').getImageData(0, 0, 200, 100).data).join(',');
  const after = snap();
  store.undo();
  assertEq(px(doc.mask, 100, 50)[3], 0, '撤销后清空');
  store.redo();
  assert(snap() === after, '重做后逐像素一致');
  // photo planes (RGB ≠ 0) keep full RGBA
  const s2 = createBrushStroke({ plane: doc.source, mode: 'paint', color: '#ff0000', size: 10 });
  s2.addPoint(50, 50);
  const r2 = s2.end();
  store.commitRegion('涂鸦', 'source', r2.rect, r2.before, r2.after);
  store.undo();
  assertEq(px(doc.source, 50, 50)[0], 128, '照片平面撤销正确');
});

test('linear 画笔：同一位置先保留再擦除，不留残影', () => {
  const m = createCanvas(80, 80, { willRead: true });
  for (const hardness of [1, 0.7, 0]) {
    const a = createBrushStroke({ plane: m, mode: 'paint', linear: true, size: 33, hardness });
    a.addPoint(40.3, 39.7); a.end();
    const b = createBrushStroke({ plane: m, mode: 'erase', linear: true, size: 33, hardness });
    b.addPoint(40.3, 39.7); b.end();
    const d = m.getContext('2d').getImageData(0, 0, 80, 80).data;
    let left = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i]) left++;
    assertEq(left, 0, `硬度 ${hardness} 残留像素`);
  }
  // erase over a full mask then keep again → back to 255 everywhere
  m.getContext('2d').fillRect(0, 0, 80, 80);
  const e = createBrushStroke({ plane: m, mode: 'erase', linear: true, size: 25, hardness: 0.6 }); e.addPoint(30, 30); e.end();
  const k = createBrushStroke({ plane: m, mode: 'paint', linear: true, size: 25, hardness: 0.6 }); k.addPoint(30, 30); k.end();
  const d2 = m.getContext('2d').getImageData(0, 0, 80, 80).data;
  let min = 255;
  for (let i = 3; i < d2.length; i += 4) min = Math.min(min, d2[i]);
  assertEq(min, 255, '先擦后补回应完全恢复');
});

import { renderDoc, prewarm, clearRenderCache } from '../core/render.js';

function edgeDoc() {
  const w = 300, h = 200;
  const src = canvasOf(w, h, (c) => { const g = c.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#ff8800'); g.addColorStop(1, '#2244cc'); c.fillStyle = g; c.fillRect(0, 0, w, h); });
  const doc = createDoc({ source: src, name: '测试' });
  doc.mask = createCanvas(w, h, { willRead: true });
  const m = doc.mask.getContext('2d');
  m.beginPath(); m.ellipse(150, 100, 90, 60, 0.3, 0, Math.PI * 2); m.fill();
  doc.cutout = true;
  doc.bg = { ...doc.bg, type: 'color', color: '#ffffff' };
  doc.edge = { feather: 6, shift: -3 };
  doc.fx.stroke = { on: true, width: 10, color: '#ffd43b' };
  store.setDoc(doc);
  return doc;
}
const pixelsOf = (c) => Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data);

test('prewarm（后台线程算边缘/描边）结果与同步渲染逐像素一致', async () => {
  for (const scale of [1, 0.5]) {
    const doc = edgeDoc();
    clearRenderCache();
    const a = pixelsOf(renderDoc(doc, { scale }));
    clearRenderCache();
    const did = await prewarm(doc, scale);
    assert(did === true, `scale ${scale}: 应在后台算好`);
    const b = pixelsOf(renderDoc(doc, { scale }));
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    assertEq(diff, 0, `scale ${scale} 不同的通道数`);
    assertEq(await prewarm(doc, scale), false, '已缓存时无需再算');
  }
});

test('prewarm：计算期间蒙版被修改 → 丢弃结果，渲染仍正确', async () => {
  const doc = edgeDoc();
  clearRenderCache();
  const p = prewarm(doc, 1);
  const m = doc.mask.getContext('2d');
  m.clearRect(0, 0, 150, 200);
  store.bump('mask');
  assertEq(await p, false, '过期结果被丢弃');
  const c = renderDoc(doc, { scale: 1 });
  assertEq(px(c, 110, 100)[0], 255, '左半边已被擦掉 → 白色背景');
  assertEq(px(c, 110, 100)[2], 255);
});

test('带半透明边缘的 PNG：主体保留原本颜色（放到深色背景上不出白边）', async () => {
  const { splitAlpha } = await import('../core/io.js');
  const t = canvasOf(40, 20, (c) => { c.fillStyle = 'rgba(40, 80, 200, 0.4)'; c.fillRect(0, 0, 20, 20); c.fillStyle = '#20a040'; c.fillRect(20, 0, 20, 20); });
  const { source, mask, fg } = splitAlpha(t);
  assert(fg, '有半透明像素时应生成 fg');
  const doc = createDoc({ source, name: 'png' });
  Object.assign(doc, { mask, fg, cutout: true });
  doc.bg = { ...doc.bg, type: 'color', color: '#000000' };
  store.setDoc(doc);
  clearRenderCache();
  const out = renderDoc(doc, { scale: 1 });
  const p = px(out, 10, 10); // 0.4 × (40,80,200) over black ≈ (16,32,80); a white halo would give ≈ (108,124,184)
  assert(Math.abs(p[0] - 16) <= 3 && Math.abs(p[1] - 32) <= 3 && Math.abs(p[2] - 80) <= 3, `半透明区颜色 ${p}`);
  assertEq(px(out, 30, 10).slice(0, 3).join(','), '32,160,64', '不透明区不变');
  const hard = canvasOf(10, 10, (c) => { c.fillRect(2, 2, 5, 5); });
  assertEq(splitAlpha(hard).fg, null, '没有半透明像素时 fg 为 null');
});

test('AI 抠图上传无损 PNG，并保留实际模式和降级提示', async () => {
  const src = canvasOf(5, 3, (c) => {
    c.fillStyle = '#ff0000'; c.fillRect(0, 0, 5, 3);
    c.fillStyle = '#00ff00'; c.fillRect(1, 0, 1, 3);
    c.fillStyle = '#0000ff'; c.fillRect(3, 0, 1, 3);
  });
  const mask = canvasOf(5, 3, (c) => { c.fillStyle = '#fff'; c.fillRect(0, 0, 5, 3); }).toDataURL();
  const oldFetch = globalThis.fetch;
  let uploaded;
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('/api/matte?')) {
      uploaded = opts.body;
      return new Response(JSON.stringify({ mask, fg: null, ms: 1, mode: 'general', warning: '已使用通用模式' }), { headers: { 'Content-Type': 'application/json' } });
    }
    return oldFetch(url, opts);
  };
  try {
    const result = await matteCanvas(src, { mode: 'portrait' });
    assertEq(uploaded.type, 'image/png', '抠图输入不再损失细节');
    const bmp = await createImageBitmap(uploaded);
    const decoded = canvasOf(5, 3, (c) => c.drawImage(bmp, 0, 0));
    bmp.close();
    assertEq(pixelsOf(decoded).join(), pixelsOf(src).join(), '发丝附近高反差颜色逐像素无损');
    assertEq(result.mode, 'general', '实际模式');
    assertEq(result.warning, '已使用通用模式');
  } finally { globalThis.fetch = oldFetch; }
});

test('AI 等待期间手工修补蒙版后，旧 AI 结果不会覆盖新修补', async () => {
  const doc = docWithFg();
  const oldMask = doc.mask;
  const gray = canvasOf(60, 40, (c) => { c.fillStyle = '#fff'; c.fillRect(0, 0, 60, 40); }).toDataURL();
  const oldFetch = globalThis.fetch;
  let release, began;
  const requested = new Promise((resolve) => { began = resolve; });
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith('/api/matte?')) {
      began();
      await new Promise((resolve) => { release = resolve; });
      return new Response(JSON.stringify({ mask: gray, fg: null, ms: 1, mode: 'general' }), { headers: { 'Content-Type': 'application/json' } });
    }
    return oldFetch(url, opts);
  };
  let pending;
  try {
    pending = runCutout();
    await requested;
    doc.mask.getContext('2d').fillRect(12, 12, 2, 2);
    store.bump('mask', { x: 12, y: 12, w: 2, h: 2 });
    release();
    assertEq(await pending, false, '旧结果应被丢弃');
    assert(doc.mask === oldMask, '手工蒙版不被替换');
    assertEq(px(doc.mask, 12, 12)[3], 255, '修补仍保留');
    assertEq(px(doc.mask, 0, 0)[3], 0, '没有套上旧的 AI 蒙版');
  } finally { release?.(); if (pending) await pending; globalThis.fetch = oldFetch; }
});
