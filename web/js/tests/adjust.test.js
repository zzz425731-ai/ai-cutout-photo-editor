import { suite, test, assert, assertEq, canvasOf, pixels, stats } from './harness.js';
import { applyAdjust, adjustIsIdentity, setAdjustBackend, adjustBackend, FILTERS, ADJUST_PARAMS } from '../core/adjust.js';
import { DEFAULT_ADJUST } from '../core/store.js';

const HUES = ['#ff3b30', '#34c759', '#007aff', '#ffcc00', '#5ac8fa', '#af52de', '#8e8e93', '#e0a98a'];
// 64×64: 8 colour bands, each with a dark→bright ramp across x
function testImage() {
  return canvasOf(64, 64, (c) => {
    HUES.forEach((hue, i) => {
      const g = c.createLinearGradient(0, 0, 64, 0);
      g.addColorStop(0, '#000'); g.addColorStop(0.5, hue); g.addColorStop(1, '#fff');
      c.fillStyle = g; c.fillRect(0, i * 8, 64, 8);
    });
  });
}
const flat = (v) => canvasOf(48, 48, (c) => { c.fillStyle = `rgb(${v},${v},${v})`; c.fillRect(0, 0, 48, 48); });
const P = (o) => ({ ...DEFAULT_ADJUST, ...o });
const L = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const chroma = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b);

function maxDiff(a, b) {
  const x = pixels(a), y = pixels(b);
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i] - y[i]));
  return m;
}
function meanWhere(src, out, pred, fn = L) {
  const s = pixels(src), o = pixels(out);
  let sum = 0, n = 0;
  for (let i = 0; i < s.length; i += 4) if (pred(s[i], s[i + 1], s[i + 2])) { sum += fn(o[i], o[i + 1], o[i + 2]); n++; }
  return sum / Math.max(1, n);
}

function suiteFor(backend) {
  const name = backend === 'gl' ? 'WebGL2' : 'CPU';
  suite(`调色引擎（${name}）`);
  const run = (src, p) => { setAdjustBackend(backend); try { return applyAdjust(src, P(p), { docSize: [src.width, src.height] }); } finally { setAdjustBackend('auto'); } };

  test('全零参数 ≈ 原图（快速路径与着色器路径）', () => {
    if (backend === 'gl') { setAdjustBackend('gl'); const be = adjustBackend(); setAdjustBackend('auto'); assertEq(be, 'gl', 'WebGL2 应可用'); }
    const src = testImage();
    assert(adjustIsIdentity(P({})), '全零应判定为恒等');
    assert(maxDiff(src, run(src, {})) <= 1, '快速路径');
    const tiny = run(src, { exposure: 1e-6 }); // forces the full shader/CPU path with ~zero params
    const d = maxDiff(src, tiny);
    assert(d <= 1, `着色器恒等误差 ${d}`);
  });

  const dir = (label, p, metric, sign, src = testImage) => test(`${label}方向正确`, () => {
    const s = src();
    const base = metric(s, s);
    const v = metric(s, run(s, p));
    assert(sign > 0 ? v > base + 0.5 : v < base - 0.5, `${label}: 原 ${base.toFixed(2)} → ${v.toFixed(2)}`);
  });
  const meanL = (s, o) => stats(o).mean;
  const stdL = (s, o) => stats(o).std;
  const meanC = (s, o) => stats(o, chroma).mean;

  dir('曝光 +', { exposure: 50 }, meanL, +1);
  dir('曝光 −', { exposure: -50 }, meanL, -1);
  dir('亮度 +', { brightness: 50 }, meanL, +1);
  dir('亮度 −', { brightness: -50 }, meanL, -1);
  dir('对比度 +', { contrast: 60 }, stdL, +1);
  dir('对比度 −', { contrast: -60 }, stdL, -1);
  dir('饱和度 +', { saturation: 60 }, meanC, +1);
  dir('饱和度 −', { saturation: -60 }, meanC, -1);
  dir('自然饱和度 +', { vibrance: 60 }, meanC, +1);
  dir('色温 +（更暖）', { temperature: 60 }, (s, o) => stats(o, (r, g, b) => r - b).mean, +1);
  dir('色温 −（更冷）', { temperature: -60 }, (s, o) => stats(o, (r, g, b) => r - b).mean, -1);
  dir('色调 +（偏洋红）', { tint: 60 }, (s, o) => stats(o, (r, g, b) => (r + b) / 2 - g).mean, +1);
  dir('高光 −（压暗亮部）', { highlights: -80 }, (s, o) => meanWhere(s, o, (r, g, b) => L(r, g, b) > 180), -1);
  dir('阴影 +（提亮暗部）', { shadows: 80 }, (s, o) => meanWhere(s, o, (r, g, b) => L(r, g, b) < 70), +1);
  dir('褪色（黑位抬高）', { fade: 80 }, (s, o) => meanWhere(s, o, (r, g, b) => L(r, g, b) < 20), +1);
  dir('颗粒（噪点增加）', { grain: 80 }, stdL, +1, () => flat(128));
  dir('锐化（边缘反差增大）', { sharpen: 80 }, (s, o) => {
    const d = pixels(o);
    let e = 0;
    for (let y = 0; y < o.height; y++) for (let x = 1; x < o.width; x++) { const i = (y * o.width + x) * 4; e += Math.abs(d[i] - d[i - 4]); }
    return e / 1000;
  }, +1, () => canvasOf(48, 48, (c) => { c.fillStyle = '#404040'; c.fillRect(0, 0, 48, 48); c.fillStyle = '#b0b0b0'; c.fillRect(24, 0, 24, 48); }));

  test('暗角：四角变暗、中心基本不变', () => {
    const s = flat(160);
    const o = run(s, { vignette: 80 });
    const d = pixels(o);
    const corner = d[0], center = d[(24 * 48 + 24) * 4];
    assert(corner < 140, `四角 ${corner}`);
    assert(Math.abs(center - 160) <= 2, `中心 ${center}`);
  });

  test('黑白滤镜去色、强度 0 等于原图', () => {
    const s = testImage();
    const o = run(s, { filter: 'bw', filterStrength: 100 });
    assert(stats(o, chroma).mean < 2, `残余饱和度 ${stats(o, chroma).mean}`);
    assert(adjustIsIdentity(P({ filter: 'bw', filterStrength: 0 })), '强度 0 应为恒等');
  });

  test('所有滤镜都能运行且改变画面', () => {
    const s = testImage();
    for (const id of Object.keys(FILTERS)) {
      if (id === 'none') continue;
      const o = run(s, { filter: id, filterStrength: 100 });
      assert(maxDiff(s, o) > 5, `滤镜 ${id} 没有效果`);
    }
  });
}

suiteFor('gl');
suiteFor('cpu');

suite('调色引擎（一致性）');
test('WebGL2 与 CPU 结果一致（误差 ≤ 3）', () => {
  const s = testImage();
  const p = P({ exposure: 20, contrast: 30, saturation: -20, vibrance: 25, temperature: 30, tint: -10, highlights: -30, shadows: 25, fade: 20, vignette: 40, filter: 'film', filterStrength: 70 });
  setAdjustBackend('gl'); const a = applyAdjust(s, p); setAdjustBackend('cpu'); const b = applyAdjust(s, p); setAdjustBackend('auto');
  const d = maxDiff(a, b);
  assert(d <= 3, `最大误差 ${d}`);
});
test('参数表完整', () => {
  assertEq(ADJUST_PARAMS.length, 13);
  for (const k of ['exposure', 'brightness', 'contrast', 'saturation', 'vibrance', 'temperature', 'tint', 'highlights', 'shadows', 'sharpen', 'vignette', 'fade', 'grain']) {
    assert(ADJUST_PARAMS.some((p) => p.key === k), `缺少 ${k}`);
  }
  for (const id of ['none', 'fresh', 'warm', 'cool', 'bw', 'vintage', 'film', 'japan', 'vivid', 'cinematic']) assert(FILTERS[id]?.name, `缺少滤镜 ${id}`);
});
