// core/ui.js — small Chinese UI kit (no deps). Every control returns a DOM element; controls that hold
// a value also get el.setValue(v) (updates silently, no callback), el.getValue(), el.setDisabled(bool).
//
//   h(tag, attrs, ...children)                    DOM helper (attrs: class, style, html, on*, data-*, …)
//   section(title, hint?, { icon, right })        panel section (append controls to it)
//   slider({ label, min, max, step, value, unit, defaultValue, hint, power, onInput(v), onChange(v), format(v) })
//       power > 1: non-linear track (fine control at the low end, e.g. brush sizes 2..800); releasing a
//       dragged slider ends undo coalescing (store.endCoalesce) so every drag is its own undo step
//   toggle({ label, value, hint, onChange(bool) })
//   segmented({ options:[{value,label,icon?,tip?}], value, onChange(v), block, size:'sm'|'md' })
//   colorSwatches({ colors:[{value,name}|'#hex'], value, custom:true, onChange(hex), onInput?(hex) })
//   button({ text, icon, primary, variant:'secondary'|'ghost'|'danger', size:'sm'|'lg', block, tip, key, onClick, disabled })
//   select({ options:[{value,label}], value, onChange(v) })
//   field(label, control, hint?), row(...children), hint(text), divider()
//   toast(msg, type='info'|'success'|'error'|'warning', { action:{text,onClick}, duration })
//   busy(msg) → { update(msg), done() }
//   confirm(msg, { title, okText, cancelText, danger }) → Promise<bool>
//   modal({ title, content, buttons:[{text, primary, variant, value, onClick(close)}], width, closable }) → { el, body, close(v), result }
//   pickFiles({ accept, multiple }) → Promise<File[]>
//   initTooltips()                                  data-tip="…" data-key="Ctrl+Z" on any element
//   comingSoon({ icon, title, text, features:[…] }) friendly 「功能开发中」 placeholder (phase-2 stubs)

import { icon } from './icons.js';
import { store } from './store.js';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sv == null) continue;
        if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv;
      }
    }
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function section(title, hintText, opts = {}) {
  const head = h('div', { class: 'sec-h' },
    opts.icon ? h('span', { class: 'sec-ico', html: icon(opts.icon, 16) }) : null,
    h('span', { class: 'sec-title' }, title),
    opts.right || null);
  const el = h('section', { class: 'sec' }, head);
  if (hintText) el.append(h('div', { class: 'sec-hint' }, hintText));
  return el;
}

export function hint(text) { return h('div', { class: 'hint' }, text); }
export function divider() { return h('div', { class: 'divider' }); }
export function row(...children) { return h('div', { class: 'row' }, ...children); }
export function field(label, control, hintText) {
  return h('div', { class: 'field' }, h('div', { class: 'field-label' }, label), control, hintText ? hint(hintText) : null);
}

let sliderSeq = 0;
export function slider(o) {
  const { label, min = 0, max = 100, step = 1, unit = '', onInput, onChange } = o;
  const fmt = o.format || ((v) => `${Math.round(v * 100) / 100}`);
  const id = `sl${++sliderSeq}`;
  // power ≠ 1 → the range runs 0..RES and maps to min..max along a curve (value = min + (max-min)·t^power)
  const power = o.power > 0 && o.power !== 1 ? o.power : 1;
  const RES = 1000;
  const clamp = (v) => Math.min(max, Math.max(min, v));
  const snap = (v) => clamp(Math.round((v - min) / step) * step + min);
  const toPos = (v) => (power === 1 ? v : RES * Math.pow((clamp(v) - min) / (max - min || 1), 1 / power));
  const fromPos = (p) => (power === 1 ? +p : snap(min + (max - min) * Math.pow(+p / RES, power)));
  const range = h('input', { type: 'range', id, min: power === 1 ? min : 0, max: power === 1 ? max : RES, step: power === 1 ? step : 1, 'aria-label': label });
  let val;
  const setVal = (v) => {
    if (power === 1) { range.value = v; val = +range.value; } else { val = snap(v); range.value = toPos(val); }
  };
  setVal(o.value ?? min);
  const num = h('input', { class: 'num', type: 'text', inputmode: 'decimal', value: fmt(val), 'aria-label': `${label}数值` });
  const lab = h('label', { class: 'sl-label', for: id, title: o.defaultValue != null ? '双击恢复默认' : null }, label);
  const el = h('div', { class: 'ctl slider' },
    h('div', { class: 'sl-top' }, lab, h('span', { class: 'sl-val' }, num, unit ? h('span', { class: 'unit' }, unit) : null)),
    range,
    o.hint ? hint(o.hint) : null);
  const paint = () => {
    const lo = +range.min, hi = +range.max;
    const p = ((+range.value - lo) / (hi - lo || 1)) * 100;
    if (power === 1 && min < 0 && max > 0) {
      const z = ((0 - min) / (max - min)) * 100;
      range.style.setProperty('--a', `${Math.min(p, z)}%`);
      range.style.setProperty('--b', `${Math.max(p, z)}%`);
    } else {
      range.style.setProperty('--a', '0%');
      range.style.setProperty('--b', `${p}%`);
    }
  };
  let byPointer = false;
  range.addEventListener('pointerdown', () => { byPointer = true; });
  range.addEventListener('input', () => { val = fromPos(range.value); num.value = fmt(val); paint(); onInput?.(val); });
  range.addEventListener('change', () => {
    onChange?.(val);
    // a finished drag is one undo step; a new drag right after it must not merge into it
    if (byPointer) { byPointer = false; store.endCoalesce(); }
  });
  const commitNum = () => {
    const v = parseFloat(num.value);
    if (Number.isFinite(v)) {
      const before = val;
      setVal(clamp(v)); num.value = fmt(val); paint();
      if (val !== before) { onInput?.(val); onChange?.(val); store.endCoalesce(); }
    } else num.value = fmt(val);
  };
  num.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commitNum(); num.blur(); } e.stopPropagation(); });
  num.addEventListener('blur', commitNum);
  if (o.defaultValue != null) {
    lab.addEventListener('dblclick', () => {
      if (range.disabled) return;
      setVal(o.defaultValue); num.value = fmt(val); paint();
      onInput?.(val); onChange?.(val); store.endCoalesce();
    });
  }
  el.setValue = (v) => { setVal(v); num.value = fmt(val); paint(); };
  el.getValue = () => val;
  el.setDisabled = (d) => { range.disabled = d; num.disabled = d; el.classList.toggle('disabled', !!d); };
  el.input = range;
  paint();
  return el;
}

export function toggle(o) {
  const input = h('input', { type: 'checkbox', role: 'switch' });
  input.checked = !!o.value;
  const el = h('label', { class: 'ctl toggle' },
    h('span', { class: 'tg-text' }, h('span', { class: 'tg-label' }, o.label), o.hint ? h('span', { class: 'tg-hint' }, o.hint) : null),
    input,
    h('span', { class: 'switch', 'aria-hidden': 'true' }));
  input.addEventListener('change', () => o.onChange?.(input.checked));
  el.setValue = (v) => { input.checked = !!v; };
  el.getValue = () => input.checked;
  el.setDisabled = (d) => { input.disabled = d; el.classList.toggle('disabled', !!d); };
  el.input = input;
  return el;
}

export function segmented(o) {
  let value = o.value;
  const btns = new Map();
  const el = h('div', { class: `seg ${o.block ? 'block' : ''} ${o.size === 'sm' ? 'sm' : ''} ${o.className || ''}`, role: 'radiogroup' });
  for (const opt of o.options) {
    const b = h('button', {
      type: 'button', class: 'seg-btn', role: 'radio', 'data-value': opt.value,
      'data-tip': opt.tip || null, 'data-key': opt.key || null,
      onclick: () => { if (b.disabled) return; if (value !== opt.value) { set(opt.value); o.onChange?.(opt.value); } else o.onReselect?.(opt.value); },
    }, opt.icon ? h('span', { class: 'seg-ico', html: icon(opt.icon, 16) }) : null, h('span', {}, opt.label));
    btns.set(opt.value, b);
    el.append(b);
  }
  function set(v) {
    value = v;
    for (const [k, b] of btns) { b.classList.toggle('on', k === v); b.setAttribute('aria-checked', k === v ? 'true' : 'false'); }
  }
  set(value);
  el.setValue = set;
  el.getValue = () => value;
  el.setDisabled = (d) => { for (const b of btns.values()) b.disabled = d; el.classList.toggle('disabled', !!d); };
  return el;
}

export function colorSwatches(o) {
  let value = (o.value || '').toLowerCase();
  const items = (o.colors || []).map((c) => (typeof c === 'string' ? { value: c, name: c } : c));
  const el = h('div', { class: 'swatches' });
  const map = new Map();
  for (const it of items) {
    const b = h('button', {
      type: 'button', class: 'sw', style: { '--c': it.value }, 'data-tip': it.name, 'aria-label': it.name,
      onclick: () => { set(it.value); o.onChange?.(it.value); },
    });
    if (isLight(it.value)) b.classList.add('light');
    map.set(it.value.toLowerCase(), b);
    el.append(b);
  }
  let customBtn = null, picker = null;
  if (o.custom !== false) {
    picker = h('input', { type: 'color', class: 'sw-picker', value: /^#[0-9a-f]{6}$/i.test(value) ? value : '#ff8800', tabindex: '-1', 'aria-hidden': 'true' });
    customBtn = h('button', { type: 'button', class: 'sw sw-custom', 'data-tip': '自定义颜色', 'aria-label': '自定义颜色', onclick: () => picker.click() });
    // every drag of the native picker fires `input`; use onInput (coalesced commits) if given
    picker.addEventListener('input', () => { set(picker.value); (o.onInput || o.onChange)?.(picker.value); });
    picker.addEventListener('change', () => store.endCoalesce());
    el.append(h('span', { class: 'sw-custom-wrap' }, customBtn, picker));
  }
  function set(v) {
    value = String(v || '').toLowerCase();
    let found = false;
    for (const [k, b] of map) { const on = k === value; b.classList.toggle('on', on); found ||= on; }
    if (customBtn) {
      customBtn.classList.toggle('on', !found && !!value);
      customBtn.style.setProperty('--c', !found && value ? value : '');
      customBtn.classList.toggle('has', !found && !!value);
      if (/^#[0-9a-f]{6}$/i.test(value)) picker.value = value;
    }
  }
  set(value);
  el.setValue = set;
  el.getValue = () => value;
  return el;
}

function isLight(hex) {
  const s = String(hex).replace('#', '');
  if (s.length < 6) return false;
  const n = parseInt(s.slice(0, 6), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 225;
}

export function button(o) {
  const cls = ['btn'];
  if (o.primary) cls.push('primary');
  if (o.variant) cls.push(o.variant);
  if (o.size) cls.push(o.size);
  if (o.block) cls.push('block');
  if (o.className) cls.push(o.className);
  const b = h('button', {
    type: 'button', class: cls.join(' '), 'data-tip': o.tip || null, 'data-key': o.key || null,
    disabled: !!o.disabled, onclick: (e) => { if (!b.disabled) o.onClick?.(e); },
  }, o.icon ? h('span', { class: 'btn-ico', html: icon(o.icon, o.size === 'lg' ? 20 : 18) }) : null, o.text ? h('span', { class: 'btn-text' }, o.text) : null);
  b.setDisabled = (d) => { b.disabled = !!d; };
  b.setText = (t) => { const s = b.querySelector('.btn-text'); if (s) s.textContent = t; };
  return b;
}

export function select(o) {
  const s = h('select', { class: 'select' });
  for (const opt of o.options) s.append(h('option', { value: opt.value }, opt.label));
  s.value = o.value;
  s.addEventListener('change', () => o.onChange?.(s.value));
  s.setValue = (v) => { s.value = v; };
  s.getValue = () => s.value;
  s.setDisabled = (d) => { s.disabled = d; };
  return s;
}

// ---------------------------------------------------------------- toasts
function toastRoot() {
  let r = document.getElementById('toasts');
  if (!r) { r = h('div', { id: 'toasts' }); document.body.append(r); }
  return r;
}
export function toast(msg, type = 'info', opts = {}) {
  const ico = { info: 'info', success: 'success', error: 'alert', warning: 'alert' }[type] || 'info';
  const el = h('div', { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' },
    h('span', { class: 't-ico', html: icon(ico, 18) }),
    h('span', { class: 't-msg' }, msg));
  let timer;
  const close = () => {
    clearTimeout(timer);
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  };
  if (opts.action) {
    el.append(h('button', { type: 'button', class: 't-action', onclick: () => { opts.action.onClick?.(); close(); } }, opts.action.text));
  }
  el.append(h('button', { type: 'button', class: 't-close', 'aria-label': '关闭', html: icon('close', 14), onclick: close }));
  const root = toastRoot();
  root.append(el);
  while (root.children.length > 4) root.firstElementChild.remove();
  const dur = opts.duration ?? (opts.action ? 7000 : type === 'error' ? 6000 : 3200);
  if (dur > 0) {
    timer = setTimeout(close, dur);
    el.addEventListener('mouseenter', () => clearTimeout(timer));
    el.addEventListener('mouseleave', () => { timer = setTimeout(close, 2000); });
  }
  return { el, close };
}

// ---------------------------------------------------------------- busy overlay
let busyCount = 0;
let busyTimer = null;
export function busy(msg = '正在处理…') {
  const root = document.getElementById('busy');
  if (!root) return { update() {}, done() {} };
  busyCount++;
  const t0 = performance.now();
  const msgEl = root.querySelector('.busy-msg');
  const subEl = root.querySelector('.busy-sub');
  msgEl.textContent = msg;
  subEl.textContent = '';
  root.hidden = false;
  requestAnimationFrame(() => root.classList.add('show'));
  document.body.classList.add('is-busy');
  clearInterval(busyTimer);
  busyTimer = setInterval(() => {
    const s = Math.floor((performance.now() - t0) / 1000);
    subEl.textContent = s >= 2 ? `已用 ${s} 秒` : '';
  }, 500);
  let finished = false;
  return {
    update(m) { if (!finished) msgEl.textContent = m; },
    done() {
      if (finished) return;
      finished = true;
      busyCount = Math.max(0, busyCount - 1);
      if (!busyCount) {
        clearInterval(busyTimer);
        root.classList.remove('show');
        document.body.classList.remove('is-busy');
        setTimeout(() => { if (!busyCount) root.hidden = true; }, 180);
      }
    },
  };
}
export const isBusy = () => busyCount > 0;

// ---------------------------------------------------------------- modal / confirm
export function modal(o) {
  let resolve;
  const result = new Promise((r) => { resolve = r; });
  const body = h('div', { class: 'modal-body' });
  if (o.content instanceof Node) body.append(o.content); else if (o.content) body.innerHTML = o.content;
  const foot = h('div', { class: 'modal-foot' });
  const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title || '对话框', style: { width: o.width ? `${o.width}px` : null } },
    h('div', { class: 'modal-head' },
      h('div', { class: 'modal-title' }, o.title || ''),
      o.closable === false ? null : h('button', { type: 'button', class: 'icon-btn modal-x', 'aria-label': '关闭', html: icon('close', 18), onclick: () => close(undefined) })),
    body, foot);
  const back = h('div', { class: 'modal-back' }, box);
  let closed = false;
  function close(v) {
    if (closed) return;
    closed = true;
    back.classList.remove('show');
    back.classList.add('closing');
    if (!document.querySelector('.modal-back:not(.closing)')) document.body.classList.remove('has-modal');
    document.removeEventListener('keydown', onKey, true);
    setTimeout(() => back.remove(), 160);
    o.onClose?.(v);
    resolve(v);
  }
  const buttons = o.buttons || [{ text: '好的', primary: true, value: true }];
  let primaryBtn = null;
  for (const bd of buttons) {
    const b = button({ text: bd.text, primary: bd.primary, variant: bd.variant || (bd.primary ? null : 'secondary'), icon: bd.icon,
      onClick: () => { if (bd.onClick) { const r = bd.onClick(close); if (r === false) return; if (!closed && bd.value === undefined) return; } close(bd.value); } });
    if (bd.id) b.id = bd.id;
    if (bd.primary) primaryBtn = b;
    foot.append(b);
  }
  function onKey(e) {
    if (e.key === 'Escape' && o.closable !== false) { e.preventDefault(); e.stopPropagation(); close(undefined); }
    else if (e.key === 'Enter' && primaryBtn && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); e.stopPropagation(); primaryBtn.click(); }
    else e.stopPropagation();
  }
  back.addEventListener('mousedown', (e) => { if (e.target === back && o.closable !== false) close(undefined); });
  // older toasts would sit on top of the dialog's buttons (and catch their clicks) → let them go;
  // toasts raised while the dialog is open show at the top (see base.css body.has-modal)
  for (const t of document.querySelectorAll('#toasts .toast:not(.out)')) { t.classList.add('out'); setTimeout(() => t.remove(), 220); }
  document.body.classList.add('has-modal');
  document.addEventListener('keydown', onKey, true);
  (document.getElementById('modal-root') || document.body).append(back);
  requestAnimationFrame(() => { back.classList.add('show'); (primaryBtn || box).focus?.(); });
  return { el: box, body, close, result };
}

export function confirm(msg, o = {}) {
  const content = h('div', { class: 'confirm-msg' }, msg);
  const m = modal({
    title: o.title || '请确认', content, width: o.width || 400,
    buttons: [
      { text: o.cancelText || '取消', value: false },
      { text: o.okText || '确定', primary: !o.danger, variant: o.danger ? 'danger' : null, value: true },
    ],
  });
  return m.result.then((v) => v === true);
}

// ---------------------------------------------------------------- files
export function pickFiles({ accept = 'image/*', multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple, style: { display: 'none' } });
    input.addEventListener('change', () => { resolve([...input.files]); input.remove(); });
    input.addEventListener('cancel', () => { resolve([]); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

// ---------------------------------------------------------------- tooltips
export function initTooltips() {
  const tip = h('div', { class: 'tooltip', role: 'tooltip' });
  document.body.append(tip);
  let target = null, timer = null;
  const hide = () => { clearTimeout(timer); tip.classList.remove('show'); target = null; };
  document.addEventListener('pointerover', (e) => {
    const t = e.target.closest?.('[data-tip]');
    if (t === target) return;
    hide();
    if (!t || !t.dataset.tip) return;
    target = t;
    timer = setTimeout(() => {
      if (!target || !document.body.contains(target)) return;
      tip.innerHTML = '';
      tip.append(h('span', {}, target.dataset.tip));
      if (target.dataset.key) tip.append(h('kbd', {}, target.dataset.key));
      tip.classList.add('show');
      const r = target.getBoundingClientRect();
      const tr = tip.getBoundingClientRect();
      let x = r.left + r.width / 2 - tr.width / 2;
      let y = r.bottom + 8;
      if (target.closest('.rail')) { x = r.right + 8; y = r.top + r.height / 2 - tr.height / 2; }
      if (y + tr.height > innerHeight - 4) y = r.top - tr.height - 8;
      x = Math.max(6, Math.min(innerWidth - tr.width - 6, x));
      tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    }, 380);
  });
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('keydown', hide, true);
  window.addEventListener('blur', hide);
}

// ---------------------------------------------------------------- placeholder for unfinished panels
export function comingSoon({ icon: ico = 'wrench', title = '', text = '', features = [] } = {}) {
  return h('div', { class: 'coming-soon' },
    h('div', { class: 'cs-ico', html: icon(ico, 34) }),
    h('div', { class: 'cs-title' }, title),
    h('div', { class: 'cs-text' }, text),
    h('span', { class: 'cs-badge', html: `${icon('wrench', 13)}<span>功能开发中</span>` }),
    features.length ? h('ul', { class: 'cs-list' }, ...features.map((f) => h('li', {}, f))) : null);
}
