// panels/adjust.js — 调色: 一键优化, 滤镜（用当前照片生成的实时缩略图）+ 强度, 光线 / 色彩 / 效果 三组滑块, 全部重置.
//
// Everything is plain data in doc.adjust (see core/adjust.js); the viewport re-renders on every commit, so a
// slider drag is a live preview. Each drag = one undo step (coalesce key per slider + ui.slider endCoalesce).
//
// Exports (tests / other panels): analyzePhoto(canvas) → stats, autoParams(stats) → partial doc.adjust,
// AUTO_KEYS, FILTER_ORDER, filterThumbBase(source).

import { registerPanel } from '../core/panels.js';
import { store, uidOf, cloneData, DEFAULT_ADJUST } from '../core/store.js';
import { h, section, slider, button, toast } from '../core/ui.js';
import { icon } from '../core/icons.js';
import { applyAdjust, FILTERS, ADJUST_PARAMS } from '../core/adjust.js';
import { createCanvas, resizeCanvas } from '../core/io.js';

// ---------------------------------------------------------------- slider groups
const LABEL = Object.fromEntries(ADJUST_PARAMS.map((p) => [p.key, p.label]));
const RANGE = Object.fromEntries(ADJUST_PARAMS.map((p) => [p.key, [p.min, p.max]]));
const GROUPS = [
  { id: 'light', title: '光线', icon: 'sparkles', keys: ['exposure', 'brightness', 'contrast', 'highlights', 'shadows'],
    hint: '照片太暗？先试试「曝光」和「阴影」' },
  { id: 'color', title: '色彩', icon: 'palette', keys: ['saturation', 'vibrance', 'temperature', 'tint'],
    hint: '「自然饱和度」让颜色更鲜艳，肤色却不会发红' },
  { id: 'effect', title: '效果', icon: 'adjust', keys: ['sharpen', 'vignette', 'fade', 'grain'],
    hint: '锐化让细节更清楚，暗角让视线集中到中间' },
];
const TRACK_TIP = { temperature: ['偏冷', '偏暖'], tint: ['偏绿', '偏紫红'] };

/** Tile order in the panel (unknown / newly added presets are appended). */
export const FILTER_ORDER = ['none', 'portrait', 'fresh', 'japan', 'warm', 'vivid', 'food', 'cool', 'film', 'vintage', 'cinematic', 'bw'];
function filterIds() {
  const ids = FILTER_ORDER.filter((id) => FILTERS[id]);
  for (const id of Object.keys(FILTERS)) if (!ids.includes(id)) ids.push(id);
  return ids;
}

// ---------------------------------------------------------------- 一键优化 (auto tone & colour)
export const AUTO_KEYS = ['exposure', 'brightness', 'contrast', 'highlights', 'shadows', 'saturation', 'vibrance', 'temperature', 'tint'];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * Photo statistics on a small copy: luma histogram (Rec.709 on sRGB values, like the engine), mean
 * chroma and the average colour of near-neutral pixels (for colour-cast detection).
 */
export function analyzePhoto(src, maxSide = 200) {
  const k = Math.min(1, maxSide / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * k)), hh = Math.max(1, Math.round(src.height * k));
  const c = k < 1 ? resizeCanvas(src, w, hh) : src;
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, hh).data;
  const hist = new Float64Array(256);
  const rch = new Uint32Array(101); // relative chroma (chroma / max channel) of mid-tone pixels, 0..1 in 1 % bins
  // candidates for "neutral things": mid-tones, but not bright bluish pixels in the upper half (sky)
  const top = hh * 0.5;
  const candidate = (r, g, b, L, i) => L > 0.1 && L < 0.92 && !(L > 0.55 && b > r + 0.03 && b >= g && (i >> 2) < top * w);
  let n = 0, sumC = 0, sumL = 0, nm = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    hist[Math.min(255, Math.round(L * 255))]++;
    n++;
    sumL += L;
    const mx = Math.max(r, g, b), C = mx - Math.min(r, g, b);
    sumC += C;
    if (candidate(r, g, b, L, i)) { rch[Math.round((C / mx) * 100)]++; nm++; }
  }
  // "the most neutral things in the photo": mean colour of the least colourful quarter of the mid-tones.
  // In a photo with a colour cast even these lean one way; in a photo of warm things (skin, a pink wall)
  // under neutral light they stay close to grey.
  let neutral = null;
  if (nm > n * 0.1) {
    let acc = 0, lim = 100;
    for (let i = 0; i <= 100; i++) { acc += rch[i]; if (acc >= nm * 0.25) { lim = i; break; } }
    let sr = 0, sg = 0, sb = 0, k2 = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (!candidate(r, g, b, L, i)) continue;
      const mx = Math.max(r, g, b);
      if (Math.round(((mx - Math.min(r, g, b)) / mx) * 100) > lim) continue;
      sr += r; sg += g; sb += b; k2++;
    }
    if (k2) neutral = { rgb: [sr / k2, sg / k2, sb / k2], rel: lim / 100 };
  }
  // second opinion: the brightest near-white things (paper, shirts, walls, clouds — not blown out, not sky,
  // not strongly coloured). Under a real colour cast they lean the same way as the "neutral" pixels.
  const bl = new Uint32Array(256);
  let nb = 0;
  const brightOk = (r, g, b, L, i) => {
    const mx = Math.max(r, g, b), clipped = (r > 0.99) + (g > 0.99) + (b > 0.99);
    return L > 0.55 && clipped < 2 && (mx - Math.min(r, g, b)) / mx < 0.35 && !(b > r + 0.03 && b >= g && (i >> 2) < top * w);
  };
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (brightOk(r, g, b, L, i)) { bl[Math.round(L * 255)]++; nb++; }
  }
  let bright = null;
  if (nb >= Math.max(8, n * 0.004)) {
    let acc = 0, cut = 0;
    for (let i = 255; i >= 0; i--) { acc += bl[i]; if (acc >= Math.max(8, nb * 0.1)) { cut = i; break; } }
    let sr = 0, sg = 0, sb = 0, k3 = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (Math.round(L * 255) < cut || !brightOk(r, g, b, L, i)) continue;
      sr += r; sg += g; sb += b; k3++;
    }
    if (k3) bright = { rgb: [sr / k3, sg / k3, sb / k3] };
  }
  return { n, hist, mean: n ? sumL / n : 0, chroma: n ? sumC / n : 0, neutral, bright };
}

/** White balance (engine units, 1 = slider 100) that would turn the photo's most neutral pixels grey. */
export function castNeed(st) {
  const nt = st?.neutral;
  if (!nt) return { t: 0, s: 0 };
  const [R, G, B] = nt.rgb;
  const A = (R + B) / 2;
  return { t: (B - R) / (0.14 * (R + B) || 1), s: (G - A) / (0.1 * G + 0.04 * A || 1) };
}
/**
 * Partial white-balance correction. The least colourful quarter of a photo can't tell "grey things under
 * a tinted light" from "a photo full of warm things" (skin, a pink wall, autumn grass), so the correction
 * is trusted only when those pixels really are close to grey (rel = their relative chroma), magenta
 * "casts" (rare from real lights, common from pink / purple subjects) count less, and it is capped.
 */
function castParams(st) {
  const a = castNeed(st);
  const rel = st?.neutral?.rel ?? 1;
  let trust = clamp((0.45 - rel) / 0.2, 0, 1);
  // the near-whites must agree (same direction); the smaller of the two amounts is used. Without
  // near-whites (dark photos) only half of the neutral-pixel estimate is trusted.
  const b = st?.bright ? castNeed({ neutral: st.bright }) : null;
  const agree = (x, y) => (b ? (Math.sign(x) === Math.sign(y) ? Math.sign(x) * Math.min(Math.abs(x), Math.abs(y)) : 0) : x * 0.5);
  const t = agree(a.t, b?.t), s = agree(a.s, b?.s);
  const soft = (v, dz, k, cap) => Math.sign(v) * Math.min(cap, Math.max(0, Math.abs(v) - dz) * k);
  // green/magenta: only a gentle nudge — grass, leaves and pink walls look "tinted" too
  let tint = soft(s, 0.2, 0.5, 0.15) * trust;
  if (s < 0) tint *= 0.5;
  // warm-looking photos are usually warm things (skin, food, wood, sunsets) and people like them warm:
  // only a strong warm cast is cooled, and never when the neutral pixels lean magenta (a pink wall or
  // purple clothes — tungsten light is orange, not pink); blue casts are fixed from much smaller amounts
  const warmTrust = a.s < -0.25 ? 0 : trust;
  const temperature = t < 0 ? soft(t, 0.3, 0.9, 0.5) * warmTrust : soft(t, 0.06, 1, 0.6) * trust;
  return { temperature, tint };
}

function percentile(st, p) {
  const t = p * st.n;
  let acc = 0;
  for (let i = 0; i < 256; i++) { acc += st.hist[i]; if (acc >= t) return i / 255; }
  return 1;
}

/**
 * Slider values (doc.adjust units) that fix what analyzePhoto found: under/over-exposure (white point via
 * 曝光, mid-tones via 亮度 = gamma, never clips), flat tones (对比度), blocked shadows / bright areas
 * (阴影 / 高光), dull or garish colours (自然饱和度 / 饱和度) and colour casts (色温 / 色调, partial
 * correction so warm/cool moods survive). Dead zones keep well-exposed photos (almost) untouched.
 */
export function autoParams(st) {
  const out = Object.fromEntries(AUTO_KEYS.map((k) => [k, 0]));
  if (!st || !st.n) return out;
  const q = (p) => percentile(st, p);
  const lo = q(0.01), hi = q(0.995), M = st.mean;

  // 1) white point: a photo whose brightest tones stay grey is under-exposed → lift them to ~0.94
  //    (only when the photo is darkish overall — a bright pastel photo just gets contrast below)
  let f = 1;
  if (hi < 0.75 && M < 0.42) f = Math.min(1.86, 0.94 / Math.max(0.05, hi)); // 1.86 = slider +100
  else if (M > 0.7 && lo > 0.3) f = Math.max(0.8, 0.6 / M); // washed out / over-exposed
  const expo = Math.log2(f) / 0.9;

  // 2) overall brightness through the gamma (亮度) — lifts dark photos without blowing out highlights.
  //    A dark photo that already has bright highlights is usually low-key on purpose → only a gentle lift.
  const m = clamp(M * f, 0.005, 0.99);
  const lowKey = hi >= 0.75;
  let target = m;
  if (m < 0.3) {
    const full = m < 0.18 ? 0.42 : m + (0.42 - m) * ((0.3 - m) / 0.12);
    target = lowKey ? m + (full - m) * 0.4 : full;
  } else if (m > 0.66) target = m > 0.78 ? 0.6 : m - (m - 0.6) * ((m - 0.66) / 0.12);
  const bri = clamp(-Math.log2(Math.log(target) / Math.log(m)) / 0.8, -0.35, 0.55);
  const g = Math.pow(2, -0.8 * bri);
  const map = (x) => Math.pow(Math.min(1, x * f), g);

  // 3) contrast from the tonal spread left after 1–2 (hazy / flat photos get more)
  const spread = map(q(0.98)) - map(q(0.02));
  const con = spread < 0.62 ? Math.min(0.6, ((0.74 / Math.max(0.2, spread) - 1) / 0.9) * 0.7) : 0;

  // 4) deep shadows / bright areas that still hold detail, after 1–3
  const kc = 1 + 0.9 * con;
  let dark = 0, bright = 0;
  for (let i = 0; i < 256; i++) {
    if (!st.hist[i]) continue;
    const v = (map(i / 255) - 0.5) * kc + 0.5;
    if (v < 0.1) dark += st.hist[i];
    if (v > 0.96 && i < 254) bright += st.hist[i];
  }
  dark /= st.n; bright /= st.n;
  const sha = dark > 0.1 ? Math.min(lowKey ? 0.3 : 0.45, 0.12 + (dark - 0.1) * 1.2) : 0;
  const hil = bright > 0.03 ? -Math.min(0.4, 0.1 + (bright - 0.03) * 2.5) : 0;

  // 5) colour: chroma estimated after the tone changes (brightening a dark photo also raises chroma)
  const cf = f * g * Math.pow(Math.max(0.05, m), g - 1);
  const C = st.chroma * cf;
  let vib = 0, sat = 0;
  if (C >= 0.03 && C < 0.1) vib = Math.min(0.25, (0.12 - C) * 2);
  else if (C > 0.36) sat = -Math.min(0.2, (C - 0.36) * 1.2);

  // 6) colour cast from the most neutral pixels (engine white balance: R·(1+.14t+.04s) G·(1−.10s) B·(1−.14t+.04s)).
  //    Partial correction with a dead zone: a real cast is fixed most of the way, warm/cool moods survive.
  const cast = castParams(st);
  const tmp = cast.temperature, tin = cast.tint;

  Object.assign(out, { exposure: expo, brightness: bri, contrast: con, shadows: sha, highlights: hil, vibrance: vib, saturation: sat, temperature: tmp, tint: tin });
  for (const k of AUTO_KEYS) {
    const v = Math.round(out[k] * 100);
    out[k] = Math.abs(v) < 3 ? 0 : v; // tiny corrections aren't worth it — good photos stay untouched
  }
  return out;
}

const autoCache = new WeakMap(); // source canvas → { v, params }
function autoFor(src) {
  const e = autoCache.get(src);
  if (e && e.v === (src.__v || 0)) return e.params;
  const params = autoParams(analyzePhoto(src));
  autoCache.set(src, { v: src.__v || 0, params });
  return params;
}

// ---------------------------------------------------------------- filter thumbnails
const THUMB = 120; // square, device px (tiles are ~58 CSS px → sharp on 2× screens)
let thumbBase = null; // { key, canvas } — thumbnail of the current source (one at a time)

/** Square thumbnail of the photo (cover crop, slightly above centre for tall photos — faces sit high). */
export function filterThumbBase(src) {
  const key = `${uidOf(src)}.${src.__v || 0}`;
  if (thumbBase?.key === key) return thumbBase.canvas;
  const k = THUMB / Math.min(src.width, src.height);
  const scaled = k < 1 ? resizeCanvas(src, src.width * k, src.height * k) : src;
  const cs = Math.min(scaled.width, scaled.height); // square crop in `scaled` px
  const c = createCanvas(THUMB, THUMB);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(scaled, (scaled.width - cs) / 2, (scaled.height - cs) * 0.3, cs, cs, 0, 0, THUMB, THUMB);
  thumbBase = { key, canvas: c };
  return c;
}

// ---------------------------------------------------------------- panel
const fmtSigned = (v) => (v > 0 ? `+${v}` : `${v}`);
const isDefault = (a) => a.filter === 'none' && ADJUST_PARAMS.every((p) => !(Number(a[p.key]) || 0));

registerPanel({
  id: 'adjust',
  title: '调色',
  icon: icon('adjust', 22),
  order: 40,
  tip: '滤镜和亮度、对比度、色温等调节',
  mount(el, ctx) {
    const ui = (store.ui.adjustOpen ||= { light: true, color: true, effect: false });

    // ---------------------------------------------------------- 一键优化
    const autoBtn = button({ text: '一键优化', icon: 'wand', primary: true, block: true, className: 'adj-auto-btn',
      tip: '自动分析照片，调好明暗、对比度和颜色', onClick: runAuto });
    const autoDone = h('span', { class: 'adj-auto-done', hidden: true }, h('span', { html: icon('check', 14) }), '已优化');
    const secAuto = section('智能优化', null, { icon: 'sparkles', right: autoDone });
    secAuto.classList.add('adj-auto');
    secAuto.append(autoBtn, h('div', { class: 'hint' }, '自动调好明暗和颜色，偏暗、发灰、偏色的照片效果最明显'));

    // ---------------------------------------------------------- 滤镜
    const tiles = new Map();
    const grid = h('div', { class: 'adj-filters', role: 'radiogroup', 'aria-label': '滤镜' });
    for (const id of filterIds()) {
      const cv = h('canvas', { class: 'af-canvas', width: THUMB, height: THUMB });
      const b = h('button', { type: 'button', class: 'af-tile', role: 'radio', 'data-filter': id, 'aria-label': FILTERS[id].name,
        onclick: () => chooseFilter(id) },
      h('span', { class: 'af-prev' }, cv, h('span', { class: 'af-check', html: icon('check', 12) })),
      h('span', { class: 'af-name' }, FILTERS[id].name));
      tiles.set(id, { b, cv });
      grid.append(b);
    }
    const strength = slider({ label: '滤镜强度', min: 0, max: 100, unit: '%', defaultValue: 100, value: store.doc.adjust.filterStrength,
      onInput: (v) => store.commit('滤镜强度', (d) => { d.adjust.filterStrength = v; }, { coalesce: 'adjust.filterStrength' }) });
    strength.classList.add('adj-strength');
    const secFilter = section('滤镜', '点一下就能套用，「原图」可以去掉滤镜');
    secFilter.append(grid, strength);

    // ---------------------------------------------------------- 光线 / 色彩 / 效果
    const sliders = new Map();
    const groups = [];
    for (const g of GROUPS) {
      const body = h('div', { class: 'adj-group-body' }, h('div', { class: 'hint adj-group-hint' }, g.hint));
      for (const key of g.keys) {
        const [min, max] = RANGE[key];
        const s = slider({ label: LABEL[key], min, max, defaultValue: 0, value: store.doc.adjust[key] || 0,
          format: min < 0 ? fmtSigned : undefined,
          onInput: (v) => store.commit(`调色：${LABEL[key]}`, (d) => { d.adjust[key] = v; }, { coalesce: `adjust.${key}` }) });
        s.classList.add('adj-sl', `adj-${key}`);
        if (TRACK_TIP[key]) {
          s.querySelector('input[type=range]').insertAdjacentElement('afterend',
            h('div', { class: 'adj-track-tip' }, h('span', {}, TRACK_TIP[key][0]), h('span', {}, TRACK_TIP[key][1])));
        }
        sliders.set(key, s);
        body.append(s);
      }
      const count = h('span', { class: 'adj-count', hidden: true });
      const reset = h('button', { type: 'button', class: 'adj-group-reset', 'data-tip': `把「${g.title}」这一组恢复为 0`, hidden: true,
        onclick: (e) => { e.stopPropagation(); resetGroup(g); } }, '重置');
      const chev = h('span', { class: 'adj-chev', html: icon('chevronDown', 16) });
      const head = h('button', { type: 'button', class: 'adj-group-head', 'aria-expanded': 'true',
        onclick: () => { ui[g.id] = !ui[g.id]; layoutGroups(); } },
      h('span', { class: 'adj-gico', html: icon(g.icon, 16) }), h('span', { class: 'adj-gtitle' }, g.title), count);
      const sec = h('section', { class: 'sec adj-group', 'data-group': g.id }, h('div', { class: 'adj-group-top' }, head, reset, chev), body);
      chev.addEventListener('click', () => head.click());
      groups.push({ g, sec, head, body, count, reset });
    }

    // ---------------------------------------------------------- 全部重置
    const resetAll = button({ text: '全部重置', icon: 'reset', variant: 'secondary', block: true,
      tip: '去掉滤镜，所有滑块回到 0（可以撤销）',
      onClick: () => store.commit('全部重置', (d) => { d.adjust = cloneData(DEFAULT_ADJUST); }) });
    const secReset = h('section', { class: 'sec adj-foot' }, resetAll,
      h('div', { class: 'hint' }, '按住顶部「对比原图」可以看调色前的样子；双击滑块名称可以单独恢复。'));

    el.append(secAuto, secFilter, ...groups.map((x) => x.sec), secReset);

    // ---------------------------------------------------------- actions
    function chooseFilter(id) {
      const a = store.doc.adjust;
      if (a.filter === id) return;
      const name = FILTERS[id].name;
      store.commit(id === 'none' ? '去掉滤镜' : `滤镜：${name}`, (d) => { d.adjust.filter = id; d.adjust.filterStrength = 100; });
    }
    function runAuto() {
      const d = store.doc;
      if (!d) return;
      const p = autoFor(d.source);
      if (AUTO_KEYS.every((k) => (Number(d.adjust[k]) || 0) === p[k])) {
        toast('已经是一键优化的效果了，可以再手动微调', 'info');
        return;
      }
      store.commit('一键优化', (dd) => { Object.assign(dd.adjust, p); });
      const n = AUTO_KEYS.filter((k) => p[k]).length;
      toast(n ? '已自动优化，不满意可以撤销，或继续微调下面的滑块' : '这张照片的光线和颜色已经不错，几乎不用调', n ? 'success' : 'info');
    }
    function resetGroup(g) {
      store.commit(`重置${g.title}`, (d) => { for (const k of g.keys) d.adjust[k] = 0; });
    }
    function layoutGroups() {
      for (const x of groups) {
        const open = !!ui[x.g.id];
        x.sec.classList.toggle('open', open);
        x.head.setAttribute('aria-expanded', open ? 'true' : 'false');
        x.body.hidden = !open;
      }
    }

    // ---------------------------------------------------------- thumbnails (debounced; cheap GL passes on 120 px)
    let thumbKey = '', thumbTimer = 0;
    function thumbsKey(d) {
      const a = d.adjust;
      return `${uidOf(d.source)}.${d.source.__v || 0}|${ADJUST_PARAMS.map((p) => Number(a[p.key]) || 0).join(',')}`;
    }
    function renderThumbs() {
      thumbTimer = 0;
      const d = store.doc;
      if (!d) return;
      thumbKey = thumbsKey(d);
      const base = filterThumbBase(d.source);
      for (const [id, t] of tiles) {
        applyAdjust(base, { ...d.adjust, filter: id, filterStrength: 100 }, { out: t.cv, docSize: [THUMB, THUMB] });
      }
    }
    function queueThumbs(immediate) {
      const d = store.doc;
      if (!d || thumbsKey(d) === thumbKey) return;
      clearTimeout(thumbTimer);
      if (immediate) renderThumbs(); else thumbTimer = setTimeout(renderThumbs, 220);
    }
    ctx.onDispose(() => clearTimeout(thumbTimer));

    // ---------------------------------------------------------- sync
    function sync() {
      const d = store.doc;
      if (!d) return;
      const a = d.adjust;
      for (const [id, t] of tiles) {
        const on = id === a.filter;
        t.b.classList.toggle('on', on);
        t.b.setAttribute('aria-checked', on ? 'true' : 'false');
      }
      strength.hidden = a.filter === 'none';
      strength.setValue(a.filterStrength ?? 100);
      for (const [k, s] of sliders) s.setValue(Number(a[k]) || 0);
      for (const x of groups) {
        const n = x.g.keys.filter((k) => Number(a[k]) || 0).length;
        x.count.hidden = !n;
        x.count.textContent = `已调 ${n} 项`;
        x.reset.hidden = !n;
      }
      resetAll.setDisabled(isDefault(a));
      // 「已优化」 only after 一键优化 ran on this photo (no analysis on every mount — it costs ~0.1 s on 12 MP)
      const ac = autoCache.get(d.source);
      const p = ac && ac.v === (d.source.__v || 0) ? ac.params : null;
      const autoOn = !!p && AUTO_KEYS.some((k) => p[k]) && AUTO_KEYS.every((k) => (Number(a[k]) || 0) === p[k]);
      autoDone.hidden = !autoOn;
      queueThumbs(false);
    }

    // open the 效果 group when this photo already uses an effect
    if (GROUPS[2].keys.some((k) => Number(store.doc.adjust[k]) || 0)) ui.effect = true;
    layoutGroups();
    ctx.on('doc:changed', (p) => { if (p?.reason !== 'bump') sync(); });
    sync();
    queueThumbs(true);
  },
});
