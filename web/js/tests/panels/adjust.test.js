// tests/panels/adjust.test.js — 调色 panel: 一键优化 (auto tone / colour), filter table & order, filter thumbnails.
import { suite, test, assert, assertEq, canvasOf, pixels, stats } from '../harness.js';
import { analyzePhoto, autoParams, castNeed, AUTO_KEYS, FILTER_ORDER, filterThumbBase } from '../../panels/adjust.js';
import { applyAdjust, FILTERS } from '../../core/adjust.js';
import { DEFAULT_ADJUST, bumpCanvas } from '../../core/store.js';

// a small, well exposed "photo": sky, grass, a grey wall, white paper, a black object, a face-coloured disc, a red ball
const WALL = { x: 12, y: 50, w: 40, h: 30 };
function scene(w = 160, h = 120) {
  return canvasOf(w, h, (c) => {
    let g = c.createLinearGradient(0, 0, 0, h * 0.45);
    g.addColorStop(0, '#8fb9e6'); g.addColorStop(1, '#d8e8f5');
    c.fillStyle = g; c.fillRect(0, 0, w, h * 0.45);
    g = c.createLinearGradient(0, h * 0.45, 0, h);
    g.addColorStop(0, '#7aa352'); g.addColorStop(1, '#3f6a24');
    c.fillStyle = g; c.fillRect(0, h * 0.45, w, h * 0.55);
    c.fillStyle = '#7e7c79'; c.fillRect(0, h * 0.8, w, h * 0.2);    // pavement
    c.fillStyle = '#8c8c8c'; c.fillRect(WALL.x, WALL.y, WALL.w, WALL.h);
    c.fillStyle = '#f4f4f2'; c.fillRect(60, 60, 26, 18);
    c.fillStyle = '#141414'; c.fillRect(96, 70, 22, 30);
    c.fillStyle = '#d7a286'; c.beginPath(); c.arc(130, 40, 16, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#c3362c'; c.beginPath(); c.arc(40, 100, 9, 0, Math.PI * 2); c.fill();
    // a little texture so it is not perfectly flat
    const id = c.getImageData(0, 0, w, h);
    for (let i = 0; i < id.data.length; i += 4) { const n = ((i * 2654435761) >>> 24) / 64 - 2; id.data[i] += n; id.data[i + 1] += n; id.data[i + 2] += n; }
    c.putImageData(id, 0, 0);
  });
}
function mapPx(src, fn) {
  const c = canvasOf(src.width, src.height, (x) => x.drawImage(src, 0, 0));
  const x = c.getContext('2d', { willReadFrequently: true });
  const id = x.getImageData(0, 0, c.width, c.height);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const o = fn(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255);
    d[i] = o[0] * 255; d[i + 1] = o[1] * 255; d[i + 2] = o[2] * 255;
  }
  x.putImageData(id, 0, 0);
  return c;
}
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const auto = (c) => autoParams(analyzePhoto(c));
const fix = (c) => applyAdjust(c, { ...DEFAULT_ADJUST, ...auto(c) });
function wallCast(c) { // mean B − R on the grey wall (0..255)
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(WALL.x + 4, WALL.y + 4, WALL.w - 8, WALL.h - 8).data;
  let s = 0;
  for (let i = 0; i < d.length; i += 4) s += d[i + 2] - d[i];
  return s / (d.length / 4);
}
const effort = (p) => AUTO_KEYS.reduce((s, k) => s + Math.abs(p[k]), 0);

suite('调色面板 / 一键优化');

test('曝光正常的照片几乎不动', () => {
  const p = auto(scene());
  assert(effort(p) <= 30, `调整量 ${effort(p)}：${JSON.stringify(p)}`);
  assertEq(p.exposure, 0, '曝光');
  assert(Math.abs(p.temperature) <= 8 && Math.abs(p.tint) <= 8, `色温/色调 ${p.temperature}/${p.tint}`);
});

test('偏暗的照片：提亮，接近正常曝光', () => {
  const good = scene();
  const dark = mapPx(good, (r, g, b) => [r * 0.42, g * 0.42, b * 0.42]);
  const p = auto(dark);
  assert(p.exposure > 30, `曝光 ${p.exposure}`);
  const m0 = stats(good).mean, md = stats(dark).mean, mf = stats(fix(dark)).mean;
  assert(Math.abs(mf - m0) < Math.abs(md - m0) * 0.4, `亮度 原 ${m0.toFixed(1)} 暗 ${md.toFixed(1)} → ${mf.toFixed(1)}`);
});

test('发灰的照片：对比度拉开', () => {
  const dull = mapPx(scene(), (r, g, b) => {
    const L = luma(r, g, b);
    const f = (v) => 0.5 + ((L + (v - L) * 0.6) - 0.5) * 0.5 + 0.04;
    return [f(r), f(g), f(b)];
  });
  const p = auto(dull);
  assert(p.contrast >= 30, `对比度 ${p.contrast}`);
  const s0 = stats(dull).std, s1 = stats(fix(dull)).std;
  assert(s1 > s0 * 1.25, `明暗反差 ${s0.toFixed(1)} → ${s1.toFixed(1)}`);
});

test('偏蓝的照片：色温往暖调，灰墙更接近中性', () => {
  const blue = mapPx(scene(), (r, g, b) => [r * 0.84, g, Math.min(1, b * 1.14)]);
  const p = auto(blue);
  assert(p.temperature >= 15, `色温 ${p.temperature}`);
  const before = wallCast(blue), after = wallCast(fix(blue));
  assert(Math.abs(after) < Math.abs(before) * 0.6, `灰墙偏蓝 ${before.toFixed(1)} → ${after.toFixed(1)}`);
});

// an indoor room (tungsten light never lights a blue sky): light wall, grey sofa (WALL rect), wooden table,
// dark floor, a face, a plant and a sheet of paper
function room(w = 160, h = 120) {
  return canvasOf(w, h, (c) => {
    c.fillStyle = '#e4e1dc'; c.fillRect(0, 0, w, h * 0.7);
    c.fillStyle = '#3b3532'; c.fillRect(0, h * 0.7, w, h * 0.3);
    c.fillStyle = '#8c8c8c'; c.fillRect(WALL.x, WALL.y, WALL.w, WALL.h);
    c.fillStyle = '#8a5a3a'; c.fillRect(64, 72, 50, 16);
    c.fillStyle = '#f4f4f2'; c.fillRect(70, 64, 20, 8);
    c.fillStyle = '#d7a286'; c.beginPath(); c.arc(130, 40, 14, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#4f7a3a'; c.beginPath(); c.arc(140, 80, 10, 0, Math.PI * 2); c.fill();
    const id = c.getImageData(0, 0, w, h);
    for (let i = 0; i < id.data.length; i += 4) { const n = ((i * 2654435761) >>> 24) / 64 - 2; id.data[i] += n; id.data[i + 1] += n; id.data[i + 2] += n; }
    c.putImageData(id, 0, 0);
  });
}

test('偏黄（钨丝灯）的室内照片：色温往冷调', () => {
  const warm = mapPx(room(), (r, g, b) => [Math.min(1, r * 1.12), g * 0.98, b * 0.78]);
  const p = auto(warm);
  assert(p.temperature <= -10, `色温 ${p.temperature}`);
  const before = wallCast(warm), after = wallCast(fix(warm));
  assert(Math.abs(after) < Math.abs(before) * 0.8, `沙发偏黄 ${before.toFixed(1)} → ${after.toFixed(1)}`);
  const ok = auto(room());
  assert(Math.abs(ok.temperature) <= 8 && Math.abs(ok.tint) <= 8, `正常的室内照片 色温/色调 ${ok.temperature}/${ok.tint}`);
});

test('照片里的颜色方向互相矛盾时不乱调色温（草地 + 橙色小狗 + 偏蓝）', () => {
  const dogOnGrass = canvasOf(160, 120, (c) => {
    c.fillStyle = '#6f8f3c'; c.fillRect(0, 0, 160, 120);
    c.fillStyle = '#3d5a22'; c.fillRect(0, 0, 160, 40);
    c.fillStyle = '#d98a3d'; c.beginPath(); c.ellipse(80, 75, 36, 20, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#f1e9dc'; c.beginPath(); c.ellipse(96, 82, 10, 8, 0, 0, Math.PI * 2); c.fill();
  });
  const blue = mapPx(dogOnGrass, (r, g, b) => [r * 0.86, g, Math.min(1, b * 1.12)]);
  const p = auto(blue);
  assert(p.temperature >= 0, `偏蓝的照片不能再往冷调：色温 ${p.temperature}`);
});

test('暖色的内容（粉墙、皮肤）不会被当成偏色', () => {
  const portrait = canvasOf(120, 160, (c) => {
    c.fillStyle = '#d9a1a0'; c.fillRect(0, 0, 120, 160);           // pink wall
    c.fillStyle = '#e1b096'; c.beginPath(); c.ellipse(60, 70, 30, 40, 0, 0, Math.PI * 2); c.fill(); // face
    c.fillStyle = '#2a1d17'; c.fillRect(28, 10, 64, 26);            // dark hair
    c.fillStyle = '#c98f76'; c.fillRect(20, 120, 80, 40);           // shoulders
    c.fillStyle = '#f3ece6'; c.fillRect(52, 64, 16, 4);             // a little white (eyes / teeth)
  });
  const p = auto(portrait);
  assert(Math.abs(p.temperature) <= 15, `色温 ${p.temperature}`);
  assert(Math.abs(p.tint) <= 12, `色调 ${p.tint}`);
});

test('黑白照片不加颜色', () => {
  const gray = mapPx(scene(), (r, g, b) => { const L = luma(r, g, b); return [L, L, L]; });
  const p = auto(gray);
  assertEq(p.vibrance, 0, '自然饱和度'); assertEq(p.saturation, 0, '饱和度');
  assertEq(p.temperature, 0, '色温'); assertEq(p.tint, 0, '色调');
  const c = castNeed(analyzePhoto(gray));
  assert(Math.abs(c.t) < 0.02 && Math.abs(c.s) < 0.02, `偏色估计 ${c.t.toFixed(3)} ${c.s.toFixed(3)}`);
});

test('结果都在滑块范围内、是整数', () => {
  for (const c of [scene(), mapPx(scene(), (r, g, b) => [r * 0.1, g * 0.1, b * 0.1]), mapPx(scene(), () => [0.97, 0.97, 0.97])]) {
    const p = auto(c);
    for (const k of AUTO_KEYS) assert(Number.isInteger(p[k]) && p[k] >= -100 && p[k] <= 100, `${k} = ${p[k]}`);
  }
  const empty = autoParams(null);
  assert(AUTO_KEYS.every((k) => empty[k] === 0), '空统计全为 0');
});

suite('调色面板 / 滤镜');

test('滤镜顺序覆盖全部预设，名称是两个汉字', () => {
  for (const id of Object.keys(FILTERS)) assert(FILTER_ORDER.includes(id), `顺序表缺少 ${id}`);
  for (const id of FILTER_ORDER) {
    assert(FILTERS[id], `预设不存在 ${id}`);
    assert(/^[一-龥]{2}$/.test(FILTERS[id].name), `名称 ${FILTERS[id].name}`);
  }
  assertEq(FILTER_ORDER[0], 'none', '第一个是原图');
  assertEq(FILTER_ORDER.length % 4, 0, '4 列排满');
});

test('人像滤镜：提亮、柔和，不偏色', () => {
  const s = scene();
  const o = applyAdjust(s, { ...DEFAULT_ADJUST, filter: 'portrait' });
  assert(stats(o).mean > stats(s).mean + 3, '更亮');
  assert(stats(o).std < stats(s).std, '反差更柔和');
  assert(Math.abs(wallCast(o) - wallCast(s)) < 8, `灰墙色偏变化 ${(wallCast(o) - wallCast(s)).toFixed(1)}`);
});

test('美食滤镜：更暖、更鲜艳', () => {
  const s = scene();
  const o = applyAdjust(s, { ...DEFAULT_ADJUST, filter: 'food' });
  const chroma = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b);
  assert(stats(o, chroma).mean > stats(s, chroma).mean + 3, '更鲜艳');
  assert(stats(o, (r, g, b) => r - b).mean > stats(s, (r, g, b) => r - b).mean + 3, '更暖');
});

test('滤镜缩略图：120×120 方图，同一版本复用，照片改动后重新生成', () => {
  const src = canvasOf(100, 300, (c) => { c.fillStyle = '#ff0000'; c.fillRect(0, 0, 100, 100); c.fillStyle = '#0000ff'; c.fillRect(0, 100, 100, 200); });
  const t1 = filterThumbBase(src);
  assertEq(`${t1.width}x${t1.height}`, '120x120', '尺寸');
  assert(filterThumbBase(src) === t1, '同一版本复用');
  const d = pixels(t1);
  const at = (x, y) => [...d.slice((y * 120 + x) * 4, (y * 120 + x) * 4 + 3)];
  assert(at(60, 10)[0] > 200 && at(60, 10)[2] < 60, '竖图取景偏上（顶部是红色）');
  assert(at(60, 110)[2] > 200, '下面是蓝色');
  bumpCanvas(src);
  assert(filterThumbBase(src) !== t1, '照片改动后重新生成');
  const big = canvasOf(900, 600, (c) => { c.fillStyle = '#336699'; c.fillRect(0, 0, 900, 600); });
  const t3 = filterThumbBase(big);
  assertEq(`${t3.width}x${t3.height}`, '120x120', '大图缩略图尺寸');
});
