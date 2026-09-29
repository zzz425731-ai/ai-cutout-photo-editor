// panels/background.js — 背景: 原背景/透明/纯色/渐变/图片/虚化 + 主体效果 (阴影、描边).

import { registerPanel } from '../core/panels.js';
import { store, uidOf, DEFAULT_FX } from '../core/store.js';
import { h, section, slider, toggle, segmented, colorSwatches, button, hint, toast, pickFiles } from '../core/ui.js';
import { icon } from '../core/icons.js';
import { ensureCutout } from '../core/actions.js';
import { loadImageFile, thumbDataURL, createCanvas } from '../core/io.js';

/** Common ID-photo background colours (exported for the 证件照 panel). */
export const ID_COLORS = [
  { value: '#ffffff', name: '白色' },
  { value: '#438edb', name: '蓝色' },
  { value: '#d9001b', name: '红色' },
  { value: '#1f4e9e', name: '深蓝' },
  { value: '#8ec5f0', name: '浅蓝' },
  { value: '#e6e8eb', name: '浅灰' },
];
export const COMMON_COLORS = [
  { value: '#f7f2e8', name: '米白' },
  { value: '#fadbe2', name: '浅粉' },
  { value: '#d5f1e4', name: '薄荷绿' },
  { value: '#d8ebff', name: '天空蓝' },
  { value: '#e8e0fa', name: '淡紫' },
  { value: '#fff1c2', name: '奶黄' },
  { value: '#40464f', name: '深灰' },
  { value: '#111111', name: '黑色' },
];
export const GRADIENTS = [
  { name: '晨曦', c1: '#ffd3a5', c2: '#fd6585' },
  { name: '天空', c1: '#a1c4fd', c2: '#c2e9fb' },
  { name: '薄荷', c1: '#d4fc79', c2: '#96e6a1' },
  { name: '薰衣草', c1: '#e0c3fc', c2: '#8ec5fc' },
  { name: '蜜桃', c1: '#fbc2eb', c2: '#a6c1ee' },
  { name: '云雾', c1: '#f5f7fa', c2: '#c3cfe2' },
  { name: '暖阳', c1: '#f6d365', c2: '#fda085' },
  { name: '深海', c1: '#43cea2', c2: '#185a9d' },
];
const STROKE_COLORS = [
  { value: '#ffffff', name: '白色' }, { value: '#111111', name: '黑色' }, { value: '#3464f0', name: '蓝色' },
  { value: '#ffd43b', name: '黄色' }, { value: '#ff8fab', name: '粉色' },
];

const TYPES = [
  { id: 'original', name: '原背景' },
  { id: 'transparent', name: '透明' },
  { id: 'color', name: '纯色' },
  { id: 'gradient', name: '渐变' },
  { id: 'image', name: '图片' },
  { id: 'blur', name: '虚化' },
];

// ---------------------------------------------------------------- procedural scene backgrounds
function rng(seed) { let s = seed >>> 0; return () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9 >>> 0) / 4294967296); }
function radial(ctx, w, h, c1, c2, cx = 0.5, cy = 0.42) {
  const g = ctx.createRadialGradient(w * cx, h * cy, 0, w * cx, h * cy, Math.hypot(w, h) * 0.62);
  g.addColorStop(0, c1); g.addColorStop(1, c2);
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
}
function bokeh(ctx, w, h, colors, n, seed, blur) {
  const r = rng(seed);
  ctx.save();
  ctx.filter = `blur(${blur}px)`;
  ctx.globalCompositeOperation = 'screen';
  for (let i = 0; i < n; i++) {
    const rad = (0.02 + r() * 0.07) * w;
    ctx.globalAlpha = 0.18 + r() * 0.35;
    ctx.fillStyle = colors[Math.floor(r() * colors.length)];
    ctx.beginPath(); ctx.arc(r() * w, r() * h, rad, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}
export const SCENES = [
  { id: 'studio-gray', name: '影棚灰', draw: (c, w, h) => radial(c, w, h, '#f4f5f6', '#8d949d') },
  { id: 'studio-blue', name: '影棚蓝', draw: (c, w, h) => radial(c, w, h, '#eef4ff', '#5d7fb8') },
  { id: 'studio-warm', name: '暖调影棚', draw: (c, w, h) => radial(c, w, h, '#fff6ea', '#c99a72') },
  { id: 'bokeh-warm', name: '暖光斑', draw: (c, w, h) => { radial(c, w, h, '#ffe9cc', '#e7925a', 0.5, 0.3); bokeh(c, w, h, ['#fff4d6', '#ffd08a', '#ffb36b', '#ffffff'], 46, 7, w * 0.006); } },
  { id: 'bokeh-night', name: '夜景光斑', draw: (c, w, h) => { radial(c, w, h, '#2a3668', '#0b1027', 0.5, 0.35); bokeh(c, w, h, ['#6fb7ff', '#ff7ac6', '#ffd36b', '#8cf5d2'], 60, 11, w * 0.005); } },
  { id: 'fresh', name: '清新', draw: (c, w, h) => {
    const g = c.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#dff7ee'); g.addColorStop(1, '#cfe6ff');
    c.fillStyle = g; c.fillRect(0, 0, w, h); bokeh(c, w, h, ['#ffffff', '#e8fff6', '#f0f7ff'], 26, 3, w * 0.008);
  } },
];
const sceneCache = new Map();
function sceneCanvas(s) {
  let c = sceneCache.get(s.id);
  if (!c) { c = createCanvas(1600, 1200); s.draw(c.getContext('2d'), 1600, 1200); c.__scene = s.id; sceneCache.set(s.id, c); }
  return c;
}
const sceneThumbs = new Map();
function sceneThumb(s) {
  if (!sceneThumbs.has(s.id)) sceneThumbs.set(s.id, thumbDataURL(sceneCanvas(s), 150));
  return sceneThumbs.get(s.id);
}

const canvasThumbs = new WeakMap();
function canvasThumb(c) {
  if (!canvasThumbs.has(c)) canvasThumbs.set(c, thumbDataURL(c, 150));
  return canvasThumbs.get(c);
}

// thumbnails of the current photo (for 原背景 / 虚化 tiles)
const photoThumbs = new Map();
function photoThumb(doc) {
  const k = uidOf(doc.source);
  if (!photoThumbs.has(k)) { photoThumbs.clear(); photoThumbs.set(k, thumbDataURL(doc.source, 160)); }
  return photoThumbs.get(k);
}

registerPanel({
  id: 'background',
  title: '背景',
  icon: 'background',
  order: 20,
  tip: '换成纯色、渐变、图片或虚化背景',
  mount(el, ctx) {
    // ---------------------------------------------------------- type tiles
    const tiles = new Map();
    const grid = h('div', { class: 'bg-tiles' });
    for (const t of TYPES) {
      const prev = h('span', { class: `bt-prev bt-${t.id}` });
      const b = h('button', { type: 'button', class: 'bg-tile', 'data-type': t.id, 'aria-label': t.name, onclick: () => chooseType(t.id) },
        prev, h('span', { class: 'bt-name' }, t.name));
      tiles.set(t.id, { b, prev });
      grid.append(b);
    }
    const secType = section('背景类型');
    const cutHint = h('div', { class: 'bg-cut-hint' }, h('span', { html: icon('info', 16) }), h('span', {}, '换背景前会先自动抠出主体'));
    secType.append(grid, cutHint);

    const optsWrap = h('div', { class: 'bg-opts' });
    let optsType = null;

    // ---------------------------------------------------------- subject effects
    // Effect sizes are doc pixels and tuned for ~1000-px photos: on bigger photos the defaults and slider
    // ranges grow with the image, so a 4096-px photo gets a visible shadow / outline too.
    const k = Math.max(1, Math.max(store.doc.width, store.doc.height) / 1000);
    const FXD = { blur: Math.round(DEFAULT_FX.shadow.blur * k), dy: Math.round(DEFAULT_FX.shadow.dy * k), width: Math.round(DEFAULT_FX.stroke.width * k) };
    const fx = store.doc.fx;
    const shadowOn = toggle({ label: '阴影', hint: '在主体下方加一层投影，更有立体感', value: fx.shadow.on,
      onChange: (v) => fxToggle('shadow', v) });
    const shBlur = slider({ label: '柔和', min: 0, max: Math.round(120 * k), value: fx.shadow.blur, unit: 'px', defaultValue: FXD.blur,
      onInput: (v) => fxSet('阴影柔和', 'shadow.blur', (d) => { d.fx.shadow.blur = v; }) });
    const shDist = slider({ label: '上下位置', min: -Math.round(80 * k), max: Math.round(120 * k), value: fx.shadow.dy, unit: 'px', defaultValue: FXD.dy,
      onInput: (v) => fxSet('阴影位置', 'shadow.dy', (d) => { d.fx.shadow.dy = v; }) });
    const shDx = slider({ label: '左右位置', min: -Math.round(120 * k), max: Math.round(120 * k), value: fx.shadow.dx, unit: 'px', defaultValue: 0,
      onInput: (v) => fxSet('阴影位置', 'shadow.dx', (d) => { d.fx.shadow.dx = v; }) });
    const shOp = slider({ label: '浓度', min: 0, max: 100, value: Math.round(fx.shadow.opacity * 100), unit: '%', defaultValue: 35,
      onInput: (v) => fxSet('阴影浓度', 'shadow.opacity', (d) => { d.fx.shadow.opacity = v / 100; }) });
    const shBox = h('div', { class: 'fx-sub' }, shBlur, shDist, shDx, shOp);

    const strokeOn = toggle({ label: '描边', hint: '给主体加一圈边，像贴纸一样', value: fx.stroke.on,
      onChange: (v) => fxToggle('stroke', v) });
    const stWidth = slider({ label: '粗细', min: 1, max: Math.round(80 * k), value: fx.stroke.width, unit: 'px', defaultValue: FXD.width,
      onInput: (v) => fxSet('描边粗细', 'stroke.width', (d) => { d.fx.stroke.width = v; }) });
    const stColor = colorSwatches({ colors: STROKE_COLORS, value: fx.stroke.color,
      onChange: (v) => fxSet('描边颜色', 'stroke.color', (d) => { d.fx.stroke.color = v; }) });
    const stBox = h('div', { class: 'fx-sub' }, stWidth, h('div', { class: 'field-label' }, '描边颜色'), stColor);

    const secFx = section('主体效果', '抠图后才能使用');
    secFx.append(shadowOn, shBox, strokeOn, stBox);

    el.append(secType, optsWrap, secFx);

    // ---------------------------------------------------------- actions
    function apply(label, fn, coalesce) {
      const d = store.doc;
      if (!d) return;
      if (d.cutout && d.mask) store.commit(label, fn, coalesce ? { coalesce } : undefined);
      else ensureCutout(fn, { label });
    }
    function chooseType(t) {
      const d = store.doc;
      const name = TYPES.find((x) => x.id === t).name;
      if (t === 'original') { store.commit('背景：原背景', (dd) => { dd.bg.type = 'original'; }); return; }
      if (t === 'color' && d.bg.type !== 'color') {
        const c = store.ui.lastColor || '#ffffff';
        apply('背景：纯色', (dd) => { dd.bg.type = 'color'; dd.bg.color = c; });
        return;
      }
      if (t === 'gradient' && d.bg.type !== 'gradient') {
        const g = store.ui.lastGradient || GRADIENTS[1];
        apply('背景：渐变', (dd) => { dd.bg.type = 'gradient'; dd.bg.color = g.c1; dd.bg.color2 = g.c2; dd.bg.angle = g.angle ?? dd.bg.angle; });
        return;
      }
      if (t === 'image' && !d.bg.image) {
        const sc = sceneCanvas(SCENES[0]);
        apply(`背景：${name}`, (dd) => { dd.bg.type = 'image'; dd.bg.image = sc; });
        return;
      }
      apply(`背景：${name}`, (dd) => { dd.bg.type = t; });
    }
    function fxToggle(which, on) {
      const d = store.doc;
      const label = which === 'shadow' ? (on ? '添加阴影' : '去掉阴影') : (on ? '添加描边' : '去掉描边');
      const set = (dd) => {
        dd.fx[which].on = on;
        if (!on || k === 1) return;
        // first use on a big photo: scale the untouched defaults to the image size
        const f = dd.fx[which], D = DEFAULT_FX[which];
        if (which === 'shadow' && f.blur === D.blur && f.dy === D.dy && f.dx === D.dx) { f.blur = FXD.blur; f.dy = FXD.dy; }
        if (which === 'stroke' && f.width === D.width) f.width = FXD.width;
      };
      if (on && !(d.cutout && d.mask)) {
        ensureCutout(set, { label, reason: '阴影和描边需要先把主体抠出来。' }).then(() => sync());
        return;
      }
      store.commit(label, set);
    }
    function fxSet(label, key, fn) { store.commit(label, fn, { coalesce: `fx.${key}` }); }

    // ---------------------------------------------------------- options per type
    function buildOptions(type) {
      optsWrap.innerHTML = '';
      optsType = type;
      const d = store.doc;
      if (type === 'original') {
        optsWrap.append(section('原背景', d.cutout ? '保留原来的背景。主体已抠出，可以在下面加阴影或描边' : '保留原来的背景。选择其他背景时，会先自动抠图'));
      } else if (type === 'transparent') {
        const s = section('透明背景', '棋盘格表示透明。点「保存」会自动存成透明 PNG，适合做贴纸、放进 PPT');
        optsWrap.append(s);
      } else if (type === 'color') {
        const s = section('颜色');
        const setColor = (v, coalesce) => apply('背景颜色', (dd) => { dd.bg.type = 'color'; dd.bg.color = v; }, coalesce);
        const idSw = colorSwatches({ colors: ID_COLORS, value: d.bg.color, custom: false, onChange: (v) => setColor(v) });
        const moreSw = colorSwatches({ colors: COMMON_COLORS, value: d.bg.color, custom: true,
          onChange: (v) => setColor(v), onInput: (v) => setColor(v, 'bg.color') });
        s.append(h('div', { class: 'field-label' }, '证件照底色'), idSw, h('div', { class: 'field-label mt' }, '更多颜色'), moreSw);
        optsWrap.append(s);
        optsWrap._sync = (dd) => {
          const c = String(dd.bg.color).toLowerCase();
          const inId = ID_COLORS.some((x) => x.value === c);
          idSw.setValue(inId ? c : '');
          moreSw.setValue(inId ? '' : c);
        };
      } else if (type === 'gradient') {
        const s = section('渐变');
        const presets = h('div', { class: 'grad-grid' });
        const chips = [];
        for (const g of GRADIENTS) {
          const b = h('button', { type: 'button', class: 'grad-chip', 'data-tip': g.name, 'aria-label': g.name,
            style: { background: `linear-gradient(180deg, ${g.c1}, ${g.c2})` },
            onclick: () => apply('渐变背景', (dd) => { dd.bg.type = 'gradient'; dd.bg.color = g.c1; dd.bg.color2 = g.c2; }) });
          b._g = g; chips.push(b); presets.append(b);
        }
        const dir = segmented({ block: true, size: 'sm', value: d.bg.angle, options: [
          { value: 180, label: '↓ 上下' }, { value: 90, label: '→ 左右' }, { value: 135, label: '↘ 斜下' }, { value: 45, label: '↗ 斜上' }],
        onChange: (v) => apply('渐变方向', (dd) => { dd.bg.angle = v; }) });
        const c1 = colorPick(d.bg.color, (v) => apply('渐变颜色', (dd) => { dd.bg.type = 'gradient'; dd.bg.color = v; }, 'bg.grad1'));
        const c2 = colorPick(d.bg.color2, (v) => apply('渐变颜色', (dd) => { dd.bg.type = 'gradient'; dd.bg.color2 = v; }, 'bg.grad2'));
        s.append(presets, h('div', { class: 'field-label mt' }, '方向'), dir,
          h('div', { class: 'field-label mt' }, '自定义颜色'),
          h('div', { class: 'grad-custom' }, c1.el, h('span', { class: 'gc-arrow', html: icon('chevronRight', 16) }), c2.el));
        optsWrap.append(s);
        optsWrap._sync = (dd) => {
          dir.setValue(dd.bg.angle); c1.set(dd.bg.color); c2.set(dd.bg.color2);
          for (const b of chips) b.classList.toggle('on', dd.bg.type === 'gradient' && b._g.c1 === dd.bg.color && b._g.c2 === dd.bg.color2);
        };
      } else if (type === 'image') {
        const s = section('背景图片', '图片会自动铺满画面');
        const gridS = h('div', { class: 'scene-grid' });
        const upload = h('button', { type: 'button', class: 'scene upload', 'data-tip': '用自己的图片做背景', onclick: uploadBg },
          h('span', { html: icon('upload', 22) }), h('span', { class: 'sc-name' }, '上传图片'));
        gridS.append(upload);
        const items = [];
        for (const sc of SCENES) {
          const b = h('button', { type: 'button', class: 'scene', 'aria-label': sc.name,
            onclick: () => { const c = sceneCanvas(sc); apply(`背景：${sc.name}`, (dd) => { dd.bg.type = 'image'; dd.bg.image = c; }); } },
          h('img', { src: sceneThumb(sc), alt: '' }), h('span', { class: 'sc-name' }, sc.name));
          b._id = sc.id; items.push(b); gridS.append(b);
        }
        const own = h('button', { type: 'button', class: 'scene own', hidden: true, 'aria-label': '我的图片', onclick: () => {} },
          h('img', { alt: '' }), h('span', { class: 'sc-name' }, '我的图片'));
        gridS.insertBefore(own, gridS.children[1]);
        s.append(gridS);
        optsWrap.append(s);
        optsWrap._sync = (dd) => {
          const img = dd.bg.image;
          const sid = img?.__scene;
          for (const b of items) b.classList.toggle('on', dd.bg.type === 'image' && b._id === sid);
          if (img && !sid) {
            own.hidden = false;
            if (own._src !== img) { own._src = img; own.querySelector('img').src = canvasThumb(img); }
            own.classList.toggle('on', dd.bg.type === 'image');
          } else own.hidden = true;
        };
      } else if (type === 'blur') {
        const s = section('背景虚化', '模拟相机大光圈，让背景变模糊、主体更突出');
        const bl = slider({ label: '虚化程度', min: 4, max: 80, value: d.bg.blur, defaultValue: 24,
          onInput: (v) => apply('虚化程度', (dd) => { dd.bg.type = 'blur'; dd.bg.blur = v; }, 'bg.blur') });
        s.append(bl);
        optsWrap.append(s);
        optsWrap._sync = (dd) => bl.setValue(dd.bg.blur);
      }
    }

    function colorPick(value, onChange) {
      const input = h('input', { type: 'color', value, class: 'cp-input', tabindex: '-1', 'aria-hidden': 'true' });
      const btn = h('button', { type: 'button', class: 'cp-btn', 'data-tip': '点击选择颜色', onclick: () => input.click() }, h('span', { class: 'cp-dot' }), h('span', { class: 'cp-hex' }));
      const set = (v) => { input.value = v; btn.style.setProperty('--c', v); btn.querySelector('.cp-hex').textContent = v.toUpperCase(); };
      input.addEventListener('input', () => { set(input.value); onChange(input.value); });
      input.addEventListener('change', () => store.endCoalesce()); // picker closed → next change is a new step
      set(value);
      return { el: h('span', { class: 'cp' }, btn, input), set };
    }

    async function uploadBg() {
      const [f] = await pickFiles({ accept: 'image/*' });
      if (!f) return;
      try {
        const c = await loadImageFile(f);
        apply('背景：我的图片', (dd) => { dd.bg.type = 'image'; dd.bg.image = c; });
      } catch (err) { toast(err.message, 'error'); }
    }

    // ---------------------------------------------------------- sync
    function sync() {
      const d = store.doc;
      if (!d) return;
      const cut = !!(d.cutout && d.mask);
      const type = cut ? d.bg.type : 'original';
      for (const [id, t] of tiles) {
        t.b.classList.toggle('on', id === type);
        t.b.setAttribute('aria-pressed', id === type ? 'true' : 'false');
      }
      const thumb = photoThumb(d);
      tiles.get('original').prev.style.backgroundImage = `url(${thumb})`;
      tiles.get('blur').prev.style.setProperty('--img', `url(${thumb})`);
      if (d.bg.type === 'color') store.ui.lastColor = d.bg.color;
      tiles.get('color').prev.style.background = d.bg.type === 'color' ? d.bg.color : (store.ui.lastColor || '#ffffff');
      if (d.bg.type === 'gradient') store.ui.lastGradient = { c1: d.bg.color, c2: d.bg.color2, angle: d.bg.angle };
      const lg = d.bg.type === 'gradient' ? { c1: d.bg.color, c2: d.bg.color2, angle: d.bg.angle } : (store.ui.lastGradient || { ...GRADIENTS[1], angle: 180 });
      tiles.get('gradient').prev.style.background = `linear-gradient(${lg.angle}deg, ${lg.c1}, ${lg.c2})`;
      const ip = tiles.get('image').prev;
      if (d.bg.image) { ip.style.backgroundImage = `url(${canvasThumb(d.bg.image)})`; ip.innerHTML = ''; ip.classList.add('has'); }
      else { ip.style.backgroundImage = ''; ip.innerHTML = icon('image', 22); ip.classList.remove('has'); }
      cutHint.hidden = cut;
      if (optsType !== type) buildOptions(type);
      optsWrap._sync?.(d);
      secFx.classList.toggle('disabled', !cut);
      secFx.querySelector('.sec-hint').hidden = cut;
      shadowOn.setValue(cut && d.fx.shadow.on);
      strokeOn.setValue(cut && d.fx.stroke.on);
      shBox.hidden = !(cut && d.fx.shadow.on);
      stBox.hidden = !(cut && d.fx.stroke.on);
      shBlur.setValue(d.fx.shadow.blur); shDist.setValue(d.fx.shadow.dy); shDx.setValue(d.fx.shadow.dx); shOp.setValue(Math.round(d.fx.shadow.opacity * 100));
      stWidth.setValue(d.fx.stroke.width); stColor.setValue(d.fx.stroke.color);
    }
    ctx.on('doc:changed', (p) => { if (p?.reason !== 'bump') sync(); });
    sync();
  },
});
