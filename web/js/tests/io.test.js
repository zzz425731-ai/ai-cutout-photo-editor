import { suite, test, assert, assertEq, assertClose, assertRejects, canvasOf, px } from './harness.js';
import * as io from '../core/io.js';

// 4×3 canvas with distinct corner colours: TL red, TR green, BL blue, BR white
function corners() {
  return canvasOf(4, 3, (c) => {
    c.fillStyle = '#000'; c.fillRect(0, 0, 4, 3);
    c.fillStyle = '#ff0000'; c.fillRect(0, 0, 1, 1);
    c.fillStyle = '#00ff00'; c.fillRect(3, 0, 1, 1);
    c.fillStyle = '#0000ff'; c.fillRect(0, 2, 1, 1);
    c.fillStyle = '#ffffff'; c.fillRect(3, 2, 1, 1);
  });
}
const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];

suite('io / 图像操作');

test('裁剪尺寸与内容', () => {
  const c = io.cropCanvas(corners(), { x: 3, y: 0, w: 1, h: 3 });
  assertEq(c.width, 1); assertEq(c.height, 3);
  assert(same(px(c, 0, 0), [0, 255, 0, 255]), '右上应为绿色');
  const big = io.cropCanvas(corners(), { x: -2, y: -2, w: 8, h: 7 });
  assertEq(big.width, 8); assertEq(big.height, 7);
  assertEq(px(big, 0, 0)[3], 0, '超出部分透明');
  assert(same(px(big, 2, 2), [255, 0, 0, 255]), '原左上像素位置');
});

test('顺时针旋转 90°：宽高互换、左上→右上', () => {
  const c = io.rotateCanvas90(corners(), 1);
  assertEq(c.width, 3); assertEq(c.height, 4);
  assert(same(px(c, 2, 0), [255, 0, 0, 255]), `左上红色应到右上，实际 ${px(c, 2, 0)}`);
  assert(same(px(c, 0, 0), [0, 0, 255, 255]), '左下蓝色应到左上');
  const ccw = io.rotateCanvas90(corners(), -1);
  assert(same(px(ccw, 0, 3), [255, 0, 0, 255]), '逆时针：左上红色到左下');
  const r180 = io.rotateCanvas90(corners(), 2);
  assertEq(r180.width, 4);
  assert(same(px(r180, 3, 2), [255, 0, 0, 255]), '180°：左上到右下');
});

test('水平/垂直翻转', () => {
  const h = io.flipCanvas(corners(), 'h');
  assert(same(px(h, 3, 0), [255, 0, 0, 255]), '水平翻转');
  const v = io.flipCanvas(corners(), 'v');
  assert(same(px(v, 0, 2), [255, 0, 0, 255]), '垂直翻转');
  assertEq(v.width, 4); assertEq(v.height, 3);
});

test('缩放尺寸（含大比例缩小）', () => {
  const src = canvasOf(1000, 600, (c) => { c.fillStyle = '#3366cc'; c.fillRect(0, 0, 1000, 600); });
  const r = io.resizeCanvas(src, 100, 60);
  assertEq(r.width, 100); assertEq(r.height, 60);
  const p = px(r, 50, 30);
  assertClose(p[2], 0xcc, 2, '颜色保持');
  const up = io.resizeCanvas(src, 1200, 700);
  assertEq(up.width, 1200); assertEq(up.height, 700);
});

test('mapPlanes 对所有图层同时生效', () => {
  const doc = { source: canvasOf(10, 6), fg: null, mask: io.createCanvas(10, 6, { willRead: true }), maskAI: null };
  const r = io.mapPlanes(doc, (c) => io.rotateCanvas90(c, 1));
  assertEq(r.width, 6); assertEq(r.height, 10);
  assertEq(r.mask.width, 6);
  assert(r.fg === null && r.maskAI === null);
  assert(r.mask.__willRead, '蒙版保持可快速读取');
});

test('灰度 ⇄ 蒙版 转换', () => {
  const g = canvasOf(3, 1, (c) => { c.fillStyle = '#000'; c.fillRect(0, 0, 1, 1); c.fillStyle = '#808080'; c.fillRect(1, 0, 1, 1); c.fillStyle = '#fff'; c.fillRect(2, 0, 1, 1); });
  const m = io.maskFromGray(g);
  assertEq(px(m, 0, 0)[3], 0); assertClose(px(m, 1, 0)[3], 128, 1); assertEq(px(m, 2, 0)[3], 255);
  const back = io.grayFromMask(m);
  assertClose(px(back, 1, 0)[0], 128, 1); assertEq(px(back, 2, 0)[0], 255); assertEq(px(back, 0, 0)[3], 255);
  const a = io.readAlpha(m);
  assertEq(a.length, 3); assertEq(a[2], 255);
});

test('打开大图自动缩小到 4096 以内', async () => {
  const big = canvasOf(5000, 1000, (c) => { c.fillStyle = '#eee'; c.fillRect(0, 0, 5000, 1000); });
  const blob = await io.canvasToBlob(big, 'image/jpeg', 0.8);
  const f = new File([blob], '大图.jpg', { type: 'image/jpeg' });
  const c = await io.loadImageFile(f);
  assertEq(c.width, 4096); assertEq(c.height, 819);
  assert(c.meta.downscaled && c.meta.origWidth === 5000, '应标记已缩小');
  assertEq(c.meta.name, '大图');
});

test('带透明的 PNG 被识别', async () => {
  const t = canvasOf(20, 20, (c) => { c.fillStyle = '#f00'; c.fillRect(5, 5, 10, 10); });
  const f = new File([await io.canvasToBlob(t, 'image/png')], 'a.png', { type: 'image/png' });
  const c = await io.loadImageFile(f);
  assert(c.meta.hasAlpha, '应检测到透明');
  const { source, mask } = io.splitAlpha(c);
  assertEq(px(source, 0, 0)[3], 255, '源图不透明');
  assertEq(px(mask, 0, 0)[3], 0); assertEq(px(mask, 10, 10)[3], 255);
});

test('PNG 几乎不透明的软边仍保留透明度', async () => {
  const t = canvasOf(4, 1, (ctx) => ctx.fillRect(0, 0, 4, 1));
  const ctx = t.getContext('2d'), d = ctx.getImageData(0, 0, 4, 1);
  d.data[7] = 254;
  ctx.putImageData(d, 0, 0);
  const f = new File([await io.canvasToBlob(t)], '细软边.png', { type: 'image/png' });
  const loaded = await io.loadImageFile(f);
  assert(loaded.meta.hasAlpha, 'alpha=254 也必须识别为透明 PNG');
  assertEq(px(io.splitAlpha(loaded).mask, 1, 0)[3], 254, '保留原透明度');
});

test('大图奇数坐标上的一像素透明细线不会被漏检', () => {
  const t = canvasOf(2001, 2001, (ctx) => ctx.fillRect(0, 0, 2001, 2001));
  assert(!io.hasTransparency(t), '不透明大图');
  t.getContext('2d').clearRect(1999, 1999, 1, 1);
  assert(io.hasTransparency(t), '超过 400 万像素也需检查奇数行列');
});

test('非图片文件给出中文提示', async () => {
  const f = new File(['hello'], '说明.txt', { type: 'text/plain' });
  await assertRejects(io.loadImageFile(f), /不是图片/);
  const bad = new File([new Uint8Array([1, 2, 3, 4])], '坏图.jpg', { type: 'image/jpeg' });
  await assertRejects(io.loadImageFile(bad), /无法读取/);
  const heic = new File([new Uint8Array(8)], 'IMG_1.HEIC', { type: 'image/heic' });
  await assertRejects(io.loadImageFile(heic), /HEIC/);
});
