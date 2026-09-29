// tests/panels/crop.test.js — 裁剪: geometry, lossless 90° turns / flips, apply to every pixel plane + layers,
// one undo step, undo / redo pixel-identical.
import { suite, test, assert, assertEq, assertClose, canvasOf, pixels, blobToCanvasT } from '../harness.js';
import { store, createDoc } from '../../core/store.js';
import { createCanvas } from '../../core/io.js';
import { renderDoc } from '../../core/render.js';
import { exportDoc } from '../../core/exporter.js';
import { createTextLayer, createImageLayer } from '../../layers/render-layers.js';
import { addLayer, updateLayer, toggleLayerHidden, moveLayerOrder } from '../../tools/layer-tool.js';
import * as crop from '../../tools/crop-tool.js';
import '../../panels/crop.js';

function noise(w, h, { willRead = false, seed = 7, alpha = false } = {}) {
  const c = createCanvas(w, h, { willRead });
  const x = c.getContext('2d');
  const id = x.createImageData(w, h);
  let s = seed >>> 0;
  for (let i = 0; i < id.data.length; i += 4) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    id.data[i] = s >>> 24; id.data[i + 1] = (s >>> 16) & 255; id.data[i + 2] = (s >>> 8) & 255;
    id.data[i + 3] = alpha ? (s >>> 5) & 255 : 255;
  }
  if (alpha) for (let i = 0; i < id.data.length; i += 4) { id.data[i] = 0; id.data[i + 1] = 0; id.data[i + 2] = 0; }
  x.putImageData(id, 0, 0);
  return c;
}
function data(c) {
  const t = canvasOf(c.width, c.height, (x) => x.drawImage(c, 0, 0));
  return pixels(t);
}
function diffCount(a, b) {
  if (a.width !== b.width || a.height !== b.height) return -1;
  const A = data(a), B = data(b);
  let n = 0;
  for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) n++;
  return n;
}
function planFor(W, H, { m = crop.M_ID, theta = 0, crop: c = null, out = null } = {}) {
  const [W2, H2] = crop.frameDims(W, H, m);
  const cr = c || { x: 0, y: 0, w: W2, h: H2 };
  return { W, H, m, theta, crop: cr, out: out || { w: cr.w, h: cr.h } };
}
/** pixel (x, y) of a W×H doc lands at … after orientation m (reference implementation) */
function mapRef(m, W, H, x, y) {
  const [W2, H2] = crop.frameDims(W, H, m);
  const cx = x + 0.5 - W / 2, cy = y + 0.5 - H / 2;
  return [m[0] * cx + m[1] * cy + W2 / 2 - 0.5, m[2] * cx + m[3] * cy + H2 / 2 - 0.5];
}

suite('裁剪 / 几何');

test('比例列表：自由、原比例、1:1、一寸照 5:7 … 自定义', () => {
  assertEq(crop.RATIOS.map((r) => r.label).join(' '), '自由 原比例 1:1 一寸照 3:4 4:3 2:3 3:2 9:16 16:9 自定义');
  const inch = crop.RATIOS.find((r) => r.id === 'inch1');
  assertEq(inch.w / inch.h, 5 / 7);
});

test('rectInside：不拉直时就是图片范围；拉直后四角不能出界', () => {
  assert(crop.rectInside({ x: 0, y: 0, w: 100, h: 50 }, 100, 50, 0));
  assert(!crop.rectInside({ x: 1, y: 0, w: 100, h: 50 }, 100, 50, 0));
  const t = 10 * Math.PI / 180;
  assert(!crop.rectInside({ x: 0, y: 0, w: 100, h: 50 }, 100, 50, t), '整图在拉直后会露出空角');
  assert(crop.rectInside({ x: 40, y: 20, w: 20, h: 10 }, 100, 50, t));
});

test('fitAspect：得到指定比例、居中、完全在（旋转后的）图片里', () => {
  for (const th of [0, 5, -12, 30, 45]) {
    const t = th * Math.PI / 180;
    for (const a of [1, 5 / 7, 16 / 9, 3 / 4]) {
      const r = crop.fitAspect(a, 1200, 800, t, t ? 1 : 0);
      assertClose(r.w / r.h, a, 1e-6, `比例 ${a} @${th}°`);
      assertClose(r.x + r.w / 2, 600, 1e-6); assertClose(r.y + r.h / 2, 400, 1e-6);
      assert(crop.rectInside(r, 1200, 800, t, t ? 1 : 0), `越界 ${a} @${th}°`);
      // maximal: 1 % bigger no longer fits
      const g = { x: r.x - r.w * 0.005, y: r.y - r.h * 0.005, w: r.w * 1.01, h: r.h * 1.01 };
      assert(!crop.rectInside(g, 1200, 800, t, t ? 1 : 0), `不是最大 ${a} @${th}°`);
    }
  }
  const sq = crop.fitAspect(1, 1200, 800);
  assertEq(`${sq.x},${sq.y},${sq.w},${sq.h}`, '200,0,800,800');
});

test('shrinkInto：拉直时框按原比例缩小到没有空角，角度回 0 时恢复原框', () => {
  const base = { x: 0, y: 0, w: 1200, h: 800 };
  const t = 8 * Math.PI / 180;
  const r = crop.shrinkInto(base, 1200, 800, t, 1);
  assert(crop.rectInside(r, 1200, 800, t, 1));
  assertClose(r.w / r.h, 1.5, 1e-6);
  assert(r.w > 800 && r.w < 1200, `宽 ${r.w}`);
  const back = crop.shrinkInto(base, 1200, 800, 0, 0);
  assertEq(JSON.stringify(back), JSON.stringify(base));
  // a box in the corner slides toward the centre instead of collapsing
  const c = crop.shrinkInto({ x: 0, y: 0, w: 300, h: 300 }, 1200, 800, 20 * Math.PI / 180, 1);
  assert(c.w > 150, `角落里的框太小 ${c.w}`);
});

test('outputSizeFor：原尺寸 / 长边 / 锁定宽 / 锁定高 / 指定宽高 / 最大 4096', () => {
  const s = (r) => { const o = crop.outputSizeFor(3000, 2000, r); return `${o.w}x${o.h}${o.capped ? '!' : ''}`; };
  assertEq(s({ mode: 'orig' }), '3000x2000');
  assertEq(s({ mode: 'long', v: 1280 }), '1280x853');
  assertEq(s({ mode: 'w', v: 600 }), '600x400');
  assertEq(s({ mode: 'h', v: 500 }), '750x500');
  assertEq(s({ mode: 'exact', w: 640, h: 640 }), '640x640');
  assertEq(s({ mode: 'w', v: 9000 }), '4096x2731!');
});

test('planLabel：裁剪、旋转、翻转、拉直、改尺寸', () => {
  assertEq(crop.planLabel(planFor(100, 50, { crop: { x: 0, y: 0, w: 50, h: 50 } })), '裁剪');
  assertEq(crop.planLabel(planFor(100, 50, { m: crop.M_CW })), '旋转');
  assertEq(crop.planLabel(planFor(100, 50, { m: crop.M_FLIP_H })), '翻转');
  assertEq(crop.planLabel(planFor(100, 50, { theta: 3, crop: { x: 5, y: 5, w: 80, h: 40 } })), '拉直');
  assertEq(crop.planLabel(planFor(100, 50, { out: { w: 50, h: 25 } })), '改尺寸');
});

suite('裁剪 / 像素');

test('左转 / 右转 / 翻转是无损的：像素逐个对应，转回来完全一样', () => {
  for (const wr of [false, true]) {
    const c = noise(37, 23, { willRead: wr, seed: wr ? 3 : 5 });
    for (const m of [crop.M_CW, crop.M_CCW, crop.M_FLIP_H, crop.M_FLIP_V, crop.mulM(crop.M_CW, crop.M_CW), crop.mulM(crop.M_FLIP_H, crop.M_CW)]) {
      const out = crop.transformPlane(c, planFor(37, 23, { m }));
      const [W2, H2] = crop.frameDims(37, 23, m);
      assertEq(`${out.width}x${out.height}`, `${W2}x${H2}`);
      const A = data(c), B = data(out);
      let bad = 0;
      for (let y = 0; y < 23; y++) for (let x = 0; x < 37; x++) {
        const [nx, ny] = mapRef(m, 37, 23, x, y);
        const i = (y * 37 + x) * 4, j = (Math.round(ny) * W2 + Math.round(nx)) * 4;
        if (A[i] !== B[j] || A[i + 1] !== B[j + 1] || A[i + 2] !== B[j + 2] || A[i + 3] !== B[j + 3]) bad++;
      }
      assertEq(bad, 0, `方向 ${m} 像素不对应`);
    }
    // four right turns = the original, left∘right = the original
    let r = c;
    for (let i = 0; i < 4; i++) r = crop.transformPlane(r, planFor(r.width, r.height, { m: crop.M_CW }));
    assertEq(diffCount(c, r), 0, '转 4 次');
    const lr = crop.transformPlane(crop.transformPlane(c, planFor(37, 23, { m: crop.M_CW })), planFor(23, 37, { m: crop.M_CCW }));
    assertEq(diffCount(c, lr), 0, '右转再左转');
  }
});

test('裁剪框是整数像素时，裁出的像素和原图完全相同（包括透明蒙版）', () => {
  const src = noise(50, 40, { seed: 11 });
  const mask = noise(50, 40, { willRead: true, seed: 12, alpha: true });
  const plan = planFor(50, 40, { crop: { x: 7, y: 5, w: 30, h: 21 } });
  for (const c of [src, mask]) {
    const out = crop.transformPlane(c, plan);
    assertEq(`${out.width}x${out.height}`, '30x21');
    const ref = canvasOf(30, 21, (x) => x.drawImage(c, -7, -5));
    assertEq(diffCount(out, ref), 0);
  }
  assert(crop.transformPlane(mask, plan).__willRead, '蒙版仍然是 willRead 画布');
});

test('拉直：结果四角没有透明空白', () => {
  const src = noise(120, 80, { seed: 4 });
  const t = 12 * Math.PI / 180;
  const r = crop.roundRect(crop.fitAspect(1.5, 120, 80, t, 1), 120, 80, t);
  const out = crop.transformPlane(src, planFor(120, 80, { theta: 12, crop: r }));
  const d = data(out);
  let minA = 255;
  for (let i = 3; i < d.length; i += 4) minA = Math.min(minA, d[i]);
  assertEq(minA, 255, '有透明像素');
});

test('调整尺寸：输出正好是设定的大小', () => {
  const src = noise(300, 200, { seed: 9 });
  const out = crop.transformPlane(src, planFor(300, 200, { crop: { x: 0, y: 0, w: 300, h: 200 }, out: { w: 120, h: 80 } }));
  assertEq(`${out.width}x${out.height}`, '120x80');
});

suite('裁剪 / 图层');

test('右转 90°：图层位置跟着转，角度 +90°', () => {
  const L = { id: 'a', type: 'text', x: 10, y: 20, rotation: 0, scale: 1 };
  const n = crop.transformLayer(L, planFor(100, 50, { m: crop.M_CW }));
  // (x, y) → (H − y, x)
  assertClose(n.x, 30, 1e-9); assertClose(n.y, 10, 1e-9);
  assertClose(n.rotation, Math.PI / 2, 1e-9);
});

test('翻转：文字仍然正着读（不镜像），图片和表情会镜像', () => {
  const T = { id: 't', type: 'text', x: 10, y: 20, rotation: 0.3, scale: 1 };
  const I = { id: 'i', type: 'image', x: 10, y: 20, rotation: 0.3, scale: 1, flipX: false };
  for (const m of [crop.M_FLIP_H, crop.M_FLIP_V]) {
    const t = crop.transformLayer(T, planFor(100, 50, { m }));
    assertClose(t.rotation, -0.3, 1e-9, '文字角度');
    assert(!t.flipX, '文字不能镜像');
    const i = crop.transformLayer(I, planFor(100, 50, { m }));
    assertEq(i.flipX, true);
  }
  const h = crop.transformLayer(T, planFor(100, 50, { m: crop.M_FLIP_H }));
  assertClose(h.x, 90, 1e-9); assertClose(h.y, 20, 1e-9);
});

test('裁剪 + 缩小：图层位置减去裁剪起点并按比例缩放，大小也跟着缩', () => {
  const L = { id: 'e', type: 'emoji', x: 60, y: 40, rotation: 0, scale: 2 };
  const n = crop.transformLayer(L, planFor(200, 100, { crop: { x: 20, y: 10, w: 100, h: 60 }, out: { w: 50, h: 30 } }));
  assertClose(n.x, 20, 1e-9); assertClose(n.y, 15, 1e-9); assertClose(n.scale, 1, 1e-9);
});

suite('裁剪 / 应用与撤销');

function makeDoc() {
  const source = noise(90, 60, { seed: 21 });
  const doc = createDoc({ source, name: '裁剪测试' });
  doc.fg = noise(90, 60, { seed: 22 });
  doc.mask = noise(90, 60, { willRead: true, seed: 23, alpha: true });
  doc.maskAI = noise(90, 60, { willRead: true, seed: 24, alpha: true });
  doc.maskAI.__matte = { mode: 'general', ms: 600 };
  doc.cutout = true;
  doc.bg = { ...doc.bg, type: 'image', image: noise(40, 30, { seed: 25 }) };
  doc.layers = [{ id: 'L1', type: 'text', text: '你好', x: 30, y: 15, rotation: 0, scale: 1, opacity: 1, hidden: false }];
  return doc;
}
function snapshot(d) {
  return { w: d.width, h: d.height, source: data(d.source), fg: data(d.fg), mask: data(d.mask), maskAI: data(d.maskAI), layers: JSON.stringify(d.layers), bg: d.bg.image };
}
function sameSnap(a, b) {
  if (a.w !== b.w || a.h !== b.h || a.layers !== b.layers || a.bg !== b.bg) return false;
  for (const k of ['source', 'fg', 'mask', 'maskAI']) {
    if (a[k].length !== b[k].length) return false;
    for (let i = 0; i < a[k].length; i++) if (a[k][i] !== b[k][i]) return false;
  }
  return true;
}

test('裁剪 + 右转 + 翻转 = 一步撤销；所有图层平面一起变，背景图不变；撤销/重做像素完全一致', async () => {
  const doc = makeDoc();
  store.setDoc(doc);
  const orig = { source: doc.source, fg: doc.fg, mask: doc.mask, maskAI: doc.maskAI };
  const before = snapshot(doc);
  crop.resetCrop();
  crop.turn(1);                                   // 60 × 90 frame
  crop.setCropRect({ x: 10, y: 20, w: 40, h: 50 });
  crop.flip('h');                                 // mirrored box: x = 60 − 10 − 40 = 10
  assert(crop.isPending());
  const steps0 = store.historyInfo().undo;
  const ok = await crop.applyCrop();
  assert(ok, '应用失败');
  assertEq(store.historyInfo().undo, steps0 + 1, '应该只有一步撤销');
  assertEq(store.undoLabel(), '裁剪、翻转、旋转');
  const d = store.doc;
  assertEq(`${d.width}x${d.height}`, '40x50');
  for (const k of ['source', 'fg', 'mask', 'maskAI']) assertEq(`${d[k].width}x${d[k].height}`, '40x50', k);
  assert(d.mask.__willRead && d.maskAI.__willRead, '蒙版仍可快速读取');
  assertEq(d.maskAI.__matte?.mode, 'general', '保留 AI 抠图信息');
  assertEq(d.bg.image, before.bg, '背景图不受影响');
  assert(!crop.isPending(), '应用后没有待应用的修改');
  // reference: every plane = turn right → mirror → crop, done with plain canvas ops
  const ref = (c) => {
    const r = canvasOf(60, 90, (x) => { x.setTransform(0, 1, -1, 0, 60, 0); x.drawImage(c, 0, 0); });
    const f = canvasOf(60, 90, (x) => { x.setTransform(-1, 0, 0, 1, 60, 0); x.drawImage(r, 0, 0); });
    return canvasOf(40, 50, (x) => x.drawImage(f, -10, -20));
  };
  for (const k of ['source', 'fg', 'mask', 'maskAI']) assertEq(diffCount(d[k], ref(orig[k])), 0, `${k} 像素`);
  // the text layer followed the pixels and still reads upright-ish (turned, not mirrored)
  const L = d.layers[0];
  assertClose(L.x, 5, 1e-9); assertClose(L.y, 10, 1e-9);
  assertClose(Math.abs(L.rotation), Math.PI / 2, 1e-9);
  assert(!L.flipX);
  const after = snapshot(d);
  assert(store.undo());
  assert(sameSnap(snapshot(store.doc), before), '撤销后和原来不一样');
  for (const k of ['source', 'fg', 'mask', 'maskAI']) assertEq(store.doc[k], orig[k], `撤销后 ${k} 是原来的画布`);
  assert(store.redo());
  assert(sameSnap(snapshot(store.doc), after), '重做后和应用后不一样');
  assert(store.undo());
  assert(sameSnap(snapshot(store.doc), before), '再次撤销后和原来不一样');
});

test('拉直 + 改尺寸：一步完成，特效大小按比例缩放，撤销后完全还原', async () => {
  const doc = makeDoc();
  doc.edge = { feather: 10, shift: -6 };
  doc.fx.stroke.width = 12;
  store.setDoc(doc);
  const before = snapshot(doc);
  crop.resetCrop();
  crop.setStraighten(6);
  const c = crop.cropRectInt();
  assert(c.w < 90 && c.h < 60, '拉直后框应该自动缩小');
  assertClose(c.w / c.h, 1.5, 0.05);
  crop.setResize({ mode: 'long', v: 45 });
  const o = crop.outputSize();
  assertEq(o.w, 45);
  assert(await crop.applyCrop());
  const d = store.doc;
  assertEq(`${d.width}x${d.height}`, `${o.w}x${o.h}`);
  assertEq(store.undoLabel(), '拉直、改尺寸');
  const k = Math.sqrt((o.w / c.w) * (o.h / c.h));
  assertClose(d.edge.feather, 10 * k, 0.0005);
  assertEq(d.fx.stroke.width, Math.max(1, Math.round(12 * k)));
  const src = data(d.source);
  let minA = 255;
  for (let i = 3; i < src.length; i += 4) minA = Math.min(minA, src[i]);
  assertEq(minA, 255, '拉直后照片四角不能透明');
  assert(store.undo());
  assert(sameSnap(snapshot(store.doc), before));
  assertEq(store.doc.edge.feather, 10);
});

test('比例：选 3:4 后框是 3:4；右转后仍保持 3:4；自由比例的框跟着图片一起转', () => {
  store.setDoc(createDoc({ source: noise(120, 80, { seed: 31 }) }));
  crop.resetCrop();
  crop.setRatio('3:4');
  let s = crop.cropState();
  assertClose(s.crop.w / s.crop.h, 3 / 4, 1e-9);
  assertClose(s.crop.h, 80, 1e-6);
  crop.turn(1);
  s = crop.cropState();
  assertEq(`${s.W2}x${s.H2}`, '80x120');
  assertClose(s.crop.w / s.crop.h, 3 / 4, 1e-9);
  assertClose(s.crop.w, 80, 1e-6);
  crop.setRatio('free');
  crop.setCropRect({ x: 0, y: 0, w: 40, h: 30 });
  crop.turn(-1);                                   // back to 120 × 80: the top-left box goes to the bottom-left
  s = crop.cropState();
  assertEq(JSON.stringify(s.crop), JSON.stringify({ x: 0, y: 40, w: 30, h: 40 }));
  crop.setRatio('custom');
  crop.setCustomRatio(2, 1);
  s = crop.cropState();
  assertClose(s.crop.w / s.crop.h, 2, 1e-9);
  crop.cancelCrop();
  assert(!crop.isPending(), '取消后没有待应用的修改');
  assertEq(crop.cropState().ratio, 'free');
});

test('没有修改时「应用」什么也不做', async () => {
  store.setDoc(createDoc({ source: noise(30, 20, { seed: 41 }) }));
  crop.resetCrop();
  assert(!crop.isPending());
  assertEq(await crop.applyCrop(), false);
  assertEq(store.historyInfo().undo, 0);
});

test('发丝精修后改尺寸保留分数像素，撤销重做不丢精修', async () => {
  const doc = makeDoc();
  doc.edge = { feather: 0.5, shift: -0.25 };
  store.setDoc(doc);
  crop.resetCrop();
  crop.setResize({ mode: 'long', v: 45 });
  assert(await crop.applyCrop());
  assertEq(doc.edge.shift, -0.125, '四分之一像素收缩跟着尺寸减半');
  assertEq(doc.edge.feather, 0.25, '半像素羽化减半');
  store.undo();
  assertEq(doc.edge.shift, -0.25); assertEq(doc.edge.feather, 0.5);
  store.redo();
  assertEq(doc.edge.shift, -0.125); assertEq(doc.edge.feather, 0.25);
});

test('换背景＋调色＋文字贴纸＋裁剪导出，全程撤销重做还原每一步画面', async () => {
  const doc = makeDoc();
  doc.layers = [];
  store.setDoc(doc);
  const exactState = () => ({ ...snapshot(store.doc), params: JSON.stringify({
    name: store.doc.name, adjust: store.doc.adjust, edge: store.doc.edge, fx: store.doc.fx,
    bg: { ...store.doc.bg, image: null }, dpi: store.doc.dpi,
  }), layerPixels: store.doc.layers.filter((L) => L.canvas).map((L) => ({ id: L.id, data: pixels(L.canvas) })) });
  const frame = () => {
    const c = renderDoc(store.doc);
    return { width: c.width, height: c.height, data: pixels(c), state: exactState() };
  };
  const sameFrame = (actual, expected, label) => {
    assertEq(actual.width, expected.width, `${label} 宽度`);
    assertEq(actual.height, expected.height, `${label} 高度`);
    let count = 0, maxDiff = 0, first = null;
    for (let i = 0; i < expected.data.length; i++) {
      const diff = Math.abs(actual.data[i] - expected.data[i]);
      if (diff) { count++; maxDiff = Math.max(maxDiff, diff); first ??= { x: (i >> 2) % actual.width, y: Math.floor((i >> 2) / actual.width), channel: i % 4, actual: actual.data[i], expected: expected.data[i] }; }
    }
    // Chromium may round Canvas 2D premultiplied-alpha composition one level differently after
    // an RGB canvas has been used by WebGL. Source planes and document state must remain EXACT;
    // only the final browser-composited frame permits this verified one-level rounding difference.
    assert(maxDiff <= 1, `${label}：${count} 个通道不同，最大差 ${maxDiff}，首差 ${JSON.stringify(first)}`);
    if (actual.state) {
      assert(sameSnap(actual.state, expected.state), `${label}：像素平面、图层或背景引用没有精确恢复`);
      assertEq(actual.state.params, expected.state.params, `${label}：文档参数必须精确恢复`);
      assertEq(actual.state.layerPixels.length, expected.state.layerPixels.length, `${label}：图片图层数量`);
      for (let i = 0; i < expected.state.layerPixels.length; i++) {
        const a = actual.state.layerPixels[i], b = expected.state.layerPixels[i];
        assert(a.id === b.id && a.data.length === b.data.length && a.data.every((v, j) => v === b.data[j]), `${label}：图片图层像素必须精确恢复`);
      }
    }
  };
  const frames = [frame()];
  const record = (fn) => { fn(); frames.push(frame()); };
  record(() => store.commit('渐变背景', (d) => { Object.assign(d.bg, { type: 'gradient', color: '#ffe6d0', color2: '#2455bb', angle: 135 }); }));
  record(() => store.commit('滤镜和亮度', (d) => { Object.assign(d.adjust, { filter: 'warm', filterStrength: 45, brightness: 12, contrast: 9 }); }));
  const textLayer = createTextLayer({ text: '组合测试', x: 38, y: 20, fontSize: 12, color: '#ff2233' });
  record(() => addLayer(textLayer));
  const sticker = createImageLayer(canvasOf(16, 12, (c) => { c.fillStyle = '#00ff00'; c.fillRect(0, 0, 16, 12); }), { x: 30, y: 20, opacity: 0.75 });
  record(() => addLayer(sticker));
  record(() => updateLayer(textLayer.id, '旋转文字', (L) => { L.rotation = 0.15; L.scale = 0.9; }));
  record(() => moveLayerOrder(sticker.id, -1));
  record(() => toggleLayerHidden(sticker.id));
  record(() => toggleLayerHidden(sticker.id));
  crop.resetCrop(); crop.turn(1); crop.setCropRect({ x: 8, y: 12, w: 44, h: 64 }); crop.setResize({ mode: 'long', v: 48 });
  assert(await crop.applyCrop()); frames.push(frame());
  const exported = await blobToCanvasT(await exportDoc(doc, { format: 'png' }));
  sameFrame({ width: exported.width, height: exported.height, data: pixels(exported) }, frames.at(-1), '导出和最终成品画面一致');
  for (let i = frames.length - 2; i >= 0; i--) { assert(store.undo()); sameFrame(frame(), frames[i], `撤销回第 ${i} 步`); }
  assert(!store.canUndo(), '正好撤销全部操作');
  for (let i = 1; i < frames.length; i++) { assert(store.redo()); sameFrame(frame(), frames[i], `重做到第 ${i} 步`); }
  assert(!store.canRedo(), '正好重做全部操作');
});
