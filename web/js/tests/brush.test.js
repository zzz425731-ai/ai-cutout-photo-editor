import { suite, test, assert, assertEq, canvasOf, px } from './harness.js';
import { createBrushStroke, brushSizeStep } from '../core/brush.js';
import { morph, blurMask, distanceOutside, edgeMask } from '../core/maskops.js';
import { createCanvas } from '../core/io.js';

suite('画笔引擎');

test('保留画笔：沿线条填满，远处不受影响，返回撤销数据', () => {
  const m = createCanvas(100, 60, { willRead: true });
  const s = createBrushStroke({ plane: m, mode: 'paint', size: 10, hardness: 0.8 });
  for (let x = 10; x <= 90; x += 7) s.addPoint(x, 30);
  const res = s.end();
  assertEq(px(m, 50, 30)[3], 255, '线条中心');
  assertEq(px(m, 50, 45)[3], 0, '远处');
  assert(px(m, 50, 33)[3] > 200, '半径内');
  assert(px(m, 50, 35)[3] < 60, '半径外缘柔和');
  assert(res.rect.x <= 6 && res.rect.x + res.rect.w >= 91, `外框 ${JSON.stringify(res.rect)}`);
  assertEq(res.before.data[((30 - res.rect.y) * res.rect.w + (50 - res.rect.x)) * 4 + 3], 0, 'before 为原始像素');
  assertEq(res.after.width, res.rect.w);
});

test('笔触内重叠不累加（软画笔边缘一致）', () => {
  const a = createCanvas(80, 40, { willRead: true });
  const s1 = createBrushStroke({ plane: a, mode: 'paint', size: 20, hardness: 0, opacity: 0.5 });
  for (let i = 0; i < 20; i++) s1.addPoint(40 + (i % 2), 20); // scribble in place
  s1.end();
  assert(px(a, 40, 20)[3] <= 130, `重复涂抹不超过不透明度 ${px(a, 40, 20)[3]}`);
});

test('擦除画笔与取消', () => {
  const m = createCanvas(50, 50, { willRead: true });
  m.getContext('2d').fillRect(0, 0, 50, 50);
  const s = createBrushStroke({ plane: m, mode: 'erase', size: 12, hardness: 1 });
  s.addPoint(25, 25); s.addPoint(30, 25);
  assertEq(px(m, 25, 25)[3], 0, '擦除');
  s.cancel();
  assertEq(px(m, 25, 25)[3], 255, '取消后恢复');
});

test('图案画笔（马赛克/模糊用）', () => {
  const plane = canvasOf(40, 40, (c) => { c.fillStyle = '#ff0000'; c.fillRect(0, 0, 40, 40); });
  const pat = canvasOf(40, 40, (c) => { c.fillStyle = '#0000ff'; c.fillRect(0, 0, 40, 40); });
  const s = createBrushStroke({ plane, mode: 'pattern', pattern: pat, size: 10, hardness: 1 });
  s.addPoint(20, 20);
  s.end();
  assertEq(px(plane, 20, 20).join(), '0,0,255,255');
  assertEq(px(plane, 2, 2).join(), '255,0,0,255');
});

test('[ ] 调整画笔大小', () => {
  assert(brushSizeStep(40, 1) > 40 && brushSizeStep(40, -1) < 40);
  assertEq(brushSizeStep(2, -1), 2, '下限');
  assertEq(brushSizeStep(800, 1), 800, '上限');
});

suite('蒙版运算');

test('膨胀/腐蚀接近圆形且可逆', () => {
  const w = 41, h = 41;
  const a = new Uint8Array(w * h);
  a[20 * w + 20] = 255;
  const d = morph(a, w, h, 10);
  assertEq(d[20 * w + 30], 255, '水平半径 10');
  assertEq(d[20 * w + 31], 0);
  assertEq(d[27 * w + 27], 255, '对角 ≈ 9.9');
  assertEq(d[29 * w + 29], 0, '对角 12.7 之外（不是方形）');
  const e = morph(d, w, h, -10);
  let n = 0; for (const v of e) if (v) n++;
  assertEq(n, 1, '腐蚀回单点');
});

test('模糊在图像边界处不褪色', () => {
  const a = new Uint8Array(30 * 20).fill(255);
  const b = blurMask(a, 30, 20, 5);
  assertEq(b[0], 255); assertEq(b[29], 255); assertEq(b[19 * 30], 255);
});

test('距离变换', () => {
  const w = 20, h = 10;
  const bin = new Uint8Array(w * h);
  bin[5 * w + 5] = 1;
  const d = distanceOutside(bin, w, h);
  assertEq(d[5 * w + 5], 0);
  assertEq(d[5 * w + 8], 9);
  assertEq(d[8 * w + 9], 25);
});

test('edgeMask 组合', () => {
  const w = 30, h = 30;
  const a = new Uint8Array(w * h);
  for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) a[y * w + x] = 255;
  const r = edgeMask(a, w, h, 2, 0);
  assertEq(r[15 * w + 8], 255); assertEq(r[15 * w + 7], 0);
  const f = edgeMask(a, w, h, 0, 4);
  assert(f[15 * w + 10] < 255 && f[15 * w + 9] > 0, '羽化');
});
