// tests/panels/text.test.js — text layer rendering (render-layers.js), layer operations + transform maths
// (tools/layer-tool.js), 花字 presets and font detection (panels/text.js, panels/text/fonts.js).
import { suite, test, assert, assertEq, assertClose, canvasOf, px, pixels } from '../harness.js';
import { store, createDoc } from '../../core/store.js';
import { renderDoc } from '../../core/render.js';
import { resizeCanvas } from '../../core/io.js';
import {
  createTextLayer, drawLayer, layerSize, layerCorners, hitTestLayers, docToLocal, localToDoc, layerBounds, DEFAULT_FONT,
} from '../../layers/render-layers.js';
import {
  addLayer, deleteLayer, duplicateLayer, moveLayerOrder, toggleLayerHidden, updateLayer, selectLayer, selectedLayer, scaleFrom,
  placementPoint,
} from '../../tools/layer-tool.js';
import { viewport } from '../../core/viewport.js';
import { PRESETS, applyPreset } from '../../panels/text.js';
import { installedFonts, pickFont, stackFor, familyOf } from '../../panels/text/fonts.js';

const blank = (w, h, color = '#808080') => canvasOf(w, h, (c) => { c.fillStyle = color; c.fillRect(0, 0, w, h); });
const T = (props) => createTextLayer({ stroke: { on: false, width: 0, color: '#000' }, fontFamily: '"Microsoft YaHei"', ...props });

/** Bounding box of pixels matching fn(r,g,b,a). */
function bbox(c, fn) {
  const d = pixels(c), w = c.width;
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (!fn(d[i], d[i + 1], d[i + 2], d[i + 3])) continue;
    const p = i / 4, x = p % w, y = (p / w) | 0;
    n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return n ? { x0, y0, x1, y1, n, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 } : null;
}
const isBlue = (r, g, b, a) => a > 128 && b > 180 && r < 90 && g < 110;
const isRed = (r, g, b, a) => a > 128 && r > 180 && g < 90 && b < 90;

suite('文字 / 图层几何');

test('连续添加许多文字贴纸时，新图层始终留在可见画布内', () => {
  const width = Object.getOwnPropertyDescriptor(viewport, 'width'), height = Object.getOwnPropertyDescriptor(viewport, 'height');
  const oldView = { zoom: viewport.zoom, panX: viewport.panX, panY: viewport.panY };
  try {
    Object.defineProperty(viewport, 'width', { configurable: true, value: 0 });
    Object.defineProperty(viewport, 'height', { configurable: true, value: 0 });
    const doc = createDoc({ source: blank(600, 400) }); store.setDoc(doc);
    for (let i = 0; i < 35; i++) {
      const p = placementPoint();
      assert(p.x >= 60 && p.x <= 540 && p.y >= 40 && p.y <= 360, `第 ${i + 1} 个图层在画布内`);
      doc.layers.push({ id: `placement-${i}`, type: 'image', ...p });
    }
    Object.defineProperty(viewport, 'width', { configurable: true, value: 400 });
    Object.defineProperty(viewport, 'height', { configurable: true, value: 300 });
    Object.assign(viewport, { zoom: 2, panX: -400, panY: -200 });
    doc.layers = [];
    for (let i = 0; i < 15; i++) {
      const p = placementPoint();
      assert(p.x >= 200 && p.x <= 400 && p.y >= 100 && p.y <= 250, '缩放平移后仍在可见部分');
      doc.layers.push({ id: `zoom-placement-${i}`, type: 'image', ...p });
    }
  } finally {
    Object.defineProperty(viewport, 'width', width); Object.defineProperty(viewport, 'height', height);
    Object.assign(viewport, oldView);
  }
});

test('layerSize / layerCorners / hitTest 考虑旋转和拉伸', () => {
  const L = T({ text: '测试', x: 100, y: 80, fontSize: 100, scale: 0.5 });
  const { w, h } = layerSize(L);
  assert(w > 150 && w < 260, `两个字的宽度 ${w}`);
  assertClose(h, 125, 0.5, '行高 1.25');
  const doc = { layers: [L] };
  assert(hitTestLayers(doc, 100 + (w * 0.5) / 2 - 2, 80) === L, '右边缘内命中');
  assert(hitTestLayers(doc, 100 + (w * 0.5) / 2 + 3, 80) === null, '右边缘外不命中');
  L.rotation = Math.PI / 2;
  assert(hitTestLayers(doc, 100, 80 + (w * 0.5) / 2 - 2) === L, '旋转 90° 后竖向命中');
  assert(hitTestLayers(doc, 100 + (w * 0.5) / 2 - 2, 80) === null, '旋转后横向不再命中');
  L.rotation = 0.7; L.sy = 1.6;
  const p = localToDoc(L, 30, -20), q = docToLocal(L, p.x, p.y);
  assertClose(q.x, 30, 1e-6); assertClose(q.y, -20, 1e-6);
  const cs = layerCorners(L);
  const b = layerBounds(L);
  assert(cs.every(([x, y]) => x >= b.x - 1e-6 && x <= b.x + b.w + 1e-6 && y >= b.y - 1e-6 && y <= b.y + b.h + 1e-6), '边界框包含四个角');
  L.hidden = true;
  assertEq(hitTestLayers(doc, 100, 80), null, '隐藏的图层不能被点中');
});

test('scaleFrom：等比缩放时对角固定；Shift 自由拉伸', () => {
  const src = blank(400, 300);
  store.setDoc(createDoc({ source: src }));
  const L = T({ text: '缩放', x: 200, y: 150, rotation: 0.4, scale: 0.5 });
  const cs = layerCorners(L);
  // drag the bottom-right corner (2) outwards along the diagonal by 50 %
  const A = cs[0], P = cs[2];
  const target = { x: A[0] + (P[0] - A[0]) * 1.5, y: A[1] + (P[1] - A[1]) * 1.5 };
  const r = scaleFrom(L, 2, target, false);
  assertClose(r.scale, 0.75, 1e-6, '缩放 1.5 倍');
  const L2 = { ...L, ...r, sy: L.sy };
  const cs2 = layerCorners(L2);
  assertClose(cs2[0][0], A[0], 1e-6, '左上角不动 x'); assertClose(cs2[0][1], A[1], 1e-6, '左上角不动 y');
  assertClose(cs2[2][0], target.x, 1e-6); assertClose(cs2[2][1], target.y, 1e-6);
  // free: stretch only along the local x axis
  const u = { x: Math.cos(0.4), y: Math.sin(0.4) };
  const { w } = layerSize(L);
  const t2 = { x: P[0] + u.x * w * 0.5 * 0.5, y: P[1] + u.y * w * 0.5 * 0.5 };
  const f = scaleFrom(L, 2, t2, true);
  assertClose(f.scale, 0.75, 1e-6, '横向 1.5 倍');
  assertClose(f.scale * f.sy, 0.5, 1e-6, '纵向不变');
  const cs3 = layerCorners({ ...L, ...f });
  assertClose(cs3[0][0], A[0], 1e-6, '自由拉伸时左上角也不动');
});

suite('文字 / 绘制');

test('描边在填充后面：笔画中间是文字色，外圈是描边色', () => {
  const c = blank(300, 160, '#ffffff');
  const L = T({ text: '一', x: 150, y: 80, color: '#0000ff', stroke: { on: true, width: 8, color: '#ff0000' } });
  drawLayer(c.getContext('2d'), L, 1);
  const blue = bbox(c, isBlue), red = bbox(c, isRed);
  assert(blue && red, '应同时有文字色和描边色');
  assertEq(px(c, Math.round(blue.cx), Math.round(blue.cy)).slice(0, 3).join(), '0,0,255', '笔画中心是文字色');
  assert(red.y0 < blue.y0 - 4 && red.y1 > blue.y1 + 4, '描边包在外面');
  assert(red.x0 < blue.x0 - 4 && red.x1 > blue.x1 + 4, '描边左右也包住');
});

test('半透明时描边不会透到文字上（整体一起变淡）', () => {
  const c = blank(300, 160, '#ffffff');
  const L = T({ text: '一', x: 150, y: 80, color: '#0000ff', opacity: 0.5, stroke: { on: true, width: 10, color: '#ff0000' } });
  drawLayer(c.getContext('2d'), L, 1);
  const inner = bbox(c, (r, g, b) => b > 200 && r > 100 && r < 160 && g > 100 && g < 160);
  assert(inner, '笔画中间应是 50% 蓝 + 白');
  const [r, g, b] = px(c, Math.round(inner.cx), Math.round(inner.cy));
  assertClose(r, 128, 6, '中心红通道'); assertClose(g, 128, 6); assertClose(b, 255, 2);
});

test('阴影按位置偏移，并随导出比例缩放', () => {
  const draw = (scale) => {
    const c = blank(Math.round(400 * scale), Math.round(200 * scale), '#ffffff');
    const L = T({ text: '一', x: 150, y: 90, color: '#0000ff', shadow: { on: true, color: '#ff0000', opacity: 1, blur: 0, dx: 60, dy: 20 } });
    drawLayer(c.getContext('2d'), L, scale);
    return c;
  };
  const c1 = draw(1), c2 = draw(0.5);
  const b1 = bbox(c1, isBlue), s1 = bbox(c1, isRed);
  assertClose(s1.cx - b1.cx, 60, 2, '阴影右移 60'); assertClose(s1.cy - b1.cy, 20, 2, '阴影下移 20');
  const b2 = bbox(c2, isBlue), s2 = bbox(c2, isRed);
  assertClose(s2.cx - b2.cx, 30, 2, '半尺寸时阴影偏移也减半');
  assertClose(b2.cx * 2, b1.cx, 3, '文字位置按比例');
});

test('背景框：留白里是底色，圆角处透明', () => {
  const c = canvasOf(400, 200);
  const L = T({ text: '字', x: 200, y: 100, color: '#ffffff', bg: { on: true, color: '#00ff00', opacity: 1, padding: 30, radius: 40, border: 0 } });
  drawLayer(c.getContext('2d'), L, 1);
  const { w, h } = layerSize(L);
  const x0 = Math.round(200 - w / 2), y0 = Math.round(100 - h / 2);
  assertEq(px(c, x0 + 1, y0 + 1)[3], 0, '圆角外透明');
  assertEq(px(c, x0 + 12, 100).slice(0, 4).join(), '0,255,0,255', '留白处是绿色底');
});

test('字间距：宽度增加 (字数-1)×间距，左对齐起点不变', () => {
  const base = T({ text: '一二三四', fontSize: 50, letterSpacing: 0 });
  const wide = T({ text: '一二三四', fontSize: 50, letterSpacing: 20 });
  assertClose(layerSize(wide).w - layerSize(base).w, 60, 0.6, '4 个字 3 个间距');
  const c = blank(500, 120, '#ffffff');
  const L = T({ text: '一二三四\n一', fontSize: 50, letterSpacing: 20, align: 'left', x: 250, y: 60, color: '#0000ff' });
  drawLayer(c.getContext('2d'), L, 1);
  const { w } = layerSize(L);
  const blue = bbox(c, isBlue);
  assert(blue.x0 >= 250 - w / 2 - 1 && blue.x0 < 250 - w / 2 + 12, `左对齐从框的左边开始 ${blue.x0} vs ${250 - w / 2}`);
  assert(blue.x1 <= 250 + w / 2 + 1, '不超出右边');
});

test('多行对齐：右对齐时短行靠右', () => {
  const c = blank(400, 200, '#ffffff');
  const L = T({ text: '一一一一\n一', fontSize: 40, align: 'right', x: 200, y: 100, color: '#0000ff' });
  drawLayer(c.getContext('2d'), L, 1);
  const { w } = layerSize(L);
  const second = bbox(canvasOf(400, 100, (x) => x.drawImage(c, 0, -100)), isBlue);
  assert(second.x1 > 200 + w / 2 - 10, '第二行贴右边');
  assert(second.x0 > 200, '第二行在右半边');
});

test('竖排：一列一列从右往左，框是竖长的', () => {
  const one = T({ text: '春天来了', fontSize: 40, vertical: true });
  const s = layerSize(one);
  assert(s.h > s.w * 2.5, `竖排一行应是竖长的 ${s.w}×${s.h}`);
  const c = blank(300, 300, '#ffffff');
  const L = T({ text: '一一一\n二', fontSize: 40, vertical: true, x: 150, y: 150, color: '#0000ff', lineHeight: 1.5 });
  drawLayer(c.getContext('2d'), L, 1);
  const right = bbox(canvasOf(150, 300, (x) => x.drawImage(c, -150, 0)), isBlue);
  const left = bbox(canvasOf(150, 300, (x) => x.drawImage(c, 0, 0)), isBlue);
  assert(right && left, '两列都有字');
  assert(right.y1 - right.y0 > (left.y1 - left.y0) * 2, '第一行（三个字）在右边一列');
});

test('渐变色：上面是第一种颜色，下面是第二种', () => {
  const c = blank(300, 200, '#ffffff');
  const L = T({ text: '█', fontSize: 120, x: 150, y: 100, color: '#ff0000', gradient: { on: true, color2: '#0000ff' } });
  drawLayer(c.getContext('2d'), L, 1);
  const any = bbox(c, (r, g, b) => (r > 150 || b > 150) && g < 80);
  assert(any, '画出了渐变');
  const top = px(c, Math.round(any.cx), any.y0 + 3), bot = px(c, Math.round(any.cx), any.y1 - 3);
  assert(top[0] > top[2], '顶部偏红'); assert(bot[2] > bot[0], '底部偏蓝');
});

test('导出与预览一致（半尺寸预览 ≈ 全尺寸缩小）', () => {
  const src = blank(480, 320, '#6b8fb5');
  const doc = createDoc({ source: src });
  doc.layers = [
    T({ text: '预览\n一致', x: 200, y: 150, rotation: 0.3, scale: 0.8, color: '#ffd83b', stroke: { on: true, width: 7, color: '#111111' },
      shadow: { on: true, color: '#000000', opacity: 0.5, blur: 10, dx: 4, dy: 6 }, bg: { on: true, color: '#e8383d', opacity: 0.7, padding: 20, radius: 16, border: 3 } }),
  ];
  const full = renderDoc(doc, { scale: 1 });
  const half = renderDoc(doc, { scale: 0.5 });
  const down = resizeCanvas(full, half.width, half.height);
  const a = pixels(half), b = pixels(down);
  let sum = 0;
  for (let i = 0; i < a.length; i += 4) sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  const mean = sum / (a.length / 4) / 3;
  assert(mean < 4, `平均差 ${mean.toFixed(2)}`);
});

test('完全看不见的图层（隐藏 / 透明度 0 / 空文字）不报错', () => {
  const c = blank(100, 100);
  const ctx = c.getContext('2d');
  drawLayer(ctx, T({ text: '', x: 50, y: 50 }), 1);
  drawLayer(ctx, T({ text: '隐', x: 50, y: 50, hidden: true, color: '#ff0000' }), 1);
  drawLayer(ctx, T({ text: '透', x: 50, y: 50, opacity: 0, color: '#ff0000' }), 1);
  drawLayer(ctx, T({ text: '远', x: 5000, y: 5000, shadow: { on: true, color: '#000', opacity: 1, blur: 10, dx: 3, dy: 3 } }), 1);
  assertEq(px(c, 50, 50).join(), '128,128,128,255');
});

suite('文字 / 图层操作与撤销');

test('添加 / 复制 / 上下移 / 隐藏 / 删除，每步都能撤销', () => {
  store.setDoc(createDoc({ source: blank(200, 100) }));
  const a = T({ text: 'A', x: 50, y: 50 }), b = T({ text: 'B', x: 150, y: 50 });
  addLayer(a, '添加文字'); addLayer(b, '添加文字');
  assertEq(store.ui.selectedLayerId, b.id, '新加的图层被选中');
  const cid = duplicateLayer(a.id);
  assertEq(store.doc.layers.map((l) => l.text).join(''), 'AAB', '复制品紧挨着原图层');
  assert(store.doc.layers[1].id === cid && store.doc.layers[1].x > a.x, '复制品稍微错开');
  moveLayerOrder(a.id, 1);
  assertEq(store.doc.layers[1].id, a.id, '上移一层');
  assertEq(moveLayerOrder(b.id, 1), false, '已经在最上面');
  toggleLayerHidden(b.id);
  assert(store.doc.layers[2].hidden, '隐藏');
  deleteLayer(cid);
  assertEq(store.doc.layers.length, 2);
  const labels = store.historyInfo().labels;
  assertEq(labels.slice(-4).join(','), '复制文字,图层上移,隐藏文字,删除文字', '撤销记录');
  for (let i = 0; i < 4; i++) store.undo();
  assertEq(store.doc.layers.map((l) => l.text).join(''), 'AB', '撤销回到两层');
  assert(!store.doc.layers[1].hidden);
  store.redo(); store.redo();
  assertEq(store.doc.layers[1].text, 'A', '重做上移');
  selectLayer(null);
});

test('updateLayer 合并同一个滑块的连续修改为一步', () => {
  store.setDoc(createDoc({ source: blank(200, 100) }));
  const L = T({ text: '合并', x: 100, y: 50 });
  addLayer(L, '添加文字');
  const n0 = store.historyInfo().undo;
  for (let i = 1; i <= 5; i++) updateLayer(L.id, '字号', (x) => { x.scale = 1 + i / 10; }, `text.size.${L.id}`);
  assertEq(store.historyInfo().undo, n0 + 1, '五次拖动只算一步');
  assertClose(selectedLayer().scale, 1.5, 1e-9);
  store.undo();
  assertClose(store.doc.layers[0].scale, 1, 1e-9, '撤销回原大小');
  assertEq(selectedLayer().id, L.id, '撤销后仍按 id 找到选中的图层');
  selectLayer(null);
});

suite('文字 / 花字与字体');

test('系统字体检测：至少有微软雅黑，名字能互相转换', () => {
  const fonts = installedFonts();
  assert(fonts.some((f) => f.family === 'Microsoft YaHei'), '有微软雅黑');
  assert(fonts.length >= 3, `检测到 ${fonts.length} 种字体`);
  assertEq(familyOf(DEFAULT_FONT), 'Microsoft YaHei');
  assertEq(familyOf(stackFor('KaiTi')), 'KaiTi');
  assertEq(pickFont(['NoSuchFont-xyz', 'Microsoft YaHei']), 'Microsoft YaHei');
  assertEq(pickFont(['NoSuchFont-xyz']), 'Microsoft YaHei', '都没有时用默认字体');
});

test('花字：8–10 个，套用后长度按字号换算', () => {
  assert(PRESETS.length >= 8 && PRESETS.length <= 10, `${PRESETS.length} 个花字`);
  const L = createTextLayer({ fontSize: 50, text: '花字' });
  const p = PRESETS.find((x) => x.id === 'notice');
  applyPreset(L, p);
  assert(L.bg.on && L.bg.color === p.style.bg.color, '套用背景框');
  assertClose(L.bg.padding, p.style.bg.padding / 2, 1e-9, '留白按字号 50 减半');
  assertEq(L.preset, 'notice');
  for (const q of PRESETS) {
    const X = applyPreset(createTextLayer({ text: q.name }), q);
    const c = canvasOf(300, 200);
    X.x = 150; X.y = 100; X.scale = 0.6;
    drawLayer(c.getContext('2d'), X, 1);
    const vis = bbox(c, (r, g, b, a) => a > 40);
    assert(vis && vis.n > 400, `花字「${q.name}」画出来了`);
  }
});
