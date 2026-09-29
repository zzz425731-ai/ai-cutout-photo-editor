// panels/text/layer-list.js — the 图层 list shared by the 文字 and 贴纸 panels (text + sticker + image layers):
// select, 上移 / 下移, 复制, 隐藏, 删除. Also registers the small icons both panels use.
//
//   layerList(ctx) → section element (auto-syncs through ctx.on)

import { store, uidOf } from '../../core/store.js';
import { h, section } from '../../core/ui.js';
import { icon, ICONS } from '../../core/icons.js';
import { thumbDataURL } from '../../core/io.js';
import { EMOJI_FONT, layerLabel } from '../../layers/render-layers.js';
import { selectLayer, selectedLayer, deleteLayer, duplicateLayer, moveLayerOrder, toggleLayerHidden, kindName } from '../../tools/layer-tool.js';

Object.assign(ICONS, {
  textArrowUp: '<path d="M12 19V5M6.5 10.5 12 5l5.5 5.5"/>',
  textArrowDown: '<path d="M12 5v14M6.5 13.5 12 19l5.5-5.5"/>',
  textCopy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5"/>',
  textEyeOff: '<path d="M10.6 5.6c.5-.1.9-.1 1.4-.1 6 0 9.5 6.5 9.5 6.5a16.8 16.8 0 0 1-2.6 3.4M6.6 6.6C4 8.3 2.5 12 2.5 12S6 18.5 12 18.5c1.8 0 3.4-.6 4.8-1.4"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m3.5 3.5 17 17"/>',
  textAlignLeft: '<path d="M4 6h16M4 10.5h10M4 15h16M4 19.5h10"/>',
  textAlignCenter: '<path d="M4 6h16M7 10.5h10M4 15h16M7 19.5h10"/>',
  textAlignRight: '<path d="M4 6h16M10 10.5h10M4 15h16M10 19.5h10"/>',
  textAlignTop: '<path d="M6 4v16M10.5 4v10M15 4v16M19.5 4v10"/>',
  textAlignMiddle: '<path d="M6 4v16M10.5 7v10M15 4v16M19.5 7v10"/>',
  textAlignBottom: '<path d="M6 4v16M10.5 10v10M15 4v16M19.5 10v10"/>',
  textLayers: '<path d="m12 3.5 8.5 4.6L12 12.7 3.5 8.1Z"/><path d="m3.5 12.1 8.5 4.6 8.5-4.6"/><path d="m3.5 16 8.5 4.6 8.5-4.6"/>',
  stickerFlip: '<path d="M12 3v18"/><path d="M9 7.5 4 17h5Z"/><path d="M15 7.5 20 17h-5Z"/>',
  stickerRotate: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v4h-4"/>',
});

const imgThumbs = new WeakMap();
function imageThumb(c) {
  if (!imgThumbs.has(c)) imgThumbs.set(c, thumbDataURL(c, 64, 'image/png'));
  return imgThumbs.get(c);
}
function isLight(hex) {
  const s = String(hex || '').replace('#', '');
  if (s.length < 6) return false;
  const n = parseInt(s.slice(0, 6), 16);
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 200;
}

function thumbOf(L) {
  if (L.type === 'text') {
    const t = h('span', { class: 'tl-thumb tl-text', style: { color: L.color || '#fff' } }, 'T');
    if (isLight(L.color)) t.classList.add('dark');
    return t;
  }
  if (L.type === 'emoji') return h('span', { class: 'tl-thumb tl-emoji', style: { fontFamily: EMOJI_FONT } }, L.char || '');
  if (L.type === 'image' && L.canvas) return h('span', { class: 'tl-thumb tl-img' }, h('img', { src: imageThumb(L.canvas), alt: '' }));
  return h('span', { class: 'tl-thumb' });
}

function toolBtn(ico, text, tip, onClick) {
  const b = h('button', { type: 'button', class: 'tl-tool', 'data-tip': tip, onclick: () => { if (!b.disabled) onClick(); } },
    h('span', { html: icon(ico, 15) }), h('span', {}, text));
  return b;
}

export function layerList(ctx) {
  const list = h('div', { class: 'tl-list', role: 'listbox', 'aria-label': '图层列表' });
  const empty = h('div', { class: 'tl-empty' }, '还没有文字或贴纸。加上之后会显示在这里，最上面的一层盖住下面的。');
  const up = toolBtn('textArrowUp', '上移', '移到上一层（盖住别的）', () => { const L = selectedLayer(); if (L) moveLayerOrder(L.id, 1); });
  const down = toolBtn('textArrowDown', '下移', '移到下一层（被别的盖住）', () => { const L = selectedLayer(); if (L) moveLayerOrder(L.id, -1); });
  const dup = toolBtn('textCopy', '复制', '复制一份', () => { const L = selectedLayer(); if (L) duplicateLayer(L.id); });
  const del = toolBtn('trash', '删除', '删除选中的这一层', () => { const L = selectedLayer(); if (L) deleteLayer(L.id); });
  del.classList.add('danger');
  const tools = h('div', { class: 'tl-tools' }, up, down, dup, del);
  const count = h('span', { class: 'tl-count' });
  const sec = section('图层', null, { right: count });
  sec.classList.add('text-layers');
  sec.append(list, empty, tools);

  let lastSig = '';
  function sync() {
    const d = store.doc;
    const layers = d?.layers || [];
    const selId = store.ui.selectedLayerId;
    // drags commit on every mouse move: rebuild only when something the list shows has changed
    const sig = `${selId}|${layers.map((L) => `${L.id}:${L.hidden ? 1 : 0}:${layerLabel(L)}:${L.color || ''}:${L.canvas ? uidOf(L.canvas) : ''}`).join(',')}`;
    if (sig === lastSig) return;
    lastSig = sig;
    const scroll = list.scrollTop;
    list.innerHTML = '';
    for (let i = layers.length - 1; i >= 0; i--) {
      const L = layers[i];
      const on = L.id === selId;
      const eye = h('button', {
        type: 'button', class: 'tl-eye', 'data-tip': L.hidden ? '显示' : '隐藏', 'aria-label': L.hidden ? `显示${kindName(L)}` : `隐藏${kindName(L)}`,
        html: icon(L.hidden ? 'textEyeOff' : 'eye', 16),
        onclick: (e) => { e.stopPropagation(); toggleLayerHidden(L.id); },
      });
      const row = h('div', {
        class: `tl-row${on ? ' on' : ''}${L.hidden ? ' is-hidden' : ''}`, role: 'option', tabindex: '0', 'aria-selected': on ? 'true' : 'false', 'data-id': L.id,
        onclick: () => selectLayer(L.id),
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectLayer(L.id); } },
      }, thumbOf(L), h('span', { class: 'tl-name' }, layerLabel(L)), eye);
      list.append(row);
    }
    list.scrollTop = scroll;
    const idx = layers.findIndex((l) => l.id === selId);
    empty.hidden = layers.length > 0;
    list.hidden = layers.length === 0;
    tools.hidden = layers.length === 0;
    count.textContent = layers.length ? `${layers.length} 层` : '';
    up.disabled = idx < 0 || idx >= layers.length - 1;
    down.disabled = idx <= 0;
    dup.disabled = idx < 0;
    del.disabled = idx < 0;
    // keep the selected row visible inside the list only (never scroll the whole panel)
    const onRow = list.querySelector('.tl-row.on');
    if (onRow && selId !== lastSel) {
      const top = onRow.offsetTop, bottom = top + onRow.offsetHeight;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
    }
    lastSel = selId;
  }
  let lastSel = null;
  ctx.on('doc:changed', (p) => { if (p?.reason !== 'bump') sync(); });
  ctx.on('layer:selected', sync);
  sec.sync = sync;
  sync();
  return sec;
}
