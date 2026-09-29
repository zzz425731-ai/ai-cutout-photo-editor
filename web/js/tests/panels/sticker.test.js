// tests/panels/sticker.test.js — emoji stickers render in canvas, emoji/image layer drawing (flip, opacity,
// glyph box), 自动抠图 subject extraction (fg patch + mask, trimmed) and alpha bounds.
import { suite, test, assert, assertEq, assertClose, canvasOf, px, pixels } from '../harness.js';
import { createCanvas } from '../../core/io.js';
import { createEmojiLayer, createImageLayer, drawLayer, layerSize, EMOJI_FONT } from '../../layers/render-layers.js';
import { EMOJI_CATEGORIES, subjectOnly, alphaBBox } from '../../panels/sticker.js';

function glyph(ch, size = 48, fill = '#000000') {
  const c = canvasOf(size * 2, size * 2);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.font = `${size}px ${EMOJI_FONT}`;
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.fillStyle = fill;
  x.fillText(ch, size, size);
  return { c, width: x.measureText(ch).width };
}
function signature(c) {
  const d = pixels(c);
  let ink = 0, hash = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 40) continue;
    ink++;
    hash = (hash * 31 + (d[i] >> 4) * 7 + (d[i + 1] >> 4) * 3 + (d[i + 2] >> 4) + i) >>> 0;
  }
  return { ink, hash };
}

suite('贴纸 / 表情');

test('8 类共约 120 个表情', () => {
  assertEq(EMOJI_CATEGORIES.length, 8);
  assertEq(EMOJI_CATEGORIES.map((c) => c.name).join(''), '常用表情爱心庆祝动物植物食物符号');
  const n = EMOJI_CATEGORIES.reduce((s, c) => s + c.list.length, 0);
  assert(n >= 110 && n <= 130, `共 ${n} 个`);
});

test('每个表情都能用彩色字体画到画布上（不是方块）', () => {
  const tofu = signature(glyph('\u{10FFFD}').c);
  const bad = [];
  for (const cat of EMOJI_CATEGORIES) {
    for (const ch of cat.list) {
      const red = glyph(ch, 48, '#ff0000'), blue = glyph(ch, 48, '#0000ff');
      const a = signature(red.c), b = signature(blue.c);
      // a colour-emoji glyph ignores fillStyle; a monochrome fallback glyph would take the fill colour
      const ok = a.ink > 300 && a.hash === b.hash && a.hash !== tofu.hash && red.width < 48 * 1.6;
      if (!ok) bad.push(`${cat.name}:${ch}(ink ${a.ink}, w ${Math.round(red.width)}, 彩色 ${a.hash === b.hash})`);
    }
  }
  assertEq(bad.join(' '), '', '画不出来的表情');
});

test('表情贴纸：图层框贴合字形，绘制在框内', () => {
  const L = createEmojiLayer({ char: '🐶', x: 100, y: 100, scale: 1.2 });
  const { w, h } = layerSize(L);
  assert(w > 90 && w < 140 && h > 90 && h < 140, `框 ${w.toFixed(1)}×${h.toFixed(1)}`);
  const c = canvasOf(200, 200);
  drawLayer(c.getContext('2d'), L, 1);
  const d = pixels(c);
  let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 30) continue;
    const p = i / 4, x = p % 200, y = (p / 200) | 0;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const hw = (w * 1.2) / 2, hh = (h * 1.2) / 2;
  assert(x0 >= 100 - hw - 1 && x1 <= 100 + hw + 1 && y0 >= 100 - hh - 1 && y1 <= 100 + hh + 1, '字形在框内');
  assert((x1 - x0) > hw * 1.6 && (y1 - y0) > hh * 1.6, '字形基本填满框');
  assertClose((x0 + x1) / 2, 100, 4, '水平居中'); assertClose((y0 + y1) / 2, 100, 4, '垂直居中');
});

suite('贴纸 / 图片图层');

const halves = () => canvasOf(40, 20, (x) => { x.fillStyle = '#ff0000'; x.fillRect(0, 0, 20, 20); x.fillStyle = '#0000ff'; x.fillRect(20, 0, 20, 20); });

test('水平翻转：左右颠倒', () => {
  const c = canvasOf(100, 60);
  drawLayer(c.getContext('2d'), createImageLayer(halves(), { x: 50, y: 30, scale: 2 }), 1);
  assert(px(c, 25, 30)[0] > 200, '不翻转时左边是红色');
  const f = canvasOf(100, 60);
  drawLayer(f.getContext('2d'), createImageLayer(halves(), { x: 50, y: 30, scale: 2, flipX: true }), 1);
  assert(px(f, 25, 30)[2] > 200 && px(f, 25, 30)[0] < 40, '翻转后左边是蓝色');
});

test('透明度和缩放', () => {
  const c = canvasOf(100, 60, (x) => { x.fillStyle = '#ffffff'; x.fillRect(0, 0, 100, 60); });
  drawLayer(c.getContext('2d'), createImageLayer(halves(), { x: 50, y: 30, scale: 1, opacity: 0.5 }), 1);
  const p = px(c, 40, 30);
  assertClose(p[1], 128, 3, '一半透明'); assertClose(p[0], 255, 2);
  assertEq(px(c, 20, 30).join(), '255,255,255,255', '缩放 1 时 40 宽，x=20 在外面');
});

suite('贴纸 / 自动抠图后添加');

test('subjectOnly：套用去色边补丁和蒙版，并裁掉透明边', () => {
  const pic = canvasOf(100, 80, (x) => { x.fillStyle = '#00ff00'; x.fillRect(0, 0, 100, 80); x.fillStyle = '#ff0000'; x.fillRect(30, 20, 40, 30); });
  const mask = createCanvas(100, 80, { willRead: true });
  const m = mask.getContext('2d'); m.fillStyle = '#000'; m.fillRect(30, 20, 40, 30); // alpha = subject
  const patch = canvasOf(2, 30, (x) => { x.fillStyle = '#ffff00'; x.fillRect(0, 0, 2, 30); });
  const out = subjectOnly(pic, { mask, fg: { canvas: patch, x: 30, y: 20 } });
  assertEq(`${out.width}x${out.height}`, '40x30', '裁到主体大小');
  assertEq(px(out, 20, 15).join(), '255,0,0,255', '主体颜色');
  assertEq(px(out, 0, 5).slice(0, 3).join(), '255,255,0', '去色边补丁生效');
  assertEq(subjectOnly(pic, { mask: createCanvas(100, 80, { willRead: true }), fg: null }), null, '没有主体时返回 null');
});

test('alphaBBox', () => {
  const c = createCanvas(50, 40, { willRead: true });
  assertEq(alphaBBox(c), null);
  c.getContext('2d').fillRect(10, 5, 7, 3);
  const b = alphaBBox(c);
  assertEq(`${b.x},${b.y},${b.w},${b.h}`, '10,5,7,3');
});
