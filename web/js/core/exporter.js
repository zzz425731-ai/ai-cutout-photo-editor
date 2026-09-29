// core/exporter.js — full-resolution export.
//
//   exportDoc(doc, { format:'png'|'jpg'|'webp', quality=0.92 (0..1 or 0..100), maxSide=null, background='#ffffff' }) → Blob
//   exportCanvas(doc, { maxSide, flattenColor }) → Canvas (rendered at scale 1 or scaled to maxSide)
//   docHasTransparency(doc) → bool       (cut out on a transparent background)
//   defaultSaveFormat(doc) → 'png'|'jpg' (PNG when the result has transparency, else JPG)
//   suggestFilename(doc, format) → '照片_抠图.png'

import { renderDoc, prewarm } from './render.js';
import { canvasToBlob, createCanvas, hasTransparency } from './io.js';

const transparencyCache = new WeakMap();
function imageHasTransparency(canvas) {
  const version = canvas.__v || 0;
  const cached = transparencyCache.get(canvas);
  if (cached?.version === version) return cached.value;
  const value = hasTransparency(canvas);
  transparencyCache.set(canvas, { version, value });
  return value;
}

export function docHasTransparency(doc) {
  if (!doc || !doc.cutout || !doc.mask) return false;
  const t = doc.bg?.type;
  // Uploaded PNG/WebP backgrounds may themselves be transparent. Prefer lossless PNG whenever
  // transparency could remain; an empty image background renders white and is actually opaque.
  return t === 'transparent' || (t === 'image' && !!doc.bg.image && imageHasTransparency(doc.bg.image));
}

export function defaultSaveFormat(doc) { return docHasTransparency(doc) ? 'png' : 'jpg'; }

export function exportCanvas(doc, { maxSide = null, flattenColor = null } = {}) {
  const long = Math.max(doc.width, doc.height);
  const scale = maxSide && maxSide < long ? maxSide / long : 1;
  const c = renderDoc(doc, { scale });
  if (!flattenColor) return c;
  const out = createCanvas(c.width, c.height);
  const ctx = out.getContext('2d');
  ctx.fillStyle = flattenColor;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(c, 0, 0);
  return out;
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

export async function exportDoc(doc, { format = 'png', quality = 0.92, maxSide = null, background = '#ffffff' } = {}) {
  const f = String(format).toLowerCase();
  const mime = MIME[f] || 'image/png';
  const q = quality > 1 ? quality / 100 : quality;
  const long = Math.max(doc.width, doc.height);
  await prewarm(doc, maxSide && maxSide < long ? maxSide / long : 1); // slow mask maths off the main thread
  const c = exportCanvas(doc, { maxSide, flattenColor: mime === 'image/jpeg' ? background : null });
  return canvasToBlob(c, mime, mime === 'image/png' ? undefined : q);
}

export function suggestFilename(doc, format = 'png') {
  const ext = format === 'jpeg' ? 'jpg' : format;
  const base = (doc?.name || '照片').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim() || '照片';
  const suffix = doc?.cutout ? '_抠图' : '_编辑';
  return `${base}${suffix}.${ext}`;
}
