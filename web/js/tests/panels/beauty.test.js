// tests/panels/beauty.test.js — 美颜 panel: result merge (full size and downscaled round trips), and the whole
// slider → /api/retouch → commit flow with a fake server (fetch is mocked): one undo step per change,
// back to 0 = the original canvas, fg kept in sync, errors / "no skin" leave the photo alone.
import { suite, test, assert, assertEq, canvasOf, pixels } from '../harness.js';
import { mergeRetouch, retouchKey, beautyStateOf, applyBeauty, MAX_SEND_PX } from '../../panels/beauty.js';
import { store, createDoc } from '../../core/store.js';
import { createCanvas, resizeCanvas, dataURLToCanvas } from '../../core/io.js';

function noise(w, h, seed = 7) {
  return canvasOf(w, h, (c) => {
    const id = c.createImageData(w, h);
    let s = seed;
    for (let i = 0; i < id.data.length; i += 4) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      id.data[i] = 60 + (s >>> 25); id.data[i + 1] = 90 + ((s >>> 18) & 63); id.data[i + 2] = 70 + ((s >>> 10) & 63); id.data[i + 3] = 255;
    }
    c.putImageData(id, 0, 0);
  });
}
function copy(c) { return canvasOf(c.width, c.height, (x) => x.drawImage(c, 0, 0)); }
function addRect(c, r, dr, dg = 0, db = 0) {
  const x = c.getContext('2d', { willReadFrequently: true });
  const id = x.getImageData(r.x, r.y, r.w, r.h);
  for (let i = 0; i < id.data.length; i += 4) { id.data[i] += dr; id.data[i + 1] += dg; id.data[i + 2] += db; }
  x.putImageData(id, r.x, r.y);
  return c;
}
const same = (a, b) => { const x = pixels(a), y = pixels(b); if (x.length !== y.length) return false; for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false; return true; };

suite('美颜面板 / 结果合成');

test('原尺寸：只替换改动的区域，给出改动范围', () => {
  const base = noise(80, 60);
  const out = addRect(copy(base), { x: 20, y: 10, w: 15, h: 12 }, 25);
  const r = mergeRetouch(base, base, out);
  assert(r.canvas !== base, '新画布');
  assertEq(JSON.stringify(r.rect), JSON.stringify({ x: 20, y: 10, w: 15, h: 12 }), '改动范围');
  assert(same(r.canvas, out), '像素等于服务器结果');
});

test('没有改动 → 返回原画布', () => {
  const base = noise(40, 30);
  const r = mergeRetouch(base, base, copy(base));
  assert(r.canvas === base && r.rect === null, '原样返回');
});

test('缩小发送：改动按比例放大叠加，其余像素一点不变', () => {
  const base = noise(200, 120, 11);
  const sent = resizeCanvas(base, 100, 60, { willRead: true });
  const out = addRect(copy(sent), { x: 40, y: 20, w: 20, h: 20 }, 30, 0, -12);
  const r = mergeRetouch(base, sent, out);
  const a = pixels(base), b = pixels(r.canvas);
  const R = r.rect;
  assert(R.x <= 80 && R.y <= 40 && R.x + R.w >= 120 && R.y + R.h >= 80, `范围 ${JSON.stringify(R)}`);
  assert(R.x >= 74 && R.y >= 34 && R.x + R.w <= 126 && R.y + R.h <= 86, `范围太大 ${JSON.stringify(R)}`);
  let outside = 0, inside = 0, dr = 0, dg = 0, db = 0;
  for (let y = 0; y < 120; y++) for (let x = 0; x < 200; x++) {
    const i = (y * 200 + x) * 4;
    const inR = x >= R.x && x < R.x + R.w && y >= R.y && y < R.y + R.h;
    if (!inR) { if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) outside++; continue; }
    if (x >= 84 && x < 116 && y >= 44 && y < 76) { inside++; dr += b[i] - a[i]; dg += b[i + 1] - a[i + 1]; db += b[i + 2] - a[i + 2]; }
  }
  assertEq(outside, 0, '范围外改动的像素');
  assert(Math.abs(dr / inside - 30) < 1.5, `红色 +${(dr / inside).toFixed(2)}`);
  assert(Math.abs(dg / inside) < 1, `绿色 ${(dg / inside).toFixed(2)}`);
  assert(Math.abs(db / inside + 12) < 1.5, `蓝色 ${(db / inside).toFixed(2)}`);
});

test('结果尺寸不对时报中文错误', () => {
  const base = noise(20, 20);
  let msg = '';
  try { mergeRetouch(base, base, noise(10, 10)); } catch (e) { msg = e.message; }
  assert(/尺寸/.test(msg), msg);
});

test('缓存键区分数值、蒙版和照片版本', () => {
  const base = noise(10, 10), mask = createCanvas(10, 10);
  const k = (p, m) => retouchKey(base, p, m, 'full');
  const k0 = k({ smooth: 30, whiten: 0 }, null);
  assert(k0 !== k({ smooth: 31, whiten: 0 }, null), '磨皮');
  assert(k0 !== k({ smooth: 30, whiten: 5 }, null), '美白');
  assert(k0 !== k({ smooth: 30, whiten: 0 }, mask), '蒙版');
  assert(k0 !== retouchKey(base, { smooth: 30, whiten: 0 }, null, 'prev'), '预览/高清');
  base.__v = (base.__v || 0) + 1;
  assert(k0 !== k({ smooth: 30, whiten: 0 }, null), '照片版本');
  assert(MAX_SEND_PX >= 12e6 && MAX_SEND_PX <= 12.6e6, `最大发送像素 ${MAX_SEND_PX}`);
});

// ---------------------------------------------------------------- whole flow with a fake /api/retouch
const FACE = { x: 10, y: 8, w: 16, h: 12 };
function fakeServer(mode = 'ok', wait = null) {
  const calls = [];
  const real = window.fetch;
  window.fetch = async (url, opts) => {
    if (!String(url).startsWith('/api/retouch')) return real(url, opts);
    const body = JSON.parse(opts.body);
    calls.push({ smooth: body.smooth, whiten: body.whiten, mask: !!body.mask });
    if (wait) await wait;
    if (mode === 'error') return new Response(JSON.stringify({ error: '电脑内存不足，AI 处理失败。' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    const c = await dataURLToCanvas(body.image, { willRead: true });
    if (mode === 'ok') addRect(c, FACE, Math.round(body.whiten / 2), Math.round(body.smooth / 4), 0);
    return new Response(JSON.stringify({ image: c.toDataURL('image/png'), ms: 3 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, restore: () => { window.fetch = real; } };
}
const quiet = () => document.querySelectorAll('#toasts .toast').forEach((t) => t.remove());

suite('美颜面板 / 调用与撤销');

test('磨皮、美白：各一步撤销，回到 0 就是原图本身', async () => {
  const src = noise(48, 36, 3);
  store.setDoc(createDoc({ source: src }));
  const doc = store.doc;
  const srv = fakeServer();
  try {
    assert(await applyBeauty({ smooth: 40 }, 'smooth'), '磨皮已应用');
    const r1 = doc.source;
    assert(r1 !== src, '换了新照片');
    assertEq(store.historyInfo().undo, 1, '一步');
    assertEq(store.undoLabel(), '美颜：磨皮', '撤销名称');
    const st = beautyStateOf(r1);
    assert(st && st.base === src && st.smooth === 40 && st.whiten === 0, '记住原图和数值');
    assert(await applyBeauty({ whiten: 60 }, 'whiten'), '美白已应用');
    assertEq(store.historyInfo().undo, 2, '两步');
    assertEq(srv.calls.length, 2, '调用两次服务');
    assertEq(JSON.stringify(srv.calls[1]), JSON.stringify({ smooth: 40, whiten: 60, mask: false }), '第二次从原图重算');
    const r2 = doc.source;
    const d = pixels(r2), o = pixels(src);
    const i = ((FACE.y + 2) * 48 + FACE.x + 2) * 4;
    assertEq(d[i] - o[i], 30, '红 +30（只加一次，不叠加）');
    assertEq(d[i + 1] - o[i + 1], 10, '绿 +10');
    const j = (30 * 48 + 40) * 4;
    assert(d[j] === o[j] && d[j + 1] === o[j + 1] && d[j + 2] === o[j + 2], '皮肤以外不变');
    // undo / redo keep the state
    store.undo();
    assert(doc.source === r1 && beautyStateOf(doc.source).whiten === 0, '撤销回到只磨皮');
    store.redo();
    assert(doc.source === r2, '重做');
    // back to 0 → the original canvas itself, no server call
    const n = srv.calls.length;
    assert(await applyBeauty({ smooth: 0, whiten: 0 }, 'reset'), '恢复原样');
    assert(doc.source === src, '就是原图画布');
    assertEq(srv.calls.length, n, '不用再调服务');
    assertEq(store.undoLabel(), '取消美颜', '撤销名称');
    // same values again → nothing to do
    assert(!(await applyBeauty({ smooth: 0, whiten: 0 })), '重复设置没有新步骤');
  } finally { srv.restore(); quiet(); }
});

test('抠图后的主体（fg）同步美颜，回到 0 时 fg 也完全复原', async () => {
  const src = noise(48, 36, 5);
  const doc = createDoc({ source: src });
  doc.fg = addRect(copy(src), { x: 0, y: 0, w: 4, h: 36 }, -20); // 去色边 copy: differs at the left edge
  doc.mask = createCanvas(48, 36, { willRead: true });
  const mx = doc.mask.getContext('2d'); mx.fillStyle = '#000'; mx.fillRect(0, 0, 40, 36);
  doc.cutout = true;
  store.setDoc(doc);
  const fg0 = doc.fg;
  const srv = fakeServer();
  try {
    assert(await applyBeauty({ smooth: 20, whiten: 40, personOnly: true }), '已应用');
    assert(srv.calls[0].mask, '仅人物区域：发送了蒙版');
    const f = pixels(doc.fg), s = pixels(doc.source), f0 = pixels(fg0);
    const i = ((FACE.y + 1) * 48 + FACE.x + 1) * 4;
    assert(f[i] === s[i] && f[i + 1] === s[i + 1], 'fg 的皮肤区域跟着美颜');
    const e = (20 * 48 + 1) * 4;
    assertEq(f[e], f0[e], 'fg 其余地方保留去色边的颜色');
    assert(await applyBeauty({ smooth: 0, whiten: 0 }, 'reset'), '恢复');
    assert(doc.source === src && doc.fg === fg0, 'source 和 fg 都是原来的画布');
    assert(await applyBeauty({ smooth: 20, personOnly: false }), '不限人物');
    assert(!srv.calls[srv.calls.length - 1].mask, '没有发送蒙版');
  } finally { srv.restore(); quiet(); }
});

test('服务出错：照片不变、没有撤销步骤、提示原因', async () => {
  const src = noise(32, 24, 9);
  store.setDoc(createDoc({ source: src }));
  const srv = fakeServer('error');
  try {
    assert(!(await applyBeauty({ smooth: 50 })), '返回 false');
    assert(store.doc.source === src, '照片不变');
    assertEq(store.historyInfo().undo, 0, '没有撤销步骤');
    const msgs = [...document.querySelectorAll('#toasts .toast .t-msg')].map((m) => m.textContent);
    assert(msgs.some((m) => /内存不足/.test(m)), `提示 ${msgs.join('|')}`);
  } finally { srv.restore(); quiet(); }
});

test('没找到皮肤（结果和原图一样）：不产生撤销步骤', async () => {
  const src = noise(32, 24, 13);
  store.setDoc(createDoc({ source: src }));
  const srv = fakeServer('same');
  try {
    assert(!(await applyBeauty({ whiten: 50 })), '返回 false');
    assert(store.doc.source === src, '照片不变');
    assertEq(store.historyInfo().undo, 0, '没有撤销步骤');
    assert(!beautyStateOf(store.doc.source), '滑块仍是 0');
  } finally { srv.restore(); quiet(); }
});

test('画笔改过的美颜结果当作新的原图', async () => {
  const src = noise(40, 30, 17);
  store.setDoc(createDoc({ source: src }));
  const srv = fakeServer();
  try {
    await applyBeauty({ smooth: 30 });
    const r = store.doc.source;
    assert(beautyStateOf(r), '有状态');
    r.__v = (r.__v || 0) + 1; // what store.bump does after an in-place brush stroke
    assert(!beautyStateOf(r), '改过之后不再沿用旧原图');
    await applyBeauty({ whiten: 20 });
    assert(beautyStateOf(store.doc.source).base === r, '以改过的照片为原图');
  } finally { srv.restore(); quiet(); }
});

test('美颜请求期间蒙版改变：旧人物范围的结果不能覆盖新蒙版', async () => {
  for (const change of ['brush', 'replace', 'disable', 'add']) {
    const src = noise(48, 36, 31);
    const doc = createDoc({ source: src });
    if (change !== 'add') {
      doc.mask = canvasOf(48, 36, (x) => { x.fillStyle = '#000'; x.fillRect(0, 0, 24, 36); });
      doc.cutout = true;
    }
    store.setDoc(doc);
    let release;
    const gate = new Promise((r) => { release = r; });
    const srv = fakeServer('ok', gate);
    const pending = applyBeauty({ smooth: 40, whiten: 50, personOnly: true });
    try {
      const until = performance.now() + 4000;
      while (!srv.calls.length && performance.now() < until) await new Promise((r) => setTimeout(r, 10));
      assert(srv.calls.length === 1, '美颜请求已发出');
      if (change === 'brush') doc.mask.__v = (doc.mask.__v || 0) + 1;
      else if (change === 'disable') doc.cutout = false;
      else { doc.mask = createCanvas(48, 36); doc.cutout = true; }
      release();
      assert(!(await pending), `${change} 后不提交旧结果`);
      assert(doc.source === src, `${change} 后照片未被旧请求改写`);
      assertEq(store.historyInfo().undo, 0, '不产生过期美颜的撤销步骤');
    } finally { release(); await pending; srv.restore(); quiet(); }
  }
});
