// tests/panels/erase.test.js — 消除: context crop maths, stroke grouping, paint → mask, and the brush only
// painting the red selection (never the photo). The /api/inpaint round trip is covered by the UI drive.
import { suite, test, assert, assertEq, canvasOf, px } from '../harness.js';
import { store, createDoc } from '../../core/store.js';
import { setTool } from '../../core/tools.js';
import { contextRect, groupRects, maskFromPaint, hasPaint, clearPaint, paintCanvas, inpaintBrush, runErase, CONTEXT_MIN } from '../../tools/inpaint-brush.js';
import { dataURLToCanvas } from '../../core/io.js';
import '../../panels/erase.js';

const inside = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;

suite('消除 / 取图范围');

test('上下文范围 ≈ 2.5 倍涂抹框，至少 256 px，居中', () => {
  const b = { x: 900, y: 700, w: 200, h: 40 };
  const r = contextRect(b, 3000, 2000);
  assertEq(r.w, 500, '宽 = 2.5 倍');
  assertEq(r.h, CONTEXT_MIN, '高至少 256');
  assert(inside(b, r), '包含涂抹框');
  assert(Math.abs((r.x + r.w / 2) - (b.x + b.w / 2)) <= 1 && Math.abs((r.y + r.h / 2) - (b.y + b.h / 2)) <= 1, '居中');
});

test('靠近边缘时平移到图内，小图时裁到整张图', () => {
  const r = contextRect({ x: 5, y: 1950, w: 60, h: 40 }, 3000, 2000);
  assertEq(r.x, 0); assertEq(r.y, 2000 - 256); assertEq(r.w, 256); assertEq(r.h, 256);
  const s = contextRect({ x: 50, y: 40, w: 30, h: 30 }, 200, 150);
  assertEq(JSON.stringify(s), JSON.stringify({ x: 0, y: 0, w: 200, h: 150 }), '小图 = 整张');
  const big = contextRect({ x: 100, y: 100, w: 1800, h: 1200 }, 2000, 1500);
  assert(inside({ x: 100, y: 100, w: 1800, h: 1200 }, big) && big.w === 2000 && big.h === 1500, '大涂抹 = 整张');
});

test('相近的几笔合成一次请求，远处的分开，且各次范围不重叠', () => {
  const g = groupRects([{ x: 100, y: 100, w: 40, h: 40 }, { x: 150, y: 120, w: 30, h: 30 }, { x: 2500, y: 1500, w: 50, h: 50 }], 3000, 2000);
  assertEq(g.length, 2, '两组');
  for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
    const a = g[i].crop, b = g[j].crop;
    assert(!(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h), '不重叠');
  }
  for (const x of g) assert(inside(x.bbox, x.crop), '范围包含涂抹');
});

test('涂抹 → 黑底白色蒙版', () => {
  const paint = canvasOf(100, 80, (c) => { c.fillStyle = '#ff2d4a'; c.beginPath(); c.arc(50, 40, 10, 0, Math.PI * 2); c.fill(); });
  const m = maskFromPaint(paint, { x: 30, y: 20, w: 40, h: 40 });
  assertEq(m.canvas.width, 40);
  assertEq(px(m.canvas, 20, 20).join(), '255,255,255,255', '中心白');
  assertEq(px(m.canvas, 1, 1).join(), '0,0,0,255', '外面黑');
  assert(m.count > 250 && m.count < 380, `面积 ${m.count}`);
});

suite('消除 / 消除笔');

test('画笔只画红色选区，不改照片；清除涂抹后归零', () => {
  const src = canvasOf(300, 200, (c) => { c.fillStyle = '#4080c0'; c.fillRect(0, 0, 300, 200); });
  store.setDoc(createDoc({ source: src, name: '消除测试' }));
  store.ui.eraseAuto = false;
  store.ui.brush.size = 20;
  setTool('inpaint-brush');
  const v0 = store.version;
  inpaintBrush.onPointerDown({ x: 50, y: 50 });
  inpaintBrush.onPointerMove({ x: 120, y: 60 });
  inpaintBrush.onPointerUp({ x: 150, y: 80 });
  assert(hasPaint(), '有涂抹');
  assertEq(store.version, v0, '文档没变');
  assertEq(px(store.doc.source, 100, 57).join(), '64,128,192,255', '照片没被画');
  assert(px(paintCanvas(), 100, 57)[3] > 200, '选区画上了');
  assertEq(px(paintCanvas(), 250, 150)[3], 0, '别处没画');
  clearPaint();
  assert(!hasPaint(), '清除后没有涂抹');
  assertEq(px(paintCanvas(), 100, 57)[3], 0, '选区清空');
  setTool('pan');
  store.ui.eraseAuto = true;
});

test('换了图片，旧涂抹不会带过去', () => {
  const a = canvasOf(120, 90, (c) => { c.fillStyle = '#888'; c.fillRect(0, 0, 120, 90); });
  store.setDoc(createDoc({ source: a }));
  store.ui.eraseAuto = false;
  setTool('inpaint-brush');
  inpaintBrush.onPointerDown({ x: 30, y: 30 });
  inpaintBrush.onPointerUp({ x: 40, y: 30 });
  assert(hasPaint());
  store.setDoc(createDoc({ source: canvasOf(120, 90) }));
  assert(!hasPaint(), '新图没有涂抹');
  setTool('pan');
  store.ui.eraseAuto = true;
});

suite('消除 / 异步与撤销');

function selectedPhoto() {
  const src = canvasOf(128, 96, (x) => { x.fillStyle = '#4080c0'; x.fillRect(0, 0, 128, 96); });
  store.setDoc(createDoc({ source: src }));
  store.ui.eraseAuto = false;
  store.ui.brush.size = 16;
  setTool('inpaint-brush');
  inpaintBrush.onPointerDown({ x: 50, y: 50 });
  inpaintBrush.onPointerUp({ x: 55, y: 50 });
  return src;
}

function inpaintServer(mode) {
  const real = window.fetch;
  window.fetch = async (url, opts) => {
    if (!String(url).startsWith('/api/inpaint')) return real(url, opts);
    if (mode === 'error') return new Response(JSON.stringify({ error: '消除服务暂时失败' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    const body = JSON.parse(opts.body);
    const canvas = mode === 'bad-size' ? canvasOf(64, 48) : await dataURLToCanvas(body.image);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ff0000'; ctx.fillRect(48, 48, 10, 8);
    if (mode === 'edited') store.doc.source.__v = (store.doc.source.__v || 0) + 1;
    return new Response(JSON.stringify({ image: canvas.toDataURL('image/png'), ms: 3, engine: 'test' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return () => { window.fetch = real; clearPaint(); setTool('pan'); store.ui.eraseAuto = true; document.querySelectorAll('#toasts .toast').forEach((t) => t.remove()); };
}

test('消除成功：一步撤销，恢复原图，选区清空', async () => {
  const src = selectedPhoto(), restore = inpaintServer('ok');
  try {
    assert(await runErase(), '成功');
    assertEq(px(store.doc.source, 50, 50).join(), '255,0,0,255');
    assert(!hasPaint(), '成功才清空选区');
    assertEq(store.historyInfo().undo, 1);
    store.undo();
    assert(store.doc.source === src, '撤销回到原图');
    store.redo();
    assertEq(px(store.doc.source, 50, 50).join(), '255,0,0,255');
  } finally { restore(); }
});

test('消除失败或错误尺寸：不改照片、不增加撤销，保留涂抹供重试', async () => {
  for (const mode of ['error', 'bad-size']) {
    const src = selectedPhoto(), restore = inpaintServer(mode);
    try {
      assert(!(await runErase()), `${mode} 返回失败`);
      assert(store.doc.source === src, '照片原样保留');
      assert(hasPaint(), '涂抹保留');
      assertEq(store.historyInfo().undo, 0);
    } finally { restore(); }
  }
});

test('消除请求返回前原图像素版本改变：不覆盖较新的编辑', async () => {
  const src = selectedPhoto(), restore = inpaintServer('edited');
  try {
    assert(!(await runErase()), '忽略过期结果');
    assert(store.doc.source === src);
    assertEq(store.historyInfo().undo, 0);
  } finally { restore(); }
});
