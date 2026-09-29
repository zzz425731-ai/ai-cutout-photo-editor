// core/io.js — canvas helpers, image loading/decoding, whole-image operations.
// All functions return NEW canvases (pixel planes are immutable for whole-image ops).

export const MAX_SIDE = 4096;

/**
 * Creates a canvas with a CPU-backed 2D context (willReadFrequently). CPU canvases keep their pixels when
 * Chrome's GPU process crashes or resets under memory pressure — GPU-backed ones come back BLANK — so every
 * document plane, history snapshot, layer image and render cache is durable. They also make
 * getImageData/putImageData (masks, brushes, AI round-trips) fast.
 * opts.gpu=true → plain getContext('2d') (GPU-accelerated when Chrome decides so): only for throw-away
 * canvases whose loss is harmless. opts.willRead is accepted for compatibility (always true now).
 */
export function createCanvas(w, h, opts = {}) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  if (!opts.gpu) { c.getContext('2d', { willReadFrequently: true }); c.__willRead = true; }
  return c;
}

/** true when c has a CPU-backed (durable) 2D context — see createCanvas. */
export function isDurable(c) {
  if (!c) return false;
  if (typeof ImageBitmap !== 'undefined' && c instanceof ImageBitmap) return false;
  try { return !!c.getContext('2d')?.getContextAttributes?.().willReadFrequently; } catch { return false; }
}

/** 2D context (the options of the first getContext call stick). */
export function ctx2d(c) { return c.getContext('2d'); }

export function cloneCanvas(src) {
  const c = createCanvas(src.width, src.height);
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

/** Crop to rect {x,y,w,h} (doc px, may extend beyond the image → transparent). */
export function cropCanvas(src, rect) {
  const w = Math.max(1, Math.round(rect.w)), h = Math.max(1, Math.round(rect.h));
  const c = createCanvas(w, h);
  c.getContext('2d').drawImage(src, -Math.round(rect.x), -Math.round(rect.y));
  return c;
}

/** Rotate by 90° steps. dir = 1 clockwise, -1 counter-clockwise, 2 = 180°. */
export function rotateCanvas90(src, dir = 1) {
  const turns = ((dir % 4) + 4) % 4;
  if (turns === 0) return cloneCanvas(src);
  const swap = turns % 2 === 1;
  const c = createCanvas(swap ? src.height : src.width, swap ? src.width : src.height);
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((turns * Math.PI) / 2);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

/** Arbitrary rotation (radians) around the centre, keeping the canvas size (for straighten). */
export function rotateCanvas(src, angle, { fill = null } = {}) {
  const c = createCanvas(src.width, src.height);
  const ctx = c.getContext('2d');
  if (fill) { ctx.fillStyle = fill; ctx.fillRect(0, 0, c.width, c.height); }
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(angle);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

export function flipCanvas(src, axis = 'h') {
  const c = createCanvas(src.width, src.height);
  const ctx = c.getContext('2d');
  if (axis === 'h') { ctx.translate(c.width, 0); ctx.scale(-1, 1); } else { ctx.translate(0, c.height); ctx.scale(1, -1); }
  ctx.drawImage(src, 0, 0);
  return c;
}

/** High-quality resize (step-halving for large downscales). */
export function resizeCanvas(src, w, h, opts = {}) {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  let cur = src;
  // halve until within 2x of the target for good quality
  while (cur.width / 2 >= w * 1.0001 && cur.height / 2 >= h * 1.0001 && cur.width > 2 && cur.height > 2) {
    const t = createCanvas(Math.max(w, Math.round(cur.width / 2)), Math.max(h, Math.round(cur.height / 2)));
    const tc = t.getContext('2d');
    tc.imageSmoothingEnabled = true; tc.imageSmoothingQuality = 'high';
    tc.drawImage(cur, 0, 0, t.width, t.height);
    cur = t;
  }
  const c = createCanvas(w, h, { gpu: !!opts.gpu });
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, w, h);
  return c;
}

/**
 * Applies fn(plane) to every non-null pixel plane of the doc (source, fg, mask, maskAI) and returns
 * { source, fg, mask, maskAI, width, height } — assign it inside store.commit for crop/rotate/flip/resize:
 *   store.commit('旋转', d => Object.assign(d, mapPlanes(d, c => rotateCanvas90(c, 1))))
 */
export function mapPlanes(doc, fn) {
  const out = {};
  for (const k of ['source', 'fg', 'mask', 'maskAI']) out[k] = doc[k] ? fn(doc[k], k) : null;
  if (out.mask && !out.mask.__willRead) out.mask = toWillRead(out.mask);
  if (out.maskAI && !out.maskAI.__willRead) out.maskAI = toWillRead(out.maskAI);
  if (out.maskAI && doc.maskAI?.__matte) out.maskAI.__matte = doc.maskAI.__matte; // keep 「通用 · 0.6 秒」 info
  out.width = out.source.width;
  out.height = out.source.height;
  return out;
}
function toWillRead(c) { const n = createCanvas(c.width, c.height, { willRead: true }); n.getContext('2d').drawImage(c, 0, 0); return n; }

/** Gray (R channel) canvas → mask canvas (alpha = gray, RGB black). */
export function maskFromGray(src) {
  const w = src.width, h = src.height;
  const tmp = createCanvas(w, h, { willRead: true });
  const tctx = tmp.getContext('2d');
  tctx.drawImage(src, 0, 0);
  const id = tctx.getImageData(0, 0, w, h);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) { const g = d[i]; d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = g; }
  tctx.putImageData(id, 0, 0);
  return tmp;
}

/** Mask canvas (alpha) → opaque gray canvas (white = subject). */
export function grayFromMask(mask) {
  const c = createCanvas(mask.width, mask.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height);
  const white = createCanvas(mask.width, mask.height);
  const wctx = white.getContext('2d');
  wctx.fillStyle = '#fff'; wctx.fillRect(0, 0, c.width, c.height);
  wctx.globalCompositeOperation = 'destination-in';
  wctx.drawImage(mask, 0, 0);
  ctx.drawImage(white, 0, 0);
  return c;
}

/** Mask canvas from a Uint8Array of alpha values. */
export function maskFromAlpha(alpha, w, h) {
  const c = createCanvas(w, h, { willRead: true });
  const ctx = c.getContext('2d');
  const id = ctx.createImageData(w, h);
  const d = id.data;
  for (let i = 0, j = 3; i < alpha.length; i++, j += 4) d[j] = alpha[i];
  ctx.putImageData(id, 0, 0);
  return c;
}

/** Alpha channel of a canvas (or of rect) as Uint8Array. */
export function readAlpha(c, rect = null) {
  const r = rect || { x: 0, y: 0, w: c.width, h: c.height };
  const d = c.getContext('2d').getImageData(r.x, r.y, r.w, r.h).data;
  const a = new Uint8Array(r.w * r.h);
  for (let i = 0, j = 3; i < a.length; i++, j += 4) a[i] = d[j];
  return a;
}

/** True if any pixel is not opaque. Scan every pixel so thin/very soft PNG edges survive import. */
export function hasTransparency(c) {
  const w = c.width, h = c.height;
  const ctx = c.getContext('2d');
  // Bound the readback allocation (~2 MB at 4096 px) instead of copying a whole large image.
  for (let y = 0; y < h; y += 128) {
    const d = ctx.getImageData(0, y, w, Math.min(128, h - y)).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return true;
  }
  return false;
}

/** Opaque copy: draws c over a solid colour. */
export function flatten(c, color = '#ffffff') {
  const out = createCanvas(c.width, c.height);
  const ctx = out.getContext('2d');
  ctx.fillStyle = color; ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(c, 0, 0);
  return out;
}

export function canvasToBlob(c, type = 'image/png', quality) {
  if (quality != null && quality > 1) quality /= 100;
  return new Promise((resolve, reject) => {
    c.toBlob((b) => (b ? resolve(b) : reject(new Error('图片编码失败，可能是图片太大'))), type, quality);
  });
}

export function canvasToDataURL(c, type = 'image/png', quality) {
  if (quality != null && quality > 1) quality /= 100;
  return c.toDataURL(type, quality);
}

export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('读取文件失败'));
    r.readAsDataURL(blob);
  });
}

async function decode(blob) {
  try {
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    // fallback through <img> (handles some SVG/odd files)
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      return img;
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
}

export async function blobToCanvas(blob, opts = {}) {
  const bmp = await decode(blob);
  const w = bmp.naturalWidth || bmp.width, h = bmp.naturalHeight || bmp.height;
  const c = createCanvas(w, h, opts);
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close?.();
  return c;
}

export async function dataURLToCanvas(url, opts = {}) {
  const blob = await (await fetch(url)).blob();
  return blobToCanvas(blob, opts);
}

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif|jfif|ico|svg|tiff?)$/i;

/**
 * Loads an image File/Blob: EXIF orientation applied, long side capped at maxSide (4096).
 * Returns a canvas with extra info: canvas.meta = { origWidth, origHeight, downscaled, hasAlpha, name }.
 * Throws Error with a friendly Chinese message for non-images.
 */
export async function loadImageFile(file, { maxSide = MAX_SIDE } = {}) {
  if (!file) throw new Error('没有选中文件');
  const name = file.name || '';
  const type = file.type || '';
  if (/heic|heif/i.test(type) || /\.(heic|heif)$/i.test(name)) {
    throw new Error('暂不支持苹果 HEIC 格式，请先在手机或电脑上转成 JPG 再打开');
  }
  if ((type && !type.startsWith('image/')) || (!type && name && !IMAGE_EXT.test(name))) {
    throw new Error(`「${name || '这个文件'}」不是图片，请选择 JPG、PNG 或 WebP 图片`);
  }
  let bmp;
  try {
    bmp = await decode(file);
  } catch {
    throw new Error('无法读取这张图片，文件可能已损坏或格式不支持');
  }
  const ow = bmp.naturalWidth || bmp.width, oh = bmp.naturalHeight || bmp.height;
  if (!ow || !oh) throw new Error('图片尺寸无效');
  const k = Math.min(1, maxSide / Math.max(ow, oh));
  let c;
  if (k < 1) {
    const full = createCanvas(ow, oh);
    full.getContext('2d').drawImage(bmp, 0, 0);
    c = resizeCanvas(full, ow * k, oh * k);
  } else {
    c = createCanvas(ow, oh);
    c.getContext('2d').drawImage(bmp, 0, 0);
  }
  bmp.close?.();
  const mayHaveAlpha = !/jpe?g/i.test(type) && !/\.jpe?g$/i.test(name);
  c.meta = {
    origWidth: ow, origHeight: oh, downscaled: k < 1,
    hasAlpha: mayHaveAlpha ? hasTransparency(c) : false,
    name: name.replace(/\.[^.]+$/, '') || '图片',
  };
  return c;
}

/**
 * Splits a canvas with transparency into an opaque RGB source (on white) + alpha mask, plus `fg`: the
 * source with the ORIGINAL colours restored in semi-transparent pixels. Used as the document's 去色边 plane,
 * so soft PNG edges keep their own colours on a new background instead of showing a white halo.
 * fg is null when the image has no semi-transparent pixels.
 */
export function splitAlpha(c) {
  const w = c.width, h = c.height;
  const mask = createCanvas(w, h, { willRead: true });
  const mctx = mask.getContext('2d');
  mctx.drawImage(c, 0, 0);
  mctx.globalCompositeOperation = 'source-in';
  mctx.fillStyle = '#000';
  mctx.fillRect(0, 0, w, h);
  mctx.globalCompositeOperation = 'source-over';
  const source = flatten(c, '#ffffff');
  const orig = c.getContext('2d').getImageData(0, 0, w, h);
  const fg = createCanvas(w, h);
  const fctx = fg.getContext('2d');
  fctx.drawImage(source, 0, 0);
  const id = fctx.getImageData(0, 0, w, h);
  const o = orig.data, f = id.data;
  let soft = 0;
  for (let i = 3; i < o.length; i += 4) {
    const a = o[i];
    if (a > 0 && a < 255) { f[i - 3] = o[i - 3]; f[i - 2] = o[i - 2]; f[i - 1] = o[i - 1]; soft++; }
  }
  if (soft) fctx.putImageData(id, 0, 0);
  return { source, mask, fg: soft ? fg : null };
}

/** Triggers a browser download of a blob. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** Small thumbnail data URL (for tiles / previews). */
export function thumbDataURL(c, maxSide = 160, type = 'image/jpeg') {
  const k = Math.min(1, maxSide / Math.max(c.width, c.height));
  const t = k < 1 ? resizeCanvas(c, c.width * k, c.height * k) : c;
  return t.toDataURL(type, 0.85);
}
