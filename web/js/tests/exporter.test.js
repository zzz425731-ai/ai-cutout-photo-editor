import { suite, test, assert, assertEq, canvasOf, px, blobToCanvasT } from './harness.js';
import { exportDoc, docHasTransparency, defaultSaveFormat, suggestFilename } from '../core/exporter.js';
import { createDoc, bumpCanvas } from '../core/store.js';
import { createCanvas } from '../core/io.js';

function cutDoc() {
  const src = canvasOf(120, 80, (c) => { c.fillStyle = '#2255aa'; c.fillRect(0, 0, 120, 80); });
  const doc = createDoc({ source: src, name: '宝宝' });
  doc.mask = createCanvas(120, 80, { willRead: true });
  doc.mask.getContext('2d').fillRect(30, 20, 60, 40);
  doc.cutout = true;
  doc.bg.type = 'transparent';
  return doc;
}

suite('导出');

test('PNG 保留透明', async () => {
  const doc = cutDoc();
  const blob = await exportDoc(doc, { format: 'png' });
  assertEq(blob.type, 'image/png');
  const c = await blobToCanvasT(blob);
  assertEq(c.width, 120); assertEq(c.height, 80);
  assertEq(px(c, 2, 2)[3], 0, '角落透明');
  assertEq(px(c, 60, 40)[3], 255, '主体不透明');
});

test('缩小 PNG 导出保留发丝强度且不偏移', async () => {
  const doc = createDoc({ source: canvasOf(3, 3, (c) => {
    c.fillStyle = '#fff'; c.fillRect(0, 0, 3, 3);
    c.fillStyle = '#ff0000'; c.fillRect(1, 0, 1, 3);
  }) });
  doc.mask = canvasOf(3, 3, (c) => c.fillRect(1, 0, 1, 3));
  doc.cutout = true; doc.bg.type = 'transparent';
  const c = await blobToCanvasT(await exportDoc(doc, { format: 'png', maxSide: 2 }));
  assertEq(c.width, 2); assertEq(c.height, 2);
  assertEq(px(c, 0, 0).join(), '255,0,0,85', '左侧软发丝');
  assertEq(px(c, 1, 0).join(), '255,0,0,85', '右侧软发丝');
});

test('JPG 透明部分变白色', async () => {
  const blob = await exportDoc(cutDoc(), { format: 'jpg', quality: 90 });
  assertEq(blob.type, 'image/jpeg');
  const c = await blobToCanvasT(blob);
  const p = px(c, 2, 2);
  assert(p[0] > 248 && p[1] > 248 && p[2] > 248 && p[3] === 255, `角落 ${p}`);
  const s = px(c, 60, 40);
  assert(s[2] > 150 && s[0] < 60, `主体颜色 ${s}`);
});

test('WebP 保留透明、长边限制', async () => {
  const blob = await exportDoc(cutDoc(), { format: 'webp', quality: 0.9, maxSide: 60 });
  assertEq(blob.type, 'image/webp');
  const c = await blobToCanvasT(blob);
  assertEq(c.width, 60); assertEq(c.height, 40);
  assert(px(c, 1, 1)[3] < 10, '透明');
});

test('长边大于原图时不放大', async () => {
  const c = await blobToCanvasT(await exportDoc(cutDoc(), { format: 'png', maxSide: 4000 }));
  assertEq(c.width, 120);
});

test('保存格式与文件名', () => {
  const doc = cutDoc();
  assert(docHasTransparency(doc));
  assertEq(defaultSaveFormat(doc), 'png');
  assertEq(suggestFilename(doc, 'png'), '宝宝_抠图.png');
  doc.bg.type = 'color';
  assertEq(defaultSaveFormat(doc), 'jpg');
  doc.cutout = false;
  assertEq(suggestFilename(doc, 'jpg'), '宝宝_编辑.jpg');
  doc.name = 'a/b:c*?';
  assertEq(suggestFilename(doc, 'jpg'), 'abc_编辑.jpg');
});

test('透明图片作背景时自动保存 PNG，保留背景透明部分', async () => {
  const doc = cutDoc();
  doc.bg.type = 'image';
  doc.bg.image = canvasOf(120, 80, (c) => { c.fillStyle = '#00ff00'; c.fillRect(100, 0, 20, 80); });
  assertEq(defaultSaveFormat(doc), 'png', '图片背景本身透明时不能自动选 JPG');
  const blob = await exportDoc(doc, { format: defaultSaveFormat(doc) });
  assertEq(blob.type, 'image/png');
  const out = await blobToCanvasT(blob);
  assertEq(px(out, 2, 2)[3], 0, '背景透明区仍透明');
  assertEq(px(out, 110, 2).join(), '0,255,0,255', '背景有内容的部分保留');
  doc.bg.image.getContext('2d').fillRect(0, 0, 120, 80); bumpCanvas(doc.bg.image);
  assertEq(defaultSaveFormat(doc), 'jpg', '不透明图片背景仍自动保存 JPG，缓存更新');
  doc.bg.image = null;
  assertEq(defaultSaveFormat(doc), 'jpg', '缺失图片背景按渲染器的白底处理');
});
