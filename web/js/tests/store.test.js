import { suite, test, assert, assertEq, canvasOf, px } from './harness.js';
import { store, createDoc } from '../core/store.js';
import { createCanvas } from '../core/io.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freshDoc(w = 40, h = 30) {
  const src = canvasOf(w, h, (c) => { c.fillStyle = '#808080'; c.fillRect(0, 0, w, h); });
  const doc = createDoc({ source: src, name: '测试' });
  doc.mask = createCanvas(w, h, { willRead: true });
  store.setHistoryLimits({ maxSteps: 80, maxBytes: 1024 * 1024 * 1024 });
  store.setDoc(doc);
  return doc;
}

suite('store / 历史记录');

test('commit 记录一步，撤销/重做正确', () => {
  const doc = freshDoc();
  assert(!store.canUndo(), '新文档不应能撤销');
  store.commit('改颜色', (d) => { d.bg.color = '#ff0000'; });
  assertEq(doc.bg.color, '#ff0000');
  assert(store.canUndo() && store.dirty, '应可撤销且标记未保存');
  assertEq(store.undoLabel(), '改颜色');
  store.undo();
  assertEq(store.doc.bg.color, '#ffffff', '撤销后');
  assert(store.doc === doc, '撤销后文档对象身份不变');
  assert(store.canRedo());
  store.redo();
  assertEq(store.doc.bg.color, '#ff0000', '重做后');
});

test('相同 coalesce 键 800ms 内合并为一步', () => {
  freshDoc();
  for (let i = 1; i <= 5; i++) store.commit('羽化', (d) => { d.edge.feather = i; }, { coalesce: 'edge.feather' });
  assertEq(store.historyInfo().undo, 1, '合并后的步数');
  assertEq(store.doc.edge.feather, 5);
  store.undo();
  assertEq(store.doc.edge.feather, 0, '一次撤销回到最初');
  assert(!store.canUndo());
});

test('不同键或超时则不合并', async () => {
  freshDoc();
  store.commit('羽化', (d) => { d.edge.feather = 3; }, { coalesce: 'edge.feather' });
  store.commit('收缩', (d) => { d.edge.shift = 2; }, { coalesce: 'edge.shift' });
  assertEq(store.historyInfo().undo, 2);
  await sleep(850);
  store.commit('收缩', (d) => { d.edge.shift = 4; }, { coalesce: 'edge.shift' });
  assertEq(store.historyInfo().undo, 3, '超过 800ms 应另起一步');
  store.undo();
  assertEq(store.doc.edge.shift, 2);
});

test('新的修改会清空重做', () => {
  freshDoc();
  store.commit('a', (d) => { d.bg.type = 'color'; });
  store.undo();
  assert(store.canRedo());
  store.commit('b', (d) => { d.bg.type = 'blur'; });
  assert(!store.canRedo(), '重做应被清空');
});

test('mutate 抛错时回滚且不记录', () => {
  freshDoc();
  let threw = false;
  try { store.commit('坏', (d) => { d.bg.color = '#000000'; throw new Error('x'); }); } catch { threw = true; }
  assert(threw);
  assertEq(store.doc.bg.color, '#ffffff', '应回滚');
  assert(!store.canUndo(), '不应记录');
});

test('整图替换（换画布引用）可撤销', () => {
  const doc = freshDoc();
  const old = doc.source;
  const neu = canvasOf(20, 10);
  store.commit('裁剪', (d) => { d.source = neu; d.width = 20; d.height = 10; });
  assert(store.doc.source === neu);
  store.undo();
  assert(store.doc.source === old, '撤销后恢复原画布对象');
  assertEq(store.doc.width, 40);
  store.redo();
  assert(store.doc.source === neu);
});

test('commitRegion 区域撤销/重做', () => {
  const doc = freshDoc();
  const ctx = doc.mask.getContext('2d');
  const rect = { x: 5, y: 6, w: 10, h: 8 };
  const before = ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
  ctx.fillStyle = '#000'; ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  const v0 = doc.mask.__v || 0;
  store.commitRegion('画笔', 'mask', rect, before);
  assertEq(px(doc.mask, 8, 9)[3], 255, '画后');
  store.undo();
  assertEq(px(doc.mask, 8, 9)[3], 0, '撤销后');
  assert((doc.mask.__v || 0) > v0, '撤销应提升画布版本号');
  store.redo();
  assertEq(px(doc.mask, 8, 9)[3], 255, '重做后');
  assertEq(px(doc.mask, 4, 9)[3], 0, '区域外不受影响');
});

test('区域与整图步骤混合撤销顺序正确', () => {
  const doc = freshDoc();
  const ctx = doc.mask.getContext('2d');
  const r = { x: 0, y: 0, w: 4, h: 4 };
  const b1 = ctx.getImageData(0, 0, 4, 4);
  ctx.fillRect(0, 0, 4, 4);
  store.commitRegion('笔1', 'mask', r, b1);
  const oldMask = doc.mask;
  store.commit('换蒙版', (d) => { d.mask = createCanvas(40, 30, { willRead: true }); });
  store.undo();
  assert(store.doc.mask === oldMask);
  assertEq(px(store.doc.mask, 1, 1)[3], 255);
  store.undo();
  assertEq(px(store.doc.mask, 1, 1)[3], 0);
});

test('内存上限：超出时丢弃最早的步骤', () => {
  const doc = freshDoc(100, 100);
  const ctx = doc.mask.getContext('2d');
  const rect = { x: 0, y: 0, w: 50, h: 50 }; // mask regions are stored alpha-only: before+after = 2 × 2500 B
  store.setHistoryLimits({ maxBytes: 5000 * 3 + 100 });
  for (let i = 0; i < 6; i++) {
    const before = ctx.getImageData(0, 0, 50, 50);
    ctx.fillStyle = `rgba(0,0,0,${(i + 1) / 6})`; ctx.fillRect(0, 0, 50, 50);
    store.commitRegion(`笔${i}`, 'mask', rect, before);
  }
  const info = store.historyInfo();
  assertEq(info.undo, 3, '只保留 3 步');
  assert(info.bytes <= 5000 * 3 + 100, `字节数 ${info.bytes}`);
  assertEq(store.undoLabel(), '笔5', '最新一步保留');
  store.setHistoryLimits({ maxBytes: 1024 * 1024 * 1024, maxSteps: 4 });
  for (let i = 0; i < 6; i++) store.commit(`c${i}`, (d) => { d.edge.feather = i; });
  assertEq(store.historyInfo().undo, 4, '步数上限');
  store.setHistoryLimits({ maxSteps: 80 });
});

test('整图步骤按画布大小计入内存', () => {
  const doc = freshDoc(100, 100); // 40 000 B per plane
  store.setHistoryLimits({ maxBytes: 100000 });
  for (let i = 0; i < 5; i++) store.commit(`换图${i}`, (d) => { d.source = createCanvas(100, 100); });
  const info = store.historyInfo();
  assert(info.bytes <= 100000, `字节数 ${info.bytes}`);
  assert(info.undo >= 1 && info.undo <= 3, `步数 ${info.undo}`);
  store.setHistoryLimits({ maxBytes: 1024 * 1024 * 1024 });
  void doc;
});

test('bump 记录脏区域并触发 doc:changed', () => {
  const doc = freshDoc();
  let got = null;
  const off = store.on('doc:changed', (p) => { got = p; });
  const v = doc.mask.__v || 0;
  store.bump('mask', { x: 1, y: 2, w: 3, h: 4 });
  off();
  assertEq(doc.mask.__v, v + 1);
  assertEq(got?.reason, 'bump');
  assertEq(doc.mask.__log[doc.mask.__log.length - 1].rect.w, 3);
});
