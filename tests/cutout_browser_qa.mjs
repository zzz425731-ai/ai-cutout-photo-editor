// Browser regression suite and real cutout-panel interaction smoke test.
import { launch } from './cdp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const base = process.argv[2] || 'http://127.0.0.1:7861';
const output = resolve('tests/out/quality-20260929');
mkdirSync(output, { recursive: true });
const b = await launch({ url: `${base}/tests.html`, width: 1440, height: 1000 });
try {
  await b.waitFor('document.querySelector("#summary")?.dataset.done === "1"', 120000);
  const suite = await b.eval('({ summary:document.querySelector("#summary").textContent, fail:+document.querySelector("#summary").dataset.fail, failures:Array.from(document.querySelectorAll("li.fail")).map(e=>e.textContent) })');
  console.log(JSON.stringify(suite));
  if (suite.fail) throw new Error('Browser regressions failed');
  await b.goto(base);
  await b.waitFor('window.__app');
  // A narrow partially transparent strand on an opaque subject makes preview
  // inspection and fractional edge adjustments observable without model timing.
  await b.eval(`(async () => {
    const a=window.__app, {createDoc}=await import('/js/core/store.js');
    const source=a.io.createCanvas(480,640), c=source.getContext('2d');
    c.fillStyle='#754338';c.fillRect(0,0,480,640);
    const d=createDoc({source,name:'边缘检查测试'});
    d.mask=a.io.createCanvas(480,640); const m=d.mask.getContext('2d');
    m.fillStyle='#000';m.fillRect(110,90,240,500);m.globalAlpha=.5;m.fillRect(109,90,1,450);
    d.maskAI=a.io.cloneCanvas(d.mask);d.cutout=true;d.bg.type='transparent';
    a.store.setDoc(d);a.panels.showPanel('cutout');
  })()`);
  await b.clickSelector('.cut-inspection [data-value="black"]');
  const black = await b.eval('({mode:__app.viewport.inspection,bg:__app.store.doc.bg.type,dirty:__app.store.dirty})');
  if (black.mode !== 'black' || black.bg !== 'transparent' || black.dirty) throw new Error('Inspection changed document');
  await b.eval(`(() => { const e=document.querySelector('input[aria-label="收缩 / 扩展"]');e.value='-0.25';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  if (await b.eval('__app.store.doc.edge.shift') !== -0.25) throw new Error('Fractional shift missing');
  await b.screenshot(resolve(output, 'cutout-panel.png'));
  await b.clickSelector('.cut-inspection [data-value="alpha"]');
  const exported = await b.eval(`(async () => {
    const {exportDoc}=await import('/js/core/exporter.js');
    const blob=await exportDoc(__app.store.doc,{format:'png'});
    const im=await createImageBitmap(blob), c=__app.io.createCanvas(im.width,im.height);c.getContext('2d').drawImage(im,0,0);
    const p=c.getContext('2d').getImageData(0,0,1,1).data; im.close(); return p[3];
  })()`);
  if (exported !== 0) throw new Error('Inspection leaked into exported PNG');
  await b.clickSelector('[data-panel="background"]');
  if (await b.eval('__app.viewport.inspection') !== null) throw new Error('Inspection persisted after leaving cutout');
  await b.key('z', {ctrl:true});
  if (await b.eval('__app.store.doc.edge.shift') !== 0) throw new Error('Edge undo failed');
  const report = {suite,smoke:'passed',errors:b.errors};
  if (process.argv.includes('--real')) {
    await b.eval('__app.store.markSaved()');
    await b.upload('#file-input', [resolve('tests/samples/portrait-of-woman.jpg')]);
    await b.waitFor('__app.store.doc?.width === 2550');
    await b.clickSelector('[data-panel="cutout"]');
    await b.clickSelector('.seg-btn[data-value="portrait"]');
    await b.clickSelector('.cut-run');
    await b.waitFor('__app.store.doc?.maskAI?.__matte?.mode === "portrait"', 120000);
    await b.clickSelector('.cut-inspection [data-value="black"]');
    await b.waitFor('__app.viewport.previewScale > 0');
    await b.screenshot(resolve(output,'real-portrait.png'));
    report.real = await b.eval(`(async () => {
      const a=__app, d=a.store.doc;
      if(!d.fg) throw new Error('Missing decontaminated foreground');
      const fg=d.fg;
      await a.actions.setDecontam(false);
      if(d.fg!==null) throw new Error('Decontam disable failed');
      await a.actions.setDecontam(true);
      if(d.fg!==fg) throw new Error('Decontam restore failed');
      const {exportDoc}=await import('/js/core/exporter.js');
      const blob=await exportDoc(d,{format:'png',maxSide:1600});
      const bitmap=await createImageBitmap(blob), c=a.io.createCanvas(bitmap.width,bitmap.height);
      c.getContext('2d').drawImage(bitmap,0,0); bitmap.close();
      const pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      let clear=0,soft=0,opaque=0;
      for(let i=3;i<pixels.length;i+=4) {if(pixels[i]===0)clear++;else if(pixels[i]===255)opaque++;else soft++;}
      if(!clear||!soft||!opaque) throw new Error('PNG alpha coverage missing');
      const data=await a.io.blobToDataURL(blob);
      return {width:c.width,height:c.height,clear,soft,opaque,ms:d.maskAI.__matte.ms,data};
    })()`);
    writeFileSync(resolve(output,'real-portrait-export.png'), Buffer.from(report.real.data.split(',')[1],'base64'));
    delete report.real.data;
  }
  writeFileSync(resolve(output, 'browser-report.json'), JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
  if (b.errors.length) throw new Error('Browser errors');
} finally { await b.close(); }
