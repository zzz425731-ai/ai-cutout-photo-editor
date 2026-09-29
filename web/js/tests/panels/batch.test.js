// tests/panels/batch.test.js — 批量: helpers, one-image pipeline (same pixels as the editor's exportDoc,
// incl. the 去色边 fg patch), sequential run, pause / resume / cancel, failures, server-gone auto-pause.
// The AI (matte) and /api/save are replaced by fakes: no server calls, nothing written to 输出.
import { suite, test, assert, assertEq, canvasOf, px, pixels, blobToCanvasT } from '../harness.js';
import { store, createDoc } from '../../core/store.js';
import { exportDoc } from '../../core/exporter.js';
import {
  folderName, outputName, cleanSuffix, maxSideOf, outSize, fmtBytes, summaryText,
  processFile, addFiles, clearItems, removeItem, startBatch, pauseBatch, resumeBatch, cancelBatch, batchState,
} from '../../panels/batch.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 4000) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(10); }
  throw new Error('等待超时');
}

/** opaque test photo: left half orange, right half teal, a 2-px grey stripe in the middle */
function photo(w = 40, h = 30) {
  return canvasOf(w, h, (x) => {
    x.fillStyle = '#e08a2c'; x.fillRect(0, 0, w / 2, h);
    x.fillStyle = '#1f9d9d'; x.fillRect(w / 2, 0, w / 2, h);
    x.fillStyle = '#808080'; x.fillRect(w / 2 - 1, 0, 2, h);
  });
}
async function fileOf(canvas, name, type = 'image/png') {
  const blob = await new Promise((r) => canvas.toBlob(r, type, 0.95));
  return new File([blob], name, { type, lastModified: 1700000000000 + Math.floor(Math.random() * 1e6) });
}
/** mask: left half kept (255), a soft column (128) at the edge, right half removed */
function maskFor(w, h) {
  const c = canvasOf(w, h);
  const x = c.getContext('2d');
  const id = x.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let i = 0; i < w; i++) id.data[(y * w + i) * 4 + 3] = i < w / 2 - 1 ? 255 : i < w / 2 + 1 ? 128 : 0;
  x.putImageData(id, 0, 0);
  return c;
}
/** fake /api/matte: same mask every time + a red 去色边 patch over the soft column */
function fakeMatte(log = []) {
  return async (canvas, opts) => {
    log.push({ w: canvas.width, h: canvas.height, mode: opts.mode });
    const w = canvas.width, h = canvas.height;
    const patch = canvasOf(2, h, (x) => { x.fillStyle = '#ff0000'; x.fillRect(0, 0, 2, h); });
    return { mask: maskFor(w, h), fg: { canvas: patch, x: w / 2 - 1, y: 0 }, ms: 5 };
  };
}
function fakeSave(saved = []) {
  return async (blob, name, opts) => {
    saved.push({ blob, name, subdir: opts?.subdir });
    return { path: `C:\\输出\\${opts?.subdir || ''}\\${name}` };
  };
}
const CFG = { mode: 'cutout', matte: 'general', color: '#438edb', format: 'png', quality: 90, maxSide: null, suffix: '_抠图', subdir: '批量_测试' };

function resetBatch() {
  if (batchState.job) cancelBatch();
  clearItems();
  batchState.summary = null;
}

suite('批量 / 小工具');

test('输出文件夹名 = 批量_年月日_时分', () => {
  assertEq(folderName(new Date(2026, 8, 6, 7, 5)), '批量_20260906_0705');
});

test('文件名 = 原名 + 后缀，去掉非法字符', () => {
  assertEq(outputName('照片', '_抠图', 'png'), '照片_抠图.png');
  assertEq(outputName('a/b:c', '_换*底', 'jpg'), 'abc_换底.jpg');
  assertEq(outputName('', '', 'png'), '图片.png');
  assertEq(cleanSuffix('<_x>?'), '_x');
});

test('尺寸：按长边缩小，从不放大', () => {
  assertEq(maxSideOf('orig', 0), null);
  assertEq(maxSideOf(1080), 1080);
  assertEq(maxSideOf('custom', 640), 640);
  assertEq(maxSideOf('custom', 5), null, '太小的自定义值无效');
  assertEq(maxSideOf('custom', 99999), 4096);
  assertEq(JSON.stringify(outSize(4000, 3000, 1080)), JSON.stringify({ w: 1080, h: 810 }));
  assertEq(JSON.stringify(outSize(300, 200, 1080)), JSON.stringify({ w: 300, h: 200 }));
});

test('文件大小与汇总文字', () => {
  assertEq(fmtBytes(512), '1 KB');
  assertEq(fmtBytes(300 * 1024), '300 KB');
  assertEq(fmtBytes(2.5 * 1024 * 1024), '2.5 MB');
  assertEq(summaryText({ done: 7, failed: 1 }), '完成 7 张，失败 1 张');
});

suite('批量 / 单张处理');

test('抠图（透明PNG）：透明背景、原尺寸、文件名和子文件夹正确', async () => {
  const saved = [], log = [];
  const file = await fileOf(photo(), '小狗.png');
  const r = await processFile(file, CFG, { deps: { matte: fakeMatte(log), save: fakeSave(saved), load: (f) => import('../../core/io.js').then((m) => m.loadImageFile(f)) } });
  assertEq(log.length, 1, '调用了一次 AI 抠图');
  assertEq(saved.length, 1);
  assertEq(saved[0].name, '小狗_抠图.png');
  assertEq(saved[0].subdir, '批量_测试');
  assertEq(saved[0].blob.type, 'image/png');
  assertEq(r.w, 40); assertEq(r.h, 30);
  const out = await blobToCanvasT(saved[0].blob);
  assertEq(out.width, 40); assertEq(out.height, 30);
  assertEq(px(out, 5, 5)[3], 255, '主体不透明');
  assertEq(px(out, 35, 5)[3], 0, '背景透明');
  const p = px(out, 5, 5);
  assert(Math.abs(p[0] - 0xe0) <= 2 && Math.abs(p[1] - 0x8a) <= 2, `主体颜色不变：${p}`);
  assert(r.thumb && r.thumb.startsWith('data:image/'), '有结果缩略图');
});

test('抠图+换底色：和编辑器里「换背景 + 保存」的像素完全一样（含去色边）', async () => {
  const saved = [];
  const src = photo();
  const file = await fileOf(src, 'a.png');
  const cfg = { ...CFG, mode: 'color', color: '#438edb', format: 'png', suffix: '_换底' };
  await processFile(file, cfg, { deps: { matte: fakeMatte(), save: fakeSave(saved) } });
  assertEq(saved[0].name, 'a_换底.png');
  // the editor: same doc built by hand, 去色边 fg = photo with the patch painted over it
  const { loadImageFile } = await import('../../core/io.js');
  const source = await loadImageFile(file);
  const doc = createDoc({ source, name: 'a' });
  const m = await fakeMatte()(source, { mode: 'general' });
  const fg = canvasOf(40, 30, (x) => { x.drawImage(source, 0, 0); x.drawImage(m.fg.canvas, m.fg.x, m.fg.y); });
  Object.assign(doc, { mask: m.mask, fg, cutout: true });
  doc.bg.type = 'color'; doc.bg.color = '#438edb';
  const ref = await blobToCanvasT(await exportDoc(doc, { format: 'png' }));
  const got = await blobToCanvasT(saved[0].blob);
  const A = pixels(ref), B = pixels(got);
  let diff = 0;
  for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) diff++;
  assertEq(diff, 0, '与编辑器导出逐像素一致');
  const bg = px(got, 35, 5);
  assert(Math.abs(bg[0] - 0x43) <= 1 && Math.abs(bg[2] - 0xdb) <= 1 && bg[3] === 255, `背景是蓝色：${bg}`);
  const edge = px(got, 20, 5); // soft column: 去色边 red mixed with the blue background
  assert(edge[0] > 120, `去色边补丁生效：${edge}`);
});

test('只改尺寸和压缩：不调用 AI，按长边缩小，存成 JPG', async () => {
  const saved = [], log = [];
  const file = await fileOf(photo(), 'b.jpg', 'image/jpeg');
  const r = await processFile(file, { ...CFG, mode: 'resize', format: 'jpg', quality: 70, maxSide: 20, suffix: '_压缩' },
    { deps: { matte: fakeMatte(log), save: fakeSave(saved) } });
  assertEq(log.length, 0, '没有抠图');
  assertEq(saved[0].name, 'b_压缩.jpg');
  assertEq(saved[0].blob.type, 'image/jpeg');
  const out = await blobToCanvasT(saved[0].blob);
  assertEq(`${out.width}x${out.height}`, '20x15');
  assertEq(`${r.w}x${r.h}`, '20x15');
  assertEq(px(out, 3, 3)[3], 255);
});

test('本身透明的 PNG：直接用它自己的透明度，不再抠图', async () => {
  const saved = [], log = [];
  const c = canvasOf(30, 20, (x) => { x.fillStyle = '#3366cc'; x.fillRect(0, 0, 15, 20); });
  const file = await fileOf(c, 'logo.png');
  await processFile(file, CFG, { deps: { matte: fakeMatte(log), save: fakeSave(saved) } });
  assertEq(log.length, 0);
  const out = await blobToCanvasT(saved[0].blob);
  assertEq(px(out, 5, 5)[3], 255);
  assertEq(px(out, 25, 5)[3], 0);
});

test('处理完释放画布，并清理渲染缓存', async () => {
  let loaded = null, matted = null, after = 0;
  const { loadImageFile } = await import('../../core/io.js');
  const file = await fileOf(photo(), 'c.png');
  const m0 = fakeMatte();
  await processFile(file, CFG, { deps: {
    load: async (f) => (loaded = await loadImageFile(f)),
    matte: async (cv, o) => (matted = await m0(cv, o)),
    save: fakeSave(), afterItem: () => { after++; },
  } });
  assertEq(loaded.width, 0, '原图画布已释放');
  assertEq(matted.mask.width, 0, '蒙版已释放');
  assertEq(matted.fg.canvas.width, 0, '去色边补丁已释放');
  assertEq(after, 1);
});

test('坏文件给出中文原因', async () => {
  const bad = new File([new Uint8Array([1, 2, 3, 4])], '坏图.jpg', { type: 'image/jpeg' });
  let msg = '';
  try { await processFile(bad, CFG, { deps: { matte: fakeMatte(), save: fakeSave() } }); } catch (e) { msg = e.message; }
  assert(/无法读取|损坏/.test(msg), `原因：${msg}`);
});

suite('批量 / 列表与整批处理');

test('添加图片：跳过非图片、HEIC 和重复的', async () => {
  resetBatch();
  const a = await fileOf(photo(), 'a.png');
  const n = addFiles([a, a, new File(['x'], '说明.txt', { type: 'text/plain' }), new File(['x'], 'IMG_1.HEIC', { type: '' })]);
  assertEq(n, 1);
  assertEq(batchState.items.length, 1);
  assertEq(addFiles([a]), 0, '重复的不再添加');
  assert(removeItem(batchState.items[0].id));
  assertEq(batchState.items.length, 0);
  resetBatch();
});

test('一张一张处理：成功的保存、坏图标成失败，汇总正确，当前图片不受影响', async () => {
  resetBatch();
  const docBefore = store.doc, verBefore = store.version;
  let active = 0, maxActive = 0;
  const m0 = fakeMatte();
  const matte = async (c, o) => { active++; maxActive = Math.max(maxActive, active); await sleep(15); try { return await m0(c, o); } finally { active--; } };
  const saved = [];
  addFiles([await fileOf(photo(), 'p1.png'), new File([new Uint8Array([9, 9, 9])], 'bad.jpg', { type: 'image/jpeg' }), await fileOf(photo(24, 24), 'p3.png')]);
  batchState.opt.mode = 'cutout';
  const s = await startBatch({ matte, save: fakeSave(saved), afterItem: () => {} });
  assertEq(maxActive, 1, '同一时间只处理一张');
  assertEq(s.done, 2); assertEq(s.failed, 1);
  assertEq(saved.length, 2);
  assert(/^批量_\d{8}_\d{4}$/.test(saved[0].subdir), `子文件夹：${saved[0].subdir}`);
  assertEq(saved.map((x) => x.name).join(','), 'p1_抠图.png,p3_抠图.png');
  const st = batchState.items.map((i) => i.status).join(',');
  assertEq(st, 'done,error,done');
  assert(batchState.items[1].reason.length > 0, '失败有原因');
  assertEq(s.folder, `C:\\输出\\${saved[0].subdir}`);
  assert(store.doc === docBefore && store.version === verBefore, '没有碰当前打开的图片');
  // start again → only the failed one is retried
  const saved2 = [];
  const s2 = await startBatch({ matte, save: fakeSave(saved2), afterItem: () => {} });
  assertEq(saved2.length, 0); assertEq(s2.failed, 1); assertEq(s2.done, 0);
  resetBatch();
});

test('暂停 / 继续 / 取消', async () => {
  resetBatch();
  const gates = [];
  const m0 = fakeMatte();
  const matte = (c, o) => new Promise((res) => gates.push(() => res(m0(c, o))));
  const saved = [];
  for (let i = 1; i <= 3; i++) addFiles([await fileOf(photo(20, 20), `q${i}.png`)]);
  const run = startBatch({ matte, save: fakeSave(saved), afterItem: () => {} });
  await waitFor(() => gates.length === 1);
  pauseBatch();                                     // pause while the first image is in the AI step
  gates[0]();                                       // …the first one still finishes
  await waitFor(() => batchState.items[0].status === 'done');
  await sleep(80);
  assertEq(gates.length, 1, '暂停后不再开始下一张');
  assertEq(batchState.items[1].status, 'wait');
  resumeBatch();
  await waitFor(() => gates.length === 2);
  cancelBatch();                                    // cancel during the second image
  gates[1]();
  const s = await run;
  assert(s.cancelled, '已取消');
  assertEq(s.done, 1);
  assertEq(s.left, 2, '没处理的留在列表里');
  assertEq(saved.length, 1, '取消的那张没有保存');
  assertEq(batchState.items.map((i) => i.status).join(','), 'done,wait,wait');
  assert(!batchState.job, '任务已结束');
  resetBatch();
});

test('本地服务断开：自动暂停，图片不算失败', async () => {
  resetBatch();
  addFiles([await fileOf(photo(20, 20), 'n1.png')]);
  const matte = async () => { throw new Error('无法连接到本地服务，请确认「启动抠图P图工具」窗口没有被关闭'); };
  const run = startBatch({ matte, save: fakeSave(), afterItem: () => {} });
  await waitFor(() => batchState.job?.paused && !batchState.job.current);
  assertEq(batchState.items[0].status, 'wait');
  cancelBatch();
  const s = await run;
  assertEq(s.failed, 0); assertEq(s.left, 1);
  resetBatch();
});
