import { suite, test, assert, assertEq, canvasOf, px } from './harness.js';
import { store, createDoc } from '../core/store.js';
import { saveToOutput } from '../core/actions.js';
import { dataURLToCanvas } from '../core/io.js';

suite('保存 / 后台编辑与图片切换');
function newDoc(name='保存测试', color='#ff0000') {
  const source=canvasOf(10,10,c=>{c.fillStyle=color;c.fillRect(0,0,10,10);});
  store.setDoc(createDoc({source,name}));
  store.commit('待保存编辑',d=>{d.dpi=300;});
  return store.doc;
}
async function saveDuring(change, immediate=null) {
  const original=globalThis.fetch;
  let payload;
  globalThis.fetch=async (url,opts)=>{
    if(String(url)==='/api/save') {
      payload=JSON.parse(opts.body);
      change?.();
      return new Response(JSON.stringify({path:'测试输出/'+payload.filename}),{headers:{'Content-Type':'application/json'}});
    }
    return original(url,opts);
  };
  try {
    const pending=saveToOutput({format:'png'}); immediate?.();
    assert(await pending,'应成功写入');
    return payload;
  } finally {globalThis.fetch=original;}
}
test('内容未变时正常标记已保存',async()=>{
  newDoc();const p=await saveDuring();
  assertEq(store.dirty,false);assertEq(p.dpi,300);
});
test('写盘期间的新编辑保持未保存，已保存文件仍是原来内容',async()=>{
  newDoc();
  const p=await saveDuring(()=>store.commit('后台美颜',d=>{d.adjust.brightness=40;}));
  assert(store.dirty,'后台编辑不能被错误标记已保存');
  assertEq(px(await dataURLToCanvas(p.data),0,0).join(','),'255,0,0,255');
});
test('保存过程中换图，不会把另一张图标记已保存',async()=>{
  newDoc('旧图片');
  const p=await saveDuring(()=>newDoc('新图片','#00ff00'));
  assert(store.dirty);assertEq(store.doc.name,'新图片');
  assert(p.filename.startsWith('旧图片'),'文件名属于保存时的图片');
});
test('开始导出后后台替换照片，导出的像素和名称来自同一快照',async()=>{
  newDoc('红图');
  const p=await saveDuring(null,()=>store.commit('后台完成',d=>{
    d.source=canvasOf(10,10,c=>{c.fillStyle='#0000ff';c.fillRect(0,0,10,10);});d.name='蓝图';
  }));
  assert(p.filename.startsWith('红图'));
  assertEq(px(await dataURLToCanvas(p.data),0,0).join(','),'255,0,0,255');
  assert(store.dirty);
});
