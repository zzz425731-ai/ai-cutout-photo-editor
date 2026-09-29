// tests/panels/idphoto.test.js — 证件照: sizes, framing maths, hair-top detection, edge-clamped plane crops,
// size-limited JPEG, print layout, and the one-step generate / re-frame / undo flow on a synthetic doc.
import { suite, test, assert, assertEq, assertClose, canvasOf, px } from '../harness.js';
import { store, createDoc } from '../../core/store.js';
import { createCanvas, readAlpha } from '../../core/io.js';
import { getPanels } from '../../core/panels.js';
import { dataURLToCanvas } from '../../core/io.js';
import {
  PRESETS, presetSize, mmToPx, colorBg, faceGeometry, measureHead, autoFrame, frameRect, drawPlane,
  makeIdPhoto, applyFrame, isStale, encodeJpeg, layoutSheet, renderSheet, HEAD, TOP,
} from '../../panels/idphoto.js';

// a synthetic head: face box 300×380 at (400,400) in a 1200×1600 photo, hair top at 280
const G = { bx: 400, top: 400, bw: 300, bh: 380, cx: 550, eyeY: 560, chin: 780, hairTop: 280, left: 380, right: 720 };
const out = (r, x, y) => ({ x: (x - r.x) * r.s, y: (y - r.y) * r.s });

suite('证件照 / 尺寸与版式');

test('预设像素 = 毫米 @300dpi（身份证按 350dpi 规格）', () => {
  for (const p of PRESETS) {
    if (!p.px) continue;
    const s = presetSize(p.id);
    if (p.id === 'idcard') { assertEq(`${s.w}x${s.h}`, '358x441'); assertEq(s.dpi, 350); continue; }
    assertEq(`${s.w}x${s.h}`, `${mmToPx(p.mm[0])}x${mmToPx(p.mm[1])}`, p.name);
    assertEq(s.dpi, 300);
  }
  assertEq(presetSize('one').w, 295);
  assertEq(presetSize('two').h, 579);
});

test('自定义尺寸：毫米/像素换算与校验', () => {
  const a = presetSize('custom', { unit: 'mm', w: 25, h: 35 });
  assertEq(`${a.w}x${a.h}`, '295x413');
  const b = presetSize('custom', { unit: 'px', w: 480, h: 640 });
  assertEq(`${b.w}x${b.h}`, '480x640');
  assertClose(b.mm[0], 40.64, 0.01);
  assertEq(presetSize('custom', { unit: 'mm', w: 5, h: 35 }), null, '太小');
  assertEq(presetSize('custom', { unit: 'px', w: 2000, h: 300 }), null, '比例离谱');
  assertEq(presetSize('custom', { unit: 'mm', w: NaN, h: 35 }), null);
});

test('底色：纯色 / 渐变蓝 / 自定义', () => {
  assertEq(colorBg('blue').color, '#438edb');
  assertEq(colorBg('red').color, '#d9001b');
  assertEq(colorBg('gray').color, '#f2f2f2');
  const g = colorBg('gradient');
  assertEq(g.type, 'gradient'); assertEq(g.color2, '#438edb'); assertEq(g.angle, 180);
  assertEq(colorBg('custom', '#AABBCC').color, '#aabbcc');
  assertEq(colorBg('custom', 'bad').color, '#ffffff');
});

test('排版：6 寸放 8 张一寸、4 张二寸（转 90°），5 寸放 8 张一寸', () => {
  const n = (paper, id) => layoutSheet(paper, presetSize(id).mm);
  assertEq(n(6, 'one').count, 8); assertEq(n(6, 'one').rotated, false);
  assertEq(n(6, 'two').count, 4); assertEq(n(6, 'two').rotated, true);
  assertEq(n(6, 'small-one').count, 10);
  assertEq(n(6, 'idcard').count, 8);
  assertEq(n(5, 'one').count, 8);
  assertEq(layoutSheet(6, [90, 120]).count, 0, '放不下');
  for (const id of ['one', 'two', 'small-two', 'big-one', 'idcard']) {
    for (const paper of [6, 5]) {
      const L = n(paper, id);
      assert(L.count > 0, `${id} ${paper}`);
      for (const c of L.cells) {
        assert(c.x >= 60 && c.y >= 60 && c.x + L.cellW <= L.sheetW - 60 && c.y + L.cellH <= L.sheetH - 60, `${id} 贴边了`);
        for (const x of L.cutX) assert(x <= c.x - 8 || x >= c.x + L.cellW + 8, '裁剪线压到照片');
        for (const y of L.cutY) assert(y <= c.y - 8 || y >= c.y + L.cellH + 8, '裁剪线压到照片');
      }
    }
  }
});

test('排版图：白纸、浅灰裁剪线、照片（转向正确）', () => {
  const photo = canvasOf(295, 413, (x) => { x.fillStyle = '#438edb'; x.fillRect(0, 0, 295, 413); x.fillStyle = '#d9001b'; x.fillRect(0, 0, 295, 40); });
  const L = layoutSheet(6, [25, 35]);
  const s = renderSheet(photo, L);
  assertEq(`${s.width}x${s.height}`, '1800x1200');
  const c0 = L.cells[0];
  assertEq(px(s, c0.x + 100, c0.y + 200).join(), '67,142,219,255');
  assertEq(px(s, c0.x + 100, c0.y + 10)[0], 217, '红条在上方（一寸不转向）');
  assert(px(s, 5, 5)[0] === 255, '纸边是白色');
  const [r] = px(s, L.cutX[1], 40);
  assert(r > 180 && r < 230, `裁剪线是浅灰色 (${r})`);
  const L2 = layoutSheet(6, [35, 49]);
  const s2 = renderSheet(canvasOf(413, 579, (x) => { x.fillStyle = '#438edb'; x.fillRect(0, 0, 413, 579); x.fillStyle = '#d9001b'; x.fillRect(0, 0, 413, 40); }), L2);
  const c = L2.cells[0];
  assertEq(`${L2.cellW}x${L2.cellH}`, '579x413');
  assert(px(s2, c.x + 10, c.y + 200)[0] > 200, '二寸转 90°：红条在左边');
});

suite('证件照 / 取景');

test('人脸几何：下巴取人脸框底，眼睛取关键点', () => {
  const g = faceGeometry({ x: 100, y: 100, w: 200, h: 260, landmarks: [[160, 200], [240, 200], [200, 250], [165, 290], [235, 290]] });
  assertEq(g.eyeY, 200); assertEq(g.chin, 360); assertEq(g.cx, 200);
  // a box that stops at the mouth → chin pushed down by the landmarks
  const g2 = faceGeometry({ x: 100, y: 100, w: 200, h: 190, landmarks: [[160, 200], [240, 200], [200, 250], [165, 290], [235, 290]] });
  assertClose(g2.chin, 290 + 0.3 * 90, 0.01);
});

test('自动取景：头部约 66%，头顶留白约 9%，脸居中', () => {
  const W = 295, H = 413;
  const r = frameRect(autoFrame(G, W, H, 1200, 1600), W, H);
  assertClose(out(r, 0, G.hairTop).y / H, TOP, 0.005, '头顶');
  assertClose(out(r, 0, G.chin).y / H, TOP + HEAD, 0.005, '下巴');
  assertClose(out(r, G.cx, 0).x, W / 2, 0.5, '居中');
  assertClose(r.w / r.h, W / H, 1e-6);
});

test('微调：缩放以头部中心为准，上下左右按照片比例移动', () => {
  const W = 295, H = 413, base = autoFrame(G, W, H, 1200, 1600);
  const ay = (G.hairTop + G.chin) / 2;
  const a = out(frameRect(base, W, H), G.cx, ay), b = out(frameRect(base, W, H, 1.2), G.cx, ay);
  assertClose(a.x, b.x, 1e-6); assertClose(a.y, b.y, 1e-6);
  const r = frameRect(base, W, H, 1.2);
  assertClose((out(r, 0, G.chin).y - out(r, 0, G.hairTop).y) / H, HEAD * 1.2, 1e-6, '头部放大 1.2 倍');
  const m = out(frameRect(base, W, H, 1, 0.1, -0.05), G.cx, ay);
  assertClose(m.x - a.x, 0.1 * W, 1e-6, '往右');
  assertClose(m.y - a.y, -0.05 * H, 1e-6, '往上');
});

test('大蓬头发：头发不出框，脸不会太小', () => {
  const W = 295, H = 413;
  const g = { ...G, hairTop: -40, left: 150, right: 950 }; // hair 820 px vs expected ≈ 473
  const r = frameRect(autoFrame(g, W, H, 1200, 1600), W, H);
  const top = out(r, 0, g.hairTop).y / H, chin = out(r, 0, g.chin).y / H;
  assert(top >= 0.02, `头发出框了 (${top.toFixed(3)})`);
  assert(chin - top <= 0.721, '头部太大');
  assert((chin - out(r, 0, g.eyeY).y / H) > 0.18, "脸太小");
  assert(out(r, g.left, 0).x >= 0 && out(r, g.right, 0).x <= W, '头发左右都在框内');
});

test('照片下方很少：头往下挪一点，头顶留白不超过 13%', () => {
  const W = 295, H = 413;
  const r = frameRect(autoFrame(G, W, H, 1200, 850), W, H);
  const top = out(r, 0, G.hairTop).y / H;
  assert(top > TOP + 0.01 && top <= 0.131, `头顶留白 ${top}`);
});

test('头顶检测：从眼睛往上找到头发最高处，忽略分开的杂物', () => {
  const w = 400, h = 500;
  const c = canvasOf(w, h, (x) => {
    x.fillStyle = '#000';
    x.beginPath(); x.ellipse(200, 260, 90, 130, 0, 0, Math.PI * 2); x.fill(); // head, top at 130
    x.fillRect(185, 100, 30, 40);  // bun on top (connected) → top 100
    x.fillRect(150, 20, 100, 30);  // separate blob above, gap 50 px
  });
  const arr = readAlpha(c);
  const g = { bx: 130, top: 170, bw: 140, bh: 190, cx: 200, eyeY: 230, chin: 360 };
  const r = measureHead(arr, { x: 0, y: 0, w, h }, g);
  assert(r.found);
  assertClose(r.hairTop, 100, 1.5, '发髻顶');
  assertClose(r.left, 110, 3, '左');
  assertClose(r.right, 290, 3, '右');
  const empty = measureHead(new Uint8Array(w * h), { x: 0, y: 0, w, h }, g);
  assertEq(empty.found, false);
  assert(empty.hairTop < g.top, '没蒙版时估一个头顶');
});

test('裁切平面：照片外用边缘像素补齐，蒙版上方留空，没有接缝', () => {
  const src = canvasOf(100, 100, (x) => { x.fillStyle = '#336699'; x.fillRect(0, 0, 100, 100); x.fillStyle = '#ff0000'; x.fillRect(0, 99, 100, 1); });
  const rect = { x: -20, y: -20, w: 140, h: 160 }; // beyond every side
  const o = drawPlane(src, 100, 100, rect, 70, 80, false);
  assert(px(o, 35, 60)[0] > 180, `紧挨照片的一行重复最后一行 (${px(o, 35, 60)})`); // photo ends at y = 60
  assertEq(px(o, 35, 79)[3], 255, '底部补齐（柔和过渡）');
  assertEq(px(o, 2, 40).join(), '51,102,153,255', '左侧补齐');
  assertEq(px(o, 35, 2).join(), '51,102,153,255', '照片顶上也补齐');
  for (let x = 0; x < 70; x++) assertEq(px(o, x, 40)[3], 255, `第 ${x} 列不透明`);
  for (let y = 0; y < 80; y++) assertEq(px(o, 10, y)[3], 255, `第 ${y} 行不透明`);
  const mask = canvasOf(100, 100, (x) => { x.fillStyle = '#000'; x.fillRect(0, 0, 100, 100); });
  const m = drawPlane(mask, 100, 100, rect, 70, 80, true);
  assertEq(px(m, 35, 3)[3], 0, '蒙版上方留空');
  assertEq(px(m, 35, 78)[3], 255, '蒙版下方补齐');
  // downscaled working copy gives the same framing
  const half = canvasOf(50, 50, (x) => x.drawImage(src, 0, 0, 50, 50));
  const o2 = drawPlane(half, 100, 100, { x: 10, y: 10, w: 80, h: 80 }, 40, 40, false);
  assertEq(px(o2, 20, 20)[3], 255);
});

suite('证件照 / 保存与流程');

test('限制文件大小：二分画质，压到限制以内；做不到时报告', async () => {
  const c = canvasOf(295, 413, (x) => {
    const d = x.createImageData(295, 413);
    let s = 7;
    for (let i = 0; i < d.data.length; i += 4) { s = (s * 1103515245 + 12345) >>> 0; d.data[i] = s & 255; d.data[i + 1] = (s >> 8) & 255; d.data[i + 2] = (s >> 16) & 255; d.data[i + 3] = 255; }
    x.putImageData(d, 0, 0);
  });
  const full = await encodeJpeg(c);
  assertEq(full.quality, 95);
  const lim = Math.round(full.blob.size * 0.4);
  const r = await encodeJpeg(c, lim);
  assert(r.ok && r.blob.size <= lim, `${r.blob.size} > ${lim}`);
  assert(r.quality < 95 && r.quality >= 10);
  const no = await encodeJpeg(c, 2000);
  assertEq(no.ok, false);
});

function portraitDoc() {
  const W = 1200, H = 1600;
  const source = canvasOf(W, H, (x) => {
    x.fillStyle = '#88aa66'; x.fillRect(0, 0, W, H);
    x.fillStyle = '#e0b090'; x.beginPath(); x.ellipse(550, 560, 170, 250, 0, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#223344'; x.fillRect(250, 900, 600, 700);
  });
  const mask = createCanvas(W, H, { willRead: true });
  const m = mask.getContext('2d');
  m.fillStyle = '#000'; m.beginPath(); m.ellipse(550, 530, 170, 250, 0, 0, Math.PI * 2); m.fill(); m.fillRect(250, 900, 600, 700);
  const doc = createDoc({ source, name: '测试' });
  doc.mask = mask; doc.maskAI = mask; doc.cutout = true; doc.bg.type = 'transparent';
  return doc;
}

test('一键生成：精确像素、底色、300dpi、一步撤销；微调合并成一步', () => {
  const doc = portraitDoc();
  store.setDoc(doc);
  const src0 = doc.source;
  const size = presetSize('one');
  store.commit('生成证件照', (d) => makeIdPhoto(d, { ...G, hairTop: 280, left: 380, right: 720 }, { size, color: 'blue' }));
  assertEq(`${doc.width}x${doc.height}`, '295x413');
  for (const k of ['source', 'mask', 'maskAI']) assertEq(`${doc[k].width}x${doc[k].height}`, '295x413', k);
  assertEq(doc.dpi, 300); assertEq(doc.cutout, true);
  assertEq(doc.bg.type, 'color'); assertEq(doc.bg.color, '#438edb');
  assertEq(doc.idphoto.orig.source, src0, '保留原图');
  assertEq(isStale(doc), false);
  assertEq(px(doc.source, 147, 406)[3], 255, '底部不透明');
  assert(px(doc.mask, 147, 200)[3] > 200, '人在中间');
  assertEq(px(doc.mask, 5, 5)[3], 0, '左上角是背景');
  // 微调: two coalesced commits = one undo step, re-framed from the original
  const s1 = doc.source;
  store.commit('证件照：头部大小', (d) => { d.idphoto.zoom = 110; applyFrame(d, d.idphoto); }, { coalesce: 'idphoto.zoom' });
  store.commit('证件照：头部大小', (d) => { d.idphoto.zoom = 115; applyFrame(d, d.idphoto); }, { coalesce: 'idphoto.zoom' });
  assert(doc.source !== s1);
  assertEq(doc.idphoto.zoom, 115);
  store.endCoalesce();
  // size change keeps the original planes
  store.commit('证件照尺寸', (d) => { d.idphoto.size = presetSize('two'); d.idphoto.preset = 'two'; applyFrame(d, d.idphoto); });
  assertEq(`${doc.width}x${doc.height}`, '413x579');
  assertEq(doc.idphoto.orig.source, src0);
  store.undo();
  assertEq(`${doc.width}x${doc.height}`, '295x413');
  store.undo();
  assertEq(doc.idphoto.zoom, 100);
  assertEq(doc.source, s1, '撤销微调回到生成时');
  store.undo();
  assertEq(doc.source, src0, '撤销生成回到原图');
  assertEq(doc.width, 1200);
  assertEq(doc.idphoto, undefined);
  store.redo();
  assertEq(doc.width, 295);
  assertEq(doc.idphoto.orig.source, src0);
  // an in-place edit after generating marks it stale
  doc.source.__v = (doc.source.__v || 0) + 1;
  assertEq(isStale(doc), true);
  store.setDoc(createDoc({ source: canvasOf(10, 10), name: 'x' }));
});

test('保存证件照：固定点击时的图像/350dpi规格，期间新改动仍保持未保存', async () => {
  const doc = portraitDoc();
  store.setDoc(doc);
  store.commit('生成证件照', (d) => makeIdPhoto(d, G, { size: presetSize('idcard'), color: 'blue' }));
  const el = document.createElement('div'), off = [];
  getPanels().find((p) => p.id === 'idphoto').mount(el, {
    viewport: { addOverlay: () => () => {}, requestOverlay() {} },
    on: (evt, fn) => { const dispose = store.on(evt, fn); off.push(dispose); return dispose; },
    onDispose: (fn) => off.push(fn),
  });
  const real = window.fetch;
  let release, received;
  const waitSave = new Promise((r) => { received = r; });
  const response = new Promise((r) => { release = r; });
  window.fetch = async (url, opts) => {
    if (!String(url).startsWith('/api/save')) return real(url, opts);
    received(JSON.parse(opts.body));
    await response;
    return new Response(JSON.stringify({ path: 'C:\\输出\\证件照测试.jpg' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  let saved;
  const finished = new Promise((r) => { saved = store.on('saved', r); });
  try {
    el.querySelector('.idp-save').click();
    // 模拟已经在后台运行的美颜/其他任务在编码之前完成。
    store.commit('后台更新', (d) => { d.bg.color = '#d9001b'; d.name = '新的未保存照片'; });
    const body = await Promise.race([waitSave, new Promise((_, rej) => setTimeout(() => rej(new Error('证件照保存请求超时')), 5000))]);
    assertEq(body.dpi, 350, '身份证照片写入350dpi');
    assert(body.filename.startsWith('测试_证件照_'), `文件名属于保存时的版本：${body.filename}`);
    const encoded = await dataURLToCanvas(body.data);
    assertEq(`${encoded.width}x${encoded.height}`, '358x441');
    const corner = px(encoded, 5, 5);
    assert(corner[2] > 170 && corner[0] < 120, `保存的是点击时的蓝底：${corner}`);
    release();
    await finished;
    assert(store.dirty, '后台的新改动不能标为已保存');
    assert(!el.querySelector('.idp-save-info').textContent.includes('已保存'), '当前新图不能显示旧图的已保存状态');
  } finally {
    release();
    await Promise.race([finished, new Promise((r) => setTimeout(r, 300))]);
    saved?.(); window.fetch = real;
    off.forEach((fn) => fn()); el.remove();
    document.querySelectorAll('#toasts .toast').forEach((t) => t.remove());
  }
});
