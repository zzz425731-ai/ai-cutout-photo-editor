// tests/panels/mosaic.test.js — 打码: mosaic / blur maths, region edits on source + fg as one undo step,
// brushes (马赛克笔 / 涂鸦 / 荧光笔), face tiling / merging / regions, detectFaces with a fake detector.
import { suite, test, assert, assertEq, assertClose, canvasOf, px, pixels } from '../harness.js';
import { store, createDoc } from '../../core/store.js';
import { setTool } from '../../core/tools.js';
import { cloneCanvas } from '../../core/io.js';
import { blockFor, sigmaFor, clampPad, pixelateRegion, blurRegion, mergeRects, applyRegions, applyBox, mosaicSettings, mosaicBrush } from '../../tools/mosaic-brush.js';
import { doodleBrush, HIGHLIGHTER_OPACITY } from '../../tools/doodle-brush.js';
import { tileRects, mergeFaces, faceRegion, faceEmoji, detectFaces } from '../../panels/mosaic.js';

// deterministic "photo": gradients + per-pixel noise
function photo(w, h) {
  return canvasOf(w, h, (c) => {
    const id = c.createImageData(w, h);
    let s = 7;
    for (let i = 0, p = 0; i < id.data.length; i += 4, p++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const x = p % w, y = (p / w) | 0, n = (s >> 16) % 40;
      id.data[i] = (x * 255 / w + n) | 0; id.data[i + 1] = (y * 255 / h + n) | 0; id.data[i + 2] = (128 + n) | 0; id.data[i + 3] = 255;
    }
    c.putImageData(id, 0, 0);
  });
}
function rectData(c, r) { return c.getContext('2d', { willReadFrequently: true }).getImageData(r.x, r.y, r.w, r.h).data; }
function sameRect(a, b, r) { const x = rectData(a, r), y = rectData(b, r); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false; return true; }
function minAlpha(c) { const d = pixels(c); let m = 255; for (let i = 3; i < d.length; i += 4) m = Math.min(m, d[i]); return m; }
function newDoc(w = 240, h = 180, withFg = true) {
  const src = photo(w, h);
  const doc = createDoc({ source: src, name: '打码测试' });
  if (withFg) doc.fg = cloneCanvas(src);
  store.setDoc(doc);
  return doc;
}

suite('打码 / 马赛克与模糊');

test('强度 → 格子 / 模糊半径随图片大小和强度增大', () => {
  assert(blockFor(80, 1000, 800) > blockFor(20, 1000, 800), '强度越大格子越大');
  assert(blockFor(50, 4000, 3000) > blockFor(50, 800, 600), '大图格子大');
  assert(blockFor(1, 100, 100) >= 3, '最小 3 px');
  assert(sigmaFor(80, 1000, 800) > sigmaFor(20, 1000, 800), '模糊随强度');
});

test('边缘外补齐 = 复制最边上的像素', () => {
  const src = photo(40, 30);
  const p = clampPad(src, { x: -5, y: -4, w: 50, h: 40 });
  assertEq(px(p, 0, 0).join(), px(src, 0, 0).join(), '左上角');
  assertEq(px(p, 49, 39).join(), px(src, 39, 29).join(), '右下角');
  assertEq(px(p, 20, 0).join(), px(src, 15, 0).join(), '上边');
  assertEq(px(p, 10, 10).join(), px(src, 5, 6).join(), '中间原样');
});

test('马赛克：每格同色、约等于格内平均、不透明', () => {
  const src = photo(96, 64);
  const b = 16;
  const m = pixelateRegion(src, { x: 0, y: 0, w: 96, h: 64 }, b);
  assertEq(minAlpha(m), 255, '不透明');
  const d = pixels(m), s = pixels(src);
  for (const [bx, by] of [[0, 0], [2, 1], [5, 3]]) {
    const c0 = px(m, bx * b, by * b);
    assertEq(px(m, bx * b + b - 1, by * b + b - 1).join(), c0.join(), `格 ${bx},${by} 同色`);
    let r = 0, g = 0;
    for (let y = by * b; y < by * b + b; y++) for (let x = bx * b; x < bx * b + b; x++) { const i = (y * 96 + x) * 4; r += s[i]; g += s[i + 1]; }
    assertClose(c0[0], r / (b * b), 10, '红色均值');
    assertClose(c0[1], g / (b * b), 10, '绿色均值');
  }
  assert(d.length === s.length);
});

test('马赛克：不整除的边缘格也正常（不透明、不发黑）', () => {
  const src = canvasOf(50, 37, (c) => { c.fillStyle = '#c86432'; c.fillRect(0, 0, 50, 37); });
  const m = pixelateRegion(src, { x: 3, y: 2, w: 47, h: 35 }, 12);
  assertEq(minAlpha(m), 255);
  assertEq(px(m, 46, 34).join(), '200,100,50,255', '右下角边缘格颜色正确');
});

test('模糊：整块不透明（图片边缘也是）、变平滑、颜色不偏', () => {
  const src = photo(120, 90);
  const R = { x: 0, y: 0, w: 120, h: 90 };
  const bl = blurRegion(src, R, 8);
  assertEq(minAlpha(bl), 255, '不透明');
  const std = (c) => { const d = pixels(c); let s = 0, s2 = 0, n = 0; for (let i = 2; i < d.length; i += 4) { s += d[i]; s2 += d[i] * d[i]; n++; } return Math.sqrt(s2 / n - (s / n) ** 2); };
  assert(std(bl) < std(src) * 0.5, '蓝色噪点被抹平');
  assertClose(px(bl, 0, 0)[0], px(src, 2, 2)[0], 25, '角上颜色不发黑');
  const big = blurRegion(src, { x: 30, y: 20, w: 50, h: 40 }, 40);
  assertEq(minAlpha(big), 255, '大半径也不透明');
});

test('合并重叠的矩形', () => {
  const m = mergeRects([{ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }, { x: 40, y: 40, w: 5, h: 5 }]);
  assertEq(m.length, 2);
  assertEq(JSON.stringify(m[0]), JSON.stringify({ x: 0, y: 0, w: 15, h: 15 }));
});

suite('打码 / 改照片（原图 + 去色边副本）');

test('框选打码：只改框内，原图和 fg 一起改，一步撤销 / 重做', () => {
  const doc = newDoc();
  const s0 = cloneCanvas(doc.source), f0 = cloneCanvas(doc.fg);
  mosaicSettings().block = 60;
  assert(applyBox({ x: 40, y: 30, w: 80, h: 60 }, 'mosaic'));
  assertEq(store.undoLabel(), '框选马赛克');
  assertEq(store.historyInfo().undo, 1, '一步');
  assert(!sameRect(doc.source, s0, { x: 40, y: 30, w: 80, h: 60 }), '框内变了');
  assert(sameRect(doc.source, s0, { x: 130, y: 0, w: 110, h: 180 }), '框外没变');
  assert(sameRect(doc.source, doc.fg, { x: 0, y: 0, w: 240, h: 180 }), 'fg 同步');
  const after = cloneCanvas(doc.source);
  store.undo();
  assert(sameRect(doc.source, s0, { x: 0, y: 0, w: 240, h: 180 }) && sameRect(doc.fg, f0, { x: 0, y: 0, w: 240, h: 180 }), '撤销还原两张');
  store.redo();
  assert(sameRect(doc.source, after, { x: 0, y: 0, w: 240, h: 180 }), '重做');
});

test('人脸区域：椭圆打码，框角不动；多张脸重叠也只算一步且能完整撤销', () => {
  const doc = newDoc(300, 200);
  const s0 = cloneCanvas(doc.source);
  const f1 = { x: 60, y: 60, w: 50, h: 60 }, f2 = { x: 95, y: 70, w: 50, h: 60 }, f3 = { x: 220, y: 40, w: 40, h: 40 };
  const regs = [f1, f2, f3].map((f) => faceRegion(f, 'blur', 70));
  assert(applyRegions('人脸模糊', regs, { kind: 'blur' }));
  assertEq(store.historyInfo().undo, 1, '一步');
  const e = regs[2].ellipse;
  const c = px(doc.source, Math.round(e.cx), Math.round(e.cy)), c0 = px(s0, Math.round(e.cx), Math.round(e.cy));
  assert(c.join() !== c0.join(), '脸中间变了');
  const r = regs[2].rect;
  assertEq(px(doc.source, Math.ceil(r.x) + 1, Math.ceil(r.y) + 1).join(), px(s0, Math.ceil(r.x) + 1, Math.ceil(r.y) + 1).join(), '椭圆外的框角没变');
  assertEq(minAlpha(doc.source), 255, '照片仍不透明');
  store.undo();
  assert(sameRect(doc.source, s0, { x: 0, y: 0, w: 300, h: 200 }), '撤销完整还原');
});

test('马赛克笔：一笔一步，fg 跟着改，撤销还原', () => {
  const doc = newDoc();
  const s0 = cloneCanvas(doc.source);
  store.ui.brush.size = 30;
  setTool('mosaic-brush', { kind: 'mosaic' });
  mosaicBrush.onPointerDown({ x: 30, y: 90 });
  mosaicBrush.onPointerMove({ x: 120, y: 95 });
  mosaicBrush.onPointerUp({ x: 200, y: 90 });
  assertEq(store.undoLabel(), '马赛克笔');
  assertEq(store.historyInfo().undo, 1);
  assert(!sameRect(doc.source, s0, { x: 60, y: 85, w: 100, h: 10 }), '涂过的地方变了');
  assert(sameRect(doc.source, s0, { x: 0, y: 0, w: 240, h: 40 }), '别处没变');
  assert(sameRect(doc.source, doc.fg, { x: 0, y: 0, w: 240, h: 180 }), 'fg 同步');
  store.undo();
  assert(sameRect(doc.source, s0, { x: 0, y: 0, w: 240, h: 180 }), '撤销');
  setTool('pan');
});

test('涂鸦：画上颜色；荧光笔半透明透出底图', () => {
  const src = canvasOf(200, 100, (c) => { c.fillStyle = '#ffffff'; c.fillRect(0, 0, 200, 100); });
  store.setDoc(createDoc({ source: src }));
  const s = mosaicSettings();
  s.color = '#0a84ff'; s.highlighter = false;
  store.ui.brush.size = 16;
  setTool('doodle-brush');
  doodleBrush.onPointerDown({ x: 20, y: 30 });
  doodleBrush.onPointerUp({ x: 180, y: 30 });
  assertEq(px(store.doc.source, 100, 30).join(), '10,132,255,255', '实心颜色');
  assertEq(store.undoLabel(), '涂鸦');
  s.highlighter = true;
  doodleBrush.onPointerDown({ x: 20, y: 70 });
  doodleBrush.onPointerUp({ x: 180, y: 70 });
  const p = px(store.doc.source, 100, 70);
  assertClose(p[0], 255 + (10 - 255) * HIGHLIGHTER_OPACITY, 3, '荧光笔红通道');
  assertEq(p[3], 255, '仍不透明');
  assertEq(store.undoLabel(), '荧光笔');
  assertEq(store.historyInfo().undo, 2, '两笔两步');
  s.highlighter = false; s.color = '#ff3b30';
  setTool('pan');
});

suite('打码 / 一键人脸');

test('分块覆盖整张图并互相重叠；小图只有一块', () => {
  assertEq(tileRects(1000, 800).length, 1);
  const t = tileRects(4000, 3000);
  assert(t.length >= 4 && t.length <= 12, `${t.length} 块`);
  for (const [x, y] of [[0, 0], [3999, 2999], [2000, 1500], [3999, 0]]) assert(t.some((r) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h), `覆盖 ${x},${y}`);
  const a = t[0], b = t[1];
  assert(b.x < a.x + a.w, '相邻块重叠');
});

test('同一张脸的多次识别合成一个框（取并集），不同的脸保留', () => {
  const m = mergeFaces([
    { x: 100, y: 100, w: 50, h: 60, score: 0.9 },
    { x: 104, y: 98, w: 48, h: 64, score: 0.8 },
    { x: 110, y: 110, w: 20, h: 30, score: 0.95 },
    { x: 400, y: 100, w: 30, h: 30, score: 0.7 },
  ]);
  assertEq(m.length, 2);
  assertEq([m[0].x, m[0].y, m[0].x + m[0].w, m[0].y + m[0].h].join(), '100,98,152,162', '并集');
});

test('人脸区域盖住脸框，强度越大格子越大', () => {
  const f = { x: 100, y: 80, w: 60, h: 70 };
  const r = faceRegion(f, 'mosaic', 60);
  assert(r.rect.x < f.x && r.rect.y < f.y && r.rect.x + r.rect.w > f.x + f.w && r.rect.y + r.rect.h > f.y + f.h, '盖住脸框');
  assert(faceRegion(f, 'mosaic', 100).param > faceRegion(f, 'mosaic', 10).param);
  assert(faceRegion(f, 'blur', 100).param > faceRegion(f, 'blur', 10).param);
  const e = faceEmoji(f, '😊');
  assert(e.size >= 70 * 1.4 && e.char === '😊' && Math.abs(e.x - 130) < 1, '表情大小 / 位置');
});

test('识别：大图分块后坐标换回整图，重复的脸合并', async () => {
  const src = canvasOf(3200, 1800, (c) => { c.fillStyle = '#777'; c.fillRect(0, 0, 3200, 1800); });
  const calls = [];
  // fake detector: "sees" a face at doc (2500, 900, 40, 40) when that spot is inside the image it gets
  const detect = async (blob) => {
    const bmp = await createImageBitmap(blob);
    const call = calls.length;
    calls.push([bmp.width, bmp.height]);
    if (call === 0) return { faces: [{ x: 1000, y: 500, w: 200, h: 220, score: 0.9 }] }; // whole photo: one big face
    const t = tileRects(3200, 1800)[call - 1];
    const out = [];
    if (2500 >= t.x && 2540 <= t.x + t.w && 900 >= t.y && 940 <= t.y + t.h) out.push({ x: 2500 - t.x, y: 900 - t.y, w: 40, h: 40, score: 0.8 });
    return { faces: out };
  };
  const faces = await detectFaces(src, { detect });
  assertEq(calls.length, 1 + tileRects(3200, 1800).length, '整图一次 + 每块一次');
  assertEq(faces.length, 2, '大脸 + 小脸（多块重复识别已合并）');
  const small = faces.find((f) => f.w < 100);
  assertEq([Math.round(small.x), Math.round(small.y)].join(), '2500,900', '坐标换回整图');
});

test('识别：小图会放大再找一次，坐标换回原图', async () => {
  const src = canvasOf(640, 400);
  const sizes = [];
  const detect = async (blob) => {
    const bmp = await createImageBitmap(blob);
    sizes.push(bmp.width);
    return { faces: sizes.length === 2 ? [{ x: 200, y: 100, w: 40, h: 40, score: 0.8 }] : [] };
  };
  const faces = await detectFaces(src, { detect });
  assertEq(sizes.join(), '640,1280');
  assertEq(faces.length, 1);
  assertClose(faces[0].x, 100, 0.01); assertClose(faces[0].w, 20, 0.01);
});
