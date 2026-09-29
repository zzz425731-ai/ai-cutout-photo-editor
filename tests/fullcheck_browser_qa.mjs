import {launch} from './cdp.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const base='http://127.0.0.1:7861';
const out=resolve('tests/out/fullcheck-ui');mkdirSync(out,{recursive:true});
const report={scenarios:[],saved:[]};
const reportJson=()=>JSON.stringify(report,(key,value)=>key==='thumb'?undefined:value,2);
let b=await launch({url:base,width:1440,height:1000});
const check=async(expr,msg)=>{if(!await b.eval(expr))throw new Error(msg);};
const panel=async(id)=>{await b.clickSelector(`[data-panel="${id}"]`);await check(`!document.querySelector('.panel-error')`,'面板加载失败 '+id);};
async function clickText(text,scope='#panel') {
  const sel=await b.eval(`(() => {const list=[...document.querySelectorAll(${JSON.stringify(scope+' button')})];const e=list.find(x=>x.textContent.trim()===${JSON.stringify(text)}&&x.getClientRects().length);if(!e)throw new Error('未找到按钮 '+${JSON.stringify(text)});e.dataset.qaClick='1';return '[data-qa-click="1"]';})()`);
  await b.clickSelector(sel);await b.eval(`document.querySelector('[data-qa-click]')?.removeAttribute('data-qa-click')`);
}
async function range(label,value) {
  await b.eval(`(()=>{const e=document.querySelector('input[type="range"][aria-label="${label}"]');if(!e)throw new Error('缺少滑块 ${label}');e.value=${value};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function toggle(label) {
  await b.eval(`(()=>{const e=[...document.querySelectorAll('#panel label.toggle')].find(e=>e.querySelector('.tg-label')?.textContent===${JSON.stringify(label)});if(!e)throw new Error('缺少开关');e.querySelector('input').click();})()`);
}
async function sample(path) {
  await b.eval('__app.store.markSaved()');await b.upload('#file-input',[resolve(path)]);
  const name=path.split('/').pop().replace(/\.[^.]+$/,'');
  await b.waitFor(`__app.store.doc?.name === ${JSON.stringify(name)}`);
}
async function saveFormat(format) {
  await b.eval('window.__saved=null');await b.clickSelector('#btn-export');
  await b.clickSelector(`.export-form [data-value="${format}"]`);
  await clickText('保存到「输出」','.modal');
  await b.waitFor('window.__saved?.path',30000);
  report.saved.push(await b.eval('__saved.path'));
}
async function scenario(name,fn){await fn();report.scenarios.push(name);console.log('PASS '+name);}
try {
  await b.waitFor('document.body.classList.contains("ready")');
  await b.eval('__app.store.on("saved",r=>{window.__saved=r})');
  await sample('tests/out/quality-20260929/real-portrait-export.png');
  await scenario('打开透明PNG / 全部面板加载',async()=>{
    for(const id of ['cutout','background','idphoto','adjust','crop','text','sticker','erase','mosaic','batch'])await panel(id);
    await check('__app.store.doc.cutout && __app.store.doc.mask','透明背景应被保留');
  });
  await scenario('背景：纯色、渐变、图片、虚化、透明、阴影和描边',async()=>{
    await panel('background');
    for(const type of ['color','gradient','image','blur','original','transparent']){
      await b.clickSelector(`.bg-tile[data-type="${type}"]`);
      await check(`__app.store.doc.bg.type==='${type}'`,'背景未切换');
      await b.eval('__app.viewport.renderNow()');
    }
    await b.clickSelector('.bg-tile[data-type="image"]');
    await b.clickSelector('.scene:not(.upload):not(.own)');
    await check('!!__app.store.doc.bg.image','预设背景未载入');
    await b.send('Page.setInterceptFileChooserDialog',{enabled:true});
    await b.clickSelector('.scene.upload');
    await b.upload('body > input[type="file"]:not([id])',[resolve('tests/samples/butterfly.jpg')]);
    await b.send('Page.setInterceptFileChooserDialog',{enabled:false});
    await b.waitFor('__app.store.doc.bg.image?.width===256');
    await toggle('阴影');await toggle('描边');
    await check('__app.store.doc.fx.shadow.on && __app.store.doc.fx.stroke.on','主体效果未启用');
    await b.clickSelector('.bg-tile[data-type="color"]');
    await b.clickSelector('.sw[aria-label="蓝色"]');
  });
  await scenario('调色：一键优化 / 滤镜 / 亮度',async()=>{
    await panel('adjust');await b.clickSelector('.adj-auto-btn');
    await b.clickSelector('.af-tile:not([data-filter="none"])');await range('亮度',12);
    await check('__app.store.doc.adjust.brightness===12 && __app.store.doc.adjust.filter!=="none"','调色未应用');
  });
  await scenario('文字、贴纸和多图层合成',async()=>{
    await panel('text');await b.clickSelector('.text-add');
    await b.eval(`(()=>{const e=document.querySelector('.text-area');e.value='功能检查'+String.fromCharCode(10)+'文字与贴纸';e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await b.clickSelector('.text-b');await range('字号',100);
    await panel('sticker');await b.clickSelector('.sticker-emoji');await b.clickSelector('.sticker-flip');
    await check('__app.store.doc.layers.length===2','图层数量不对');
    await b.eval('__app.viewport.renderNow()');
    await b.screenshot(resolve(out,'composition.png'));
  });
  await scenario('PNG、JPG、WebP实际保存与文件防覆盖',async()=>{
    for(const format of ['png','jpg','webp'])await saveFormat(format);
    await b.eval('window.__saved=null');await b.clickSelector('#btn-save');await b.waitFor('__saved?.path');
    report.saved.push(await b.eval('__saved.path'));
    if(new Set(report.saved).size!==4)throw new Error('保存覆盖了旧文件');
  });
  await scenario('裁剪1:1、旋转、翻转、应用 / 撤销 / 重做',async()=>{
    await panel('crop');await b.clickSelector('[data-ratio="1:1"]');
    await b.clickSelector('.crop-tbtn[aria-label="右转90°"]');
    await b.clickSelector('.crop-tbtn[aria-label="水平翻转"]');
    await clickText('应用');await b.waitFor('__app.store.doc.width===__app.store.doc.height');
    await panel('background');await b.clickSelector('#btn-undo');
    await check('__app.store.doc.width===1280 && __app.store.doc.height===1600','撤销未恢复原尺寸');
    await b.clickSelector('#btn-redo');await check('__app.store.doc.width===__app.store.doc.height','重做裁剪失败');
    await check('__app.store.doc.layers.length===2','裁剪丢失图层');
  });
  await scenario('马赛克 / 模糊 / 框选 / 涂鸦画笔与撤销',async()=>{
    await sample('tests/samples/butterfly.jpg');await panel('mosaic');
    for(const tool of ['mosaic','blur','box','doodle']){
      await b.clickSelector(`.mz-tool[data-tool="${tool}"]`);
      await b.eval('window.__oldPixels=__app.store.doc.source.toDataURL();window.__oldCount=__app.store.historyInfo().undo');
      const points=await b.eval('[[80,70],[120,100],[170,135]].map(([x,y])=>{const p=__app.viewport.toScreen(x,y),r=document.querySelector("#stage").getBoundingClientRect();return [p.x+r.left,p.y+r.top]})');
      await b.drag(points);
      await check('__app.store.historyInfo().undo>__oldCount','画笔未提交 '+tool);
      await b.clickSelector('#btn-undo');
      await check('__app.store.doc.source.toDataURL()===__oldPixels','画笔撤销不一致 '+tool);
      await b.clickSelector('#btn-redo');
    }
  });
  await scenario('批量压缩改尺寸 / 保存两个文件',async()=>{
    await panel('batch');await b.upload('.batch-file-input',[resolve('tests/samples/butterfly.jpg'),resolve('tests/samples/corgi.jpg')]);
    await b.clickSelector('.bt-mode[data-mode="resize"]');
    await b.clickSelector('.bt-chip[data-size="custom"]');
    await b.eval(`(()=>{const e=document.querySelector('.bt-custom-input');e.value='200';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await b.clickSelector('.bt-start');
    await b.waitFor('document.querySelector(".bt-sum-title")?.textContent.includes("完成 2 张")',45000);
    const state=await b.eval('(async()=>{const {batchState:s}=await import("/js/panels/batch.js");return s.items.map(x=>({status:x.status,out:x.out,error:x.reason}));})()');
    report.batch=state;await b.screenshot(resolve(out,'batch.png'));
  });
  if(process.argv.includes('--ai')) {
    await sample('tests/samples/portrait-of-woman.jpg');
    await scenario('美颜实际磨皮、美白 / 恢复原样',async()=>{
      await panel('beauty');await b.eval('window.__beautyBefore=__app.store.doc.source');
      await range('磨皮',35);await range('美白',20);
      await b.waitFor('__app.store.doc.source!==__beautyBefore',60000);
      await b.waitFor('!document.querySelector(".bt-status")?.textContent.includes("正在")',60000);
      await clickText('恢复原样');await b.waitFor('__app.store.doc.source===__beautyBefore',30000);
    });
    await scenario('自动人脸打码与撤销',async()=>{
      await panel('mosaic');await b.eval('window.__faceBefore=__app.store.doc.source.toDataURL();window.__faceUndo=__app.store.historyInfo().undo');
      await b.clickSelector('.mz-face-run');await b.waitFor('__app.store.historyInfo().undo>__faceUndo',60000);
      await check('__app.store.doc.source.toDataURL()!==__faceBefore','人脸区域没有变化');
      await b.clickSelector('#btn-undo');await check('__app.store.doc.source.toDataURL()===__faceBefore','人脸打码撤销失败');
    });
    await scenario('证件照生成、保存和6寸排版图',async()=>{
      await panel('idphoto');await b.clickSelector('.idp-gen');
      await b.waitFor('__app.store.doc.idphoto',60000);
      await b.eval('window.__saved=null');await b.clickSelector('.idp-save');
      await b.waitFor('window.__saved?.path?.includes("证件照")',30000);
      report.saved.push(await b.eval('__saved.path'));
      await clickText('排版打印');await clickText('保存排版图','.modal');
      await b.waitFor('document.querySelector("#toasts")?.textContent.includes("排版图已保存")',30000);
      await b.screenshot(resolve(out,'idphoto.png'));
      report.idphoto=await b.eval('({width:__app.store.doc.width,height:__app.store.doc.height,dpi:__app.store.doc.dpi})');
    });
    await sample('tests/samples/butterfly.jpg');
    await scenario('消除笔真实请求与撤销',async()=>{
      await panel('erase');await b.eval('window.__eraseBefore=__app.store.doc.source');
      const points=await b.eval('[[25,25],[55,40]].map(([x,y])=>{const p=__app.viewport.toScreen(x,y),r=document.querySelector("#stage").getBoundingClientRect();return [p.x+r.left,p.y+r.top]})');
      await b.drag(points);await b.waitFor('__app.store.doc.source!==__eraseBefore',90000);
      await b.clickSelector('#btn-undo');await check('__app.store.doc.source===__eraseBefore','消除撤销失败');
    });
    await scenario('批量真实抠图 / 换底色',async()=>{
      await panel('batch');
      for(const mode of ['cutout','color']) {
        await b.eval('(async()=>{const m=await import("/js/panels/batch.js");window.__batchState=m.batchState;m.clearItems();})()');
        await b.upload('.batch-file-input',[resolve('tests/samples/butterfly.jpg')]);
        await b.clickSelector(`.bt-mode[data-mode="${mode}"]`);await b.clickSelector('.bt-start');
        await b.waitFor('!__batchState.job && __batchState.items.length===1 && __batchState.items.every(x=>x.status==="done")',60000);
        report.batchAi??={};
        report.batchAi[mode]=await b.eval('__batchState.items.map(x=>({status:x.status,out:x.out,error:x.reason}))');
      }
    });
  }
  report.errors=[...b.errors];
  writeFileSync(resolve(out,'browser-report.json'),reportJson());
  // Keep the unit harness separate from the integration editor's live workers and canvases.
  await b.close();
  b=await launch({url:base+'/tests.html',width:1440,height:1000});
  await b.waitFor('document.querySelector("#summary")?.dataset.done==="1"',120000);
  report.unit=await b.eval('({summary:document.querySelector("#summary").textContent,fail:+document.querySelector("#summary").dataset.fail,failures:[...document.querySelectorAll("li.fail")].map(e=>e.textContent)})');
  report.errors.push(...b.errors);
  writeFileSync(resolve(out,'browser-report.json'),reportJson());
  console.log(JSON.stringify({scenarios:report.scenarios.length,unit:report.unit,errors:report.errors}));
  if(report.unit.fail||report.errors.length)throw new Error('检测到回归或浏览器错误');
} catch(err) {
  report.error=String(err);report.errors=b.errors;writeFileSync(resolve(out,'browser-report-failed.json'),reportJson());
  await b.screenshot(resolve(out,'failure.png'));throw err;
} finally {await b.close();}
