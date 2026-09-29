// panels/sticker.js — 贴纸: emoji stickers by category, 添加图片 (optionally 自动抠图 first), per-layer
// size / rotation / opacity / flip, and the shared layer list. The layer transform tool is active here too.

import { registerPanel, showPanel } from '../core/panels.js';
import { store } from '../core/store.js';
import { setTool } from '../core/tools.js';
import { h, section, slider, toggle, button, hint, toast, busy, pickFiles } from '../core/ui.js';
import { icon } from '../core/icons.js';
import { loadImageFile, createCanvas, cropCanvas, readAlpha } from '../core/io.js';
import { matteCanvas } from '../core/api.js';
import { nextFrame } from '../core/actions.js';
import { createEmojiLayer, createImageLayer, layerSize, layerScale, EMOJI_FONT } from '../layers/render-layers.js';
import { selectedLayer, updateLayer, addLayer, placementPoint, kindName } from '../tools/layer-tool.js';
import { layerList } from './text/layer-list.js';

export const EMOJI_CATEGORIES = [
  { id: 'common', name: '常用', list: ['😀', '😂', '🥰', '😍', '😎', '👍', '👏', '🙌', '❤️', '⭐', '🌟', '✨', '🎉', '🌈', '🔥'] },
  { id: 'face', name: '表情', list: ['😊', '😄', '😆', '🤣', '😉', '😘', '😋', '😜', '🤗', '🤔', '😴', '😭', '😡', '😱', '🥳'] },
  { id: 'love', name: '爱心', list: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🤍', '💖', '💗', '💕', '💞', '💘', '💝', '💌', '😻'] },
  { id: 'party', name: '庆祝', list: ['🎉', '🎊', '🎈', '🎁', '🎂', '🍰', '🥂', '🎆', '🎇', '🏮', '🎀', '🏆', '🥇', '👑', '🎵'] },
  { id: 'animal', name: '动物', list: ['🐶', '🐱', '🐰', '🐻', '🐼', '🐨', '🦊', '🐯', '🦁', '🐷', '🐸', '🐵', '🐤', '🦄', '🦋'] },
  { id: 'plant', name: '植物', list: ['🌸', '🌷', '🌹', '🌻', '🌼', '🌺', '💐', '🍀', '🌿', '🌱', '🌳', '🌴', '🍁', '🍂', '🌵'] },
  { id: 'food', name: '食物', list: ['🍎', '🍓', '🍉', '🍊', '🍌', '🍇', '🍒', '🍑', '🍦', '🍩', '🍭', '🍬', '🧁', '🍔', '🍕'] },
  { id: 'symbol', name: '符号', list: ['✅', '❌', '⭕', '❗', '❓', '💯', '🆗', '🆕', '🔝', '➡️', '⬅️', '⬆️', '⬇️', '💬', '💭'] },
];

const MAX_PICTURE = 2048;

/** Bounding box of pixels with alpha > t, or null when fully transparent. */
export function alphaBBox(c, t = 8) {
  const a = readAlpha(c);
  const w = c.width, hgt = c.height;
  let x0 = w, y0 = hgt, x1 = -1, y1 = -1;
  for (let y = 0; y < hgt; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (a[row + x] > t) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Picture + matte result → only the subject (transparent elsewhere), trimmed to its bounds. */
export function subjectOnly(picture, matte) {
  const out = createCanvas(picture.width, picture.height, { willRead: true });
  const c = out.getContext('2d');
  c.drawImage(picture, 0, 0);
  if (matte.fg) c.drawImage(matte.fg.canvas, matte.fg.x, matte.fg.y); // 去色边 patch
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(matte.mask, 0, 0);
  c.globalCompositeOperation = 'source-over';
  const bb = alphaBBox(out);
  if (!bb) return null;
  return bb.w === out.width && bb.h === out.height ? out : cropCanvas(out, bb);
}

function trimTransparent(c) {
  const bb = alphaBBox(c, 2);
  if (!bb || (bb.w === c.width && bb.h === c.height)) return c;
  return cropCanvas(c, bb);
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

registerPanel({
  id: 'sticker',
  title: '贴纸',
  icon: icon('sticker', 22),
  order: 80,
  tip: '表情贴纸、叠加图片',
  mount(el, ctx) {
    setTool('layer');
    const doc = store.doc;
    const long = Math.max(doc.width, doc.height);

    // ---------------------------------------------------------- emoji
    let cat = store.ui.stickerCategory || 'common';
    const tabs = h('div', { class: 'sticker-tabs', role: 'tablist' });
    const grid = h('div', { class: 'sticker-grid' });
    for (const c of EMOJI_CATEGORIES) {
      tabs.append(h('button', { type: 'button', class: 'sticker-tab', role: 'tab', 'data-cat': c.id, onclick: () => { cat = c.id; store.ui.stickerCategory = c.id; paintGrid(); } }, c.name));
    }
    function paintGrid() {
      for (const t of tabs.children) { const on = t.dataset.cat === cat; t.classList.toggle('on', on); t.setAttribute('aria-selected', on ? 'true' : 'false'); }
      const c = EMOJI_CATEGORIES.find((x) => x.id === cat) || EMOJI_CATEGORIES[0];
      grid.replaceChildren(...c.list.map((ch) => h('button', {
        type: 'button', class: 'sticker-emoji', style: { fontFamily: EMOJI_FONT }, 'aria-label': `贴纸 ${ch}`,
        onclick: () => addEmoji(ch),
      }, ch)));
    }
    paintGrid();
    const secEmoji = section('表情贴纸', '点一下就贴到图片中间，再拖到想要的位置');
    secEmoji.append(tabs, grid);

    // ---------------------------------------------------------- picture
    const autoCut = toggle({ label: '自动抠图后添加', hint: '只保留图片里的人或物，去掉它的背景',
      value: !!store.ui.stickerAutoCut, onChange: (v) => { store.ui.stickerAutoCut = v; } });
    const addPic = button({ text: '添加图片', icon: 'imagePlus', variant: 'secondary', block: true, className: 'sticker-addpic', onClick: () => addPicture() });
    const secPic = section('添加图片');
    secPic.append(addPic, autoCut, hint('可以叠加 logo、小图案或另一张照片，支持 JPG、PNG'));

    // ---------------------------------------------------------- selected sticker
    const sizeS = slider({ label: '大小', min: 8, max: Math.max(80, Math.round(long * 1.2)), step: 1, unit: 'px',
      onInput: (v) => setSel('贴纸大小', 'size', (L) => { const { w, h: hh } = layerSize(L); L.scale = v / Math.max(w, hh * (L.sy ?? 1)); }, true) });
    const rotS = slider({ label: '旋转', min: -180, max: 180, step: 1, unit: '°', defaultValue: 0,
      onInput: (v) => setSel('旋转', 'rot', (L) => { L.rotation = (v * Math.PI) / 180; }, true) });
    const opS = slider({ label: '不透明度', min: 0, max: 100, step: 1, unit: '%', defaultValue: 100,
      onInput: (v) => setSel('不透明度', 'op', (L) => { L.opacity = v / 100; }, true) });
    const flipBtn = button({ text: '水平翻转', icon: 'stickerFlip', variant: 'secondary', block: true, className: 'sticker-flip', tip: '左右镜像翻转',
      onClick: () => setSel('水平翻转', 'flip', (L) => { L.flipX = !L.flipX; }) });
    const selBody = h('div', { class: 'sticker-sel' }, sizeS, rotS, opS, flipBtn);
    const emptyCard = h('div', { class: 'text-empty' },
      h('span', { class: 'te-ico', html: icon('sticker', 22) }),
      h('div', { class: 'te-title' }, '还没有选中贴纸'),
      h('div', { class: 'te-text' }, '点上面的贴纸或「添加图片」；点一下图上已有的贴纸，就能在这里调整'));
    const textCard = h('div', { class: 'text-empty other' },
      h('span', { class: 'te-ico', html: icon('text', 22) }),
      h('div', { class: 'te-title' }, '选中的是文字'),
      h('div', { class: 'te-text' }, '改文字内容、字体和颜色，请到「文字」里'),
      button({ text: '去文字面板', icon: 'text', variant: 'secondary', size: 'sm', onClick: () => showPanel('text') }));
    const secSel = section('调整贴纸');
    secSel.append(selBody, emptyCard, textCard);

    const secLayers = layerList(ctx);
    el.append(secEmoji, secPic, secSel, secLayers);

    // ---------------------------------------------------------- actions
    function sel() { const L = selectedLayer(); return L && (L.type === 'emoji' || L.type === 'image') ? L : null; }
    function setSel(label, field, fn, coalesce) {
      const L = sel();
      if (!L) return;
      updateLayer(L.id, label, fn, coalesce ? `sticker.${field}.${L.id}` : null);
    }
    function addEmoji(ch) {
      const d = store.doc;
      if (!d) return;
      const p = placementPoint();
      const px = clamp(Math.round(Math.min(d.width, d.height) * 0.2), 24, 1600);
      addLayer(createEmojiLayer({ char: ch, x: p.x, y: p.y, scale: px / 100 }), `添加贴纸 ${ch}`);
    }
    async function addPicture() {
      const [file] = await pickFiles({ accept: 'image/*' });
      if (!file) return;
      const d = store.doc;
      if (!d) return;
      let pic;
      try {
        pic = await loadImageFile(file, { maxSide: MAX_PICTURE });
      } catch (err) { toast(err.message || '图片打不开', 'error'); return; }
      if (store.doc !== d) return;
      const name = pic.meta?.name || '图片';
      const alpha = !!pic.meta?.hasAlpha; // loadImageFile checks PNG / WebP / GIF for real transparency
      let layerCanvas = pic, label = '添加图片';
      if (alpha) layerCanvas = trimTransparent(pic);
      if (autoCut.getValue()) {
        if (alpha) toast('这张图片本来就是透明背景，已直接添加', 'info');
        else {
          const b = busy('正在抠出图片里的主体…');
          try {
            await nextFrame();
            const r = await matteCanvas(pic, { mode: 'general', decontam: true });
            if (store.doc !== d) return;
            const subj = subjectOnly(pic, r);
            if (subj) { layerCanvas = subj; label = '添加抠好的图片'; }
            else toast('没有在图片里找到明显的主体，已添加整张图片', 'warning');
          } catch (err) {
            toast(`${err.message || '抠图失败'}，已添加整张图片`, 'error');
          } finally { b.done(); }
        }
      }
      if (store.doc !== d) return;
      const p = placementPoint();
      const target = Math.min(d.width, d.height) * 0.45;
      const scale = Math.min(2, target / Math.max(layerCanvas.width, layerCanvas.height));
      addLayer(createImageLayer(layerCanvas, { x: p.x, y: p.y, scale, name }), label);
      if (pic.meta?.downscaled) toast(`图片比较大，已缩小到 ${pic.width}×${pic.height} 再添加`, 'info');
    }

    // ---------------------------------------------------------- sync
    function sync() {
      if (!store.doc) return;
      const any = selectedLayer();
      const L = sel();
      selBody.hidden = !L;
      emptyCard.hidden = !!any;
      textCard.hidden = !(any && any.type === 'text');
      secSel.querySelector('.sec-title').textContent = L ? `调整${kindName(L)}` : '调整贴纸';
      if (!L) return;
      const { w, h: hh } = layerSize(L);
      const { sx, sy } = layerScale(L);
      sizeS.setValue(Math.round(Math.max(w * sx, hh * sy)));
      let deg = Math.round(((L.rotation || 0) * 180) / Math.PI);
      if (deg > 180) deg -= 360; if (deg < -180) deg += 360;
      rotS.setValue(deg);
      opS.setValue(Math.round((L.opacity ?? 1) * 100));
      flipBtn.classList.toggle('on', !!L.flipX);
    }
    ctx.on('doc:changed', (p) => { if (p?.reason !== 'bump') sync(); });
    ctx.on('layer:selected', () => sync());
    ctx.onDispose(() => {
      if (store.ui.panel !== 'text' && store.ui.panel !== 'sticker') {
        store.ui.selectedLayerId = null;
        store.emit('layer:selected', { id: null });
      }
    });
    sync();
    void secLayers;
  },
});
