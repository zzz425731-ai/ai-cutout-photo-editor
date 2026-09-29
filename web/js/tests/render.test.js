import { suite, test, assert, assertEq, assertClose, canvasOf, px, pixels } from './harness.js';
import { renderDoc, clearRenderCache, effectiveMask } from '../core/render.js';
import { createDoc, store } from '../core/store.js';
import { createCanvas } from '../core/io.js';
import { createBrushStroke } from '../core/brush.js';
import { createTextLayer, createEmojiLayer } from '../layers/render-layers.js';

// 80×60 red photo; mask = rectangle x 20..59, y 15..44 (fully opaque inside)
function makeDoc(opts = {}) {
  const src = canvasOf(80, 60, (c) => { c.fillStyle = '#ff0000'; c.fillRect(0, 0, 80, 60); c.fillStyle = '#00aa00'; c.fillRect(0, 0, 80, 8); });
  const doc = createDoc({ source: src });
  doc.mask = createCanvas(80, 60, { willRead: true });
  const m = doc.mask.getContext('2d');
  m.fillStyle = '#000'; m.fillRect(20, 15, 40, 30);
  doc.maskAI = doc.mask;
  doc.cutout = true;
  doc.bg.type = 'transparent';
  Object.assign(doc, opts);
  return doc;
}

suite('渲染管线');

test('未抠图时输出 = 原图', () => {
  const doc = makeDoc({ cutout: false });
  const out = renderDoc(doc);
  assertEq(px(out, 5, 30).join(), '255,0,0,255');
  assertEq(px(out, 5, 2)[1], 170);
});

test('抠图 + 透明背景：蒙版外 alpha=0，蒙版内 alpha=255', () => {
  const out = renderDoc(makeDoc());
  assertEq(px(out, 5, 30)[3], 0, '外部');
  assertEq(px(out, 79, 59)[3], 0, '角落');
  const inside = px(out, 40, 30);
  assertEq(inside[3], 255, '内部 alpha');
  assertEq(inside[0], 255, '内部颜色');
  assertEq(px(out, 20, 15)[3], 255, '边缘内侧像素');
  assertEq(px(out, 19, 15)[3], 0, '边缘外侧像素');
});

test('纯色背景', () => {
  const doc = makeDoc();
  doc.bg = { ...doc.bg, type: 'color', color: '#438edb' };
  const out = renderDoc(doc);
  assertEq(px(out, 5, 30).join(), '67,142,219,255');
  assertEq(px(out, 40, 30).join(), '255,0,0,255');
});

test('渐变背景（上→下）', () => {
  const doc = makeDoc();
  doc.bg = { ...doc.bg, type: 'gradient', color: '#000000', color2: '#ffffff', angle: 180 };
  const out = renderDoc(doc);
  const top = px(out, 5, 0)[0], bottom = px(out, 5, 59)[0];
  assert(top < 10 && bottom > 245, `上 ${top} 下 ${bottom}`);
  const l = px(out, 0, 30)[0], r = px(out, 79, 30)[0];
  assertClose(l, r, 2, '同一行颜色一致');
});

test('原背景 / 虚化背景 / 图片背景', () => {
  const doc = makeDoc();
  doc.bg = { ...doc.bg, type: 'original' };
  assertEq(px(renderDoc(doc), 5, 30).join(), '255,0,0,255', '原背景');
  doc.bg.type = 'blur'; doc.bg.blur = 30;
  const b = renderDoc(doc);
  assertEq(px(b, 0, 59)[3], 255, '虚化后角落不透明（边缘不褪色）');
  const g = px(b, 5, 5)[1];
  assert(g > 20 && g < 170, `绿色条被模糊扩散 ${g}`);
  doc.bg.type = 'image';
  doc.bg.image = canvasOf(10, 10, (c) => { c.fillStyle = '#0000ff'; c.fillRect(0, 0, 10, 10); });
  assertEq(px(renderDoc(doc), 5, 30).join(), '0,0,255,255', '图片背景铺满');
});

test('羽化让边缘变柔和', () => {
  clearRenderCache();
  const doc = makeDoc();
  doc.edge = { feather: 8, shift: 0 };
  const out = renderDoc(doc);
  const inEdge = px(out, 21, 30)[3], outEdge = px(out, 18, 30)[3];
  assert(inEdge < 250 && inEdge > 100, `内侧 ${inEdge}`);
  assert(outEdge > 5 && outEdge < 150, `外侧 ${outEdge}`);
  assertEq(px(out, 40, 30)[3], 255, '中心不受影响');
});

test('收缩 / 扩展移动边缘', () => {
  const doc = makeDoc();
  doc.edge = { feather: 0, shift: 3 };
  let out = renderDoc(doc);
  assertEq(px(out, 18, 30)[3], 255, '扩展 3px 后外侧 2px 变为主体');
  assertEq(px(out, 15, 30)[3], 0, '4px 之外仍透明');
  doc.edge = { feather: 0, shift: -3 };
  out = renderDoc(doc);
  assertEq(px(out, 21, 30)[3], 0, '收缩 3px 后内侧 1px 变透明');
  assertEq(px(out, 24, 30)[3], 255);
});

test('边缘在图片边界处不会被羽化淡出', () => {
  const doc = makeDoc();
  const m = doc.mask.getContext('2d');
  m.fillRect(0, 30, 80, 30); // subject touches the bottom edge
  doc.edge = { feather: 10, shift: 0 };
  const out = renderDoc(doc);
  assertEq(px(out, 40, 59)[3], 255, '底边保持不透明');
});

test('描边：主体外一圈为描边颜色', () => {
  const doc = makeDoc();
  doc.fx.stroke = { on: true, width: 5, color: '#ffffff' };
  const out = renderDoc(doc);
  const p = px(out, 17, 30);
  assertEq(p.join(), '255,255,255,255', '3px 外为白色描边');
  assertEq(px(out, 10, 30)[3], 0, '10px 外无描边');
  assertEq(px(out, 40, 30).join(), '255,0,0,255', '主体在描边上方');
});

test('阴影：主体下方出现半透明阴影', () => {
  const doc = makeDoc();
  doc.fx.shadow = { on: true, blur: 4, dx: 0, dy: 8, opacity: 0.5, color: '#000000' };
  const out = renderDoc(doc);
  const s = px(out, 40, 50);
  assert(s[3] > 60 && s[3] < 200, `阴影 alpha ${s[3]}`);
  assert(s[0] < 30, '阴影是黑色');
  assertEq(px(out, 40, 5)[3], 0, '上方无阴影');
});

test('按比例渲染（预览）', () => {
  const out = renderDoc(makeDoc(), { scale: 0.5 });
  assertEq(out.width, 40); assertEq(out.height, 30);
  assertEq(px(out, 20, 15)[3], 255);
  assertEq(px(out, 2, 15)[3], 0);
});

test('非整数缩小保留细发丝的覆盖面积和对称位置', () => {
  const doc = createDoc({ source: canvasOf(3, 3, (c) => c.fillRect(0, 0, 3, 3)) });
  doc.mask = createCanvas(3, 3);
  doc.mask.getContext('2d').fillRect(1, 0, 1, 3);
  doc.cutout = true;
  doc.bg.type = 'transparent';
  const em = effectiveMask(doc, 2 / 3);
  assertEq(Array.from(em.arr).join(), '85,85,85,85', '中间一像素发丝均分到左右两侧');
  doc.mask = createCanvas(3, 3);
  doc.mask.getContext('2d').fillRect(1, 1, 1, 1);
  assertEq(Array.from(effectiveMask(doc, 2 / 3).arr).join(), '28,28,28,28', '二维覆盖面积');
});

test('缩小主体先按透明度加权颜色，不把白底混进发丝', () => {
  const doc = createDoc({ source: canvasOf(9, 6, (c) => {
    c.fillStyle = '#fff'; c.fillRect(0, 0, 9, 6);
    c.fillStyle = '#f00'; c.fillRect(4, 0, 1, 6);
  }) });
  doc.mask = canvasOf(9, 6, (c) => c.fillRect(4, 0, 1, 6));
  doc.cutout = true; doc.bg.type = 'transparent';
  store.setDoc(doc);
  const scale = 2 / 3;
  const original = pixels(renderDoc(doc, { scale }));
  assertEq(px(renderDoc(doc, { scale }), 2, 1).join(), '255,0,0,85', '白底不会染红发丝');
  assertEq(px(renderDoc(doc), 4, 2).join(), '255,0,0,255', '原尺寸仍逐像素保真');
  const sctx = doc.source.getContext('2d'), oldRGB = sctx.getImageData(4, 0, 1, 6);
  sctx.fillStyle = '#00ff00'; sctx.fillRect(4, 0, 1, 6);
  store.commitRegion('修改发丝颜色', 'source', { x: 4, y: 0, w: 1, h: 6 }, oldRGB);
  assertEq(px(renderDoc(doc, { scale }), 2, 1).join(), '0,255,0,85', '照片局部编辑更新颜色缓存');
  store.undo();
  assertEq(pixels(renderDoc(doc, { scale })).join(), original.join(), '照片撤销后颜色恢复');
  // Keeping a removed area must recover the real source, including its original white colour.
  const ctx = doc.mask.getContext('2d'), before = ctx.getImageData(0, 0, 1, 6);
  ctx.fillRect(0, 0, 1, 6);
  store.commitRegion('保留背景区域', 'mask', { x: 0, y: 0, w: 1, h: 6 }, before);
  assertEq(px(renderDoc(doc, { scale }), 0, 1).join(), '255,255,255,170', '保留笔能恢复原区域颜色');
  store.undo();
  assertEq(pixels(renderDoc(doc, { scale })).join(), original.join(), '撤销会更新主体颜色缓存');
  store.redo();
  const partial = pixels(renderDoc(doc, { scale }));
  clearRenderCache();
  assertEq(pixels(renderDoc(doc, { scale })).join(), partial.join(), '重做局部更新与整图完全一致');
  // A decontaminated fg is the colour source, and mask parameters must not replace it with source.
  doc.fg = canvasOf(9, 6, (c) => {
    c.drawImage(doc.source, 0, 0); c.fillStyle = '#00f'; c.fillRect(4, 0, 1, 6);
  });
  for (const shift of [-0.25, 0, 0.75]) {
    doc.edge = { shift, feather: 0 };
    const p = px(renderDoc(doc, { scale }), 2, 1);
    assert(p[3] > 0, '发丝仍存在');
    assertEq(p.slice(0, 3).join(), '0,0,255', `shift ${shift} 保留去色边颜色`);
  }
  for (const shift of [-15, 15]) {
    doc.edge = { shift, feather: 30 };
    const cached = pixels(renderDoc(doc, { scale }));
    clearRenderCache();
    assertEq(pixels(renderDoc(doc, { scale })).join(), cached.join(), `极值 ${shift} 与羽化缓存一致`);
  }
});

test('边缘检查背景隐藏装饰而且不改动图片和正常导出', () => {
  const doc = makeDoc();
  doc.bg = { ...doc.bg, type: 'color', color: '#0000ff' };
  doc.fx.stroke = { on: true, width: 5, color: '#ffffff' };
  doc.fx.shadow = { on: true, blur: 4, dx: 0, dy: 8, opacity: 1, color: '#ff00ff' };
  doc.layers = [createTextLayer({ text: '测试', x: 40, y: 30, fontSize: 45, color: '#00ffff' })];
  const bg = doc.bg, fx = doc.fx, layers = doc.layers;
  const normal = pixels(renderDoc(doc));
  for (const [inspection, expected] of [['black', '0,0,0,255'], ['white', '255,255,255,255'], ['green', '0,255,0,255']]) {
    const c = renderDoc(doc, { inspection, maskView: true });
    assertEq(px(c, 18, 30).join(), expected, `${inspection} 仅显示检查底色，无描边`);
    assertEq(px(c, 40, 30).join(), '255,0,0,255', '主体上没有文字');
  }
  const alpha = renderDoc(doc, { inspection: 'alpha' });
  assertEq(px(alpha, 18, 30).join(), '0,0,0,255', '去掉部分为黑色');
  assertEq(px(alpha, 40, 30).join(), '255,255,255,255', '保留部分为白色');
  assert(doc.bg === bg && doc.fx === fx && doc.layers === layers, '检查视图不修改文档对象');
  assertEq(pixels(renderDoc(doc)).join(), normal.join(), '检查前后正常导出逐像素不变');
});

test('显示原图 / 显示蒙版', () => {
  const doc = makeDoc();
  const o = renderDoc(doc, { showOriginal: true });
  assertEq(px(o, 5, 30).join(), '255,0,0,255', '原图');
  const mv = renderDoc(doc, { maskView: true });
  const outside = px(mv, 5, 30), inside = px(mv, 40, 30);
  assertEq(inside.join(), '255,0,0,255', '主体不着色');
  assert(outside[3] === 255 && outside[1] > 10, `被去掉的部分叠红色 ${outside}`);
});

test('画笔局部更新与整图重算结果一致', () => {
  clearRenderCache();
  const doc = makeDoc();
  doc.edge = { feather: 4, shift: 2 };
  store.setDoc(doc);
  const scale = 0.37; // deliberately fractional: both mask coverage and dirty rectangles are exercised
  renderDoc(doc, { scale }); // warm caches
  const stroke = createBrushStroke({ plane: doc.mask, mode: 'erase', size: 10, hardness: 0.5 });
  for (const [x, y] of [[25, 20], [35, 25], [45, 30]]) { const r = stroke.addPoint(x, y); if (r) store.bump('mask', r); }
  const res = stroke.end();
  store.commitRegion('擦除', 'mask', res.rect, res.before, res.after);
  const partial = pixels(renderDoc(doc, { scale }));
  clearRenderCache();
  const full = pixels(renderDoc(doc, { scale }));
  let m = 0;
  for (let i = 0; i < full.length; i++) m = Math.max(m, Math.abs(full[i] - partial[i]));
  assert(m <= 2, `局部与整图最大差 ${m}`);
  store.undo();
  const undone = pixels(renderDoc(doc, { scale }));
  clearRenderCache();
  const fresh = pixels(renderDoc(doc, { scale }));
  let m2 = 0;
  for (let i = 0; i < fresh.length; i++) m2 = Math.max(m2, Math.abs(fresh[i] - undone[i]));
  assert(m2 <= 2, `撤销后局部更新误差 ${m2}`);
});

test('effectiveMask 返回处理后的蒙版', () => {
  const doc = makeDoc();
  doc.edge = { feather: 0, shift: 2 };
  const em = effectiveMask(doc, 1);
  assertEq(em.w, 80);
  assertEq(em.arr[30 * 80 + 18], 255);
});

test('四分之一像素边缘调整在预览和原尺寸均有效', () => {
  const doc = makeDoc();
  doc.edge.shift = 0.25;
  const full = effectiveMask(doc, 1);
  assertClose(full.arr[30 * 80 + 19], 64, 1, '原尺寸向外扩展四分之一像素');
  const preview = effectiveMask(doc, 0.5);
  assertClose(preview.arr[15 * 40 + 9], 32, 1, '预览按比例保留分数像素');
});

test('文字和贴纸图层按位置绘制', () => {
  const doc = makeDoc({ cutout: false });
  doc.layers = [createTextLayer({ text: '好', x: 40, y: 30, fontSize: 30, color: '#0000ff', stroke: { on: false } }), createEmojiLayer({ x: 70, y: 50, size: 12, opacity: 0 })];
  const out = renderDoc(doc);
  let blue = 0;
  const d = pixels(out);
  for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 200 && d[i] < 80) blue++;
  assert(blue > 20, `文字像素 ${blue}`);
  assertEq(px(out, 70, 50).join(), '255,0,0,255', '透明度 0 的贴纸不可见');
  const none = renderDoc(doc, { noLayers: true });
  assertEq(px(none, 40, 30).join(), '255,0,0,255', 'noLayers');
});
