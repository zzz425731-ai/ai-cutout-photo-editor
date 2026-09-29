import { suite, test, assert, assertEq } from './harness.js';
import { morph, edgeMask, edgeMargin, subRect, putRect, clampRect, expandRect } from '../core/maskops.js';

suite('发丝精修 / 亚像素收缩');

test('收缩四分之一像素仍保留单像素细发丝，且不修改原蒙版', () => {
  const src = new Uint8Array([0, 0, 255, 0, 0]);
  const out = morph(src, 5, 1, -0.25);
  assertEq(out[2], 191);
  assertEq(src[2], 255);
  assertEq(morph(src, 5, 1, -0.5)[2], 128);
  assertEq(morph(src, 5, 1, -0.75)[2], 64);
  assertEq(morph(src, 5, 1, -1)[2], 0);
});

test('正负小数收缩与扩展对称，边界不产生透明缝', () => {
  const src = new Uint8Array([0, 20, 100, 220, 255]);
  const inverse = src.map((v) => 255 - v);
  for (const radius of [0.1, 0.25, 0.75, 1.25, 2.75]) {
    const a = morph(src, 5, 1, radius), b = morph(inverse, 5, 1, -radius);
    assert(a.every((v, i) => Math.abs(v + b[i] - 255) <= 1));
  }
  assert(morph(new Uint8Array(25).fill(255), 5, 5, -0.75).every((v) => v === 255));
});

test('带小数收缩和羽化的画笔局部更新与完整重算一致', () => {
  const w = 81, h = 63;
  const src = Uint8Array.from({ length: w * h }, (_, i) => (i * 73 + 11) % 256);
  const dirty = { x: 30, y: 25, w: 7, h: 5 };
  for (const shift of [-1.25, -0.25, 0.75, 2.25]) {
    const before = edgeMask(src, w, h, shift, 2);
    const edited = src.slice();
    for (let y = 25; y < 30; y++) for (let x = 30; x < 37; x++) edited[y * w + x] = 0;
    const margin = edgeMargin(shift, 2);
    const inner = clampRect(expandRect(dirty, margin), w, h);
    const outer = clampRect(expandRect(inner, margin), w, h);
    const patch = edgeMask(subRect(edited, w, outer), outer.w, outer.h, shift, 2);
    putRect(before, w, patch, outer, inner);
    const expected = edgeMask(edited, w, h, shift, 2);
    assert(before.every((v, i) => v === expected[i]), `局部更新有接缝，shift=${shift}`);
  }
});
