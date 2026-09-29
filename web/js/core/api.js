// core/api.js — calls to the local Python server (server.py). All POSTs carry X-KT: 1.
// Every function throws Error with a Chinese message on failure.
//
//   status() → { ok, version, provider, device, models, output_dir }
//   matte(blob, { mode:'general'|'portrait', decontam=true }) → { mask: dataURL, fg: dataURL|null, fg_rect: [x,y,w,h]|null, width, height, ms }
//       fg is the 去色边 patch: RGBA, opaque only where the colour was corrected, placed at fg_rect
//   matteCanvas(canvas, opts) → { mask: Canvas (alpha), fg: { canvas, x, y }|null, ms }     (convenience)
//   faces(blob) → { faces:[{x,y,w,h,score,landmarks}], width, height }
//   inpaint(imageDataURL, maskDataURL) → { image: dataURL, ms, engine }
//   retouch({ image, smooth, whiten, mask }) → { image: dataURL, ms }
//   save(dataURLOrBlob, filename, { subdir, dpi }) → { path }
//   openOutput(path?) → { ok }

import { blobToDataURL, canvasToBlob, dataURLToCanvas, maskFromGray } from './io.js';

const NET_ERR = '无法连接到本地服务，请确认「启动抠图P图工具」窗口没有被关闭';

async function call(path, { method = 'POST', body, type } = {}) {
  const headers = {};
  if (method === 'POST') headers['X-KT'] = '1';
  if (type) headers['Content-Type'] = type;
  let r;
  try {
    r = await fetch(path, { method, headers, body, cache: 'no-store' });
  } catch {
    throw new Error(NET_ERR);
  }
  let data = null;
  try { data = await r.json(); } catch { /* not json */ }
  if (!r.ok) {
    const msg = data?.error || (r.status === 413 ? '图片太大了，请换一张小一点的图片' : r.status === 404 ? '本地服务版本不匹配，请重新启动程序' : `处理失败（错误码 ${r.status}）`);
    const err = new Error(msg);
    err.status = r.status;
    throw err;
  }
  if (!data) throw new Error('本地服务返回了无法识别的结果');
  return data;
}

const json = (obj) => ({ body: JSON.stringify(obj), type: 'application/json' });

export function status() { return call('/api/status', { method: 'GET' }); }

export function matte(blob, { mode = 'general', decontam = true } = {}) {
  return call(`/api/matte?mode=${encodeURIComponent(mode)}&decontam=${decontam ? 1 : 0}`, { body: blob, type: blob.type || 'image/jpeg' });
}

/** Sends a canvas, returns decoded planes: mask (alpha canvas), fg (RGB canvas or null). */
export async function matteCanvas(canvas, opts = {}) {
  // Lossless input preserves fine hair and edge colours for both segmentation and decontamination.
  const blob = await canvasToBlob(canvas, 'image/png');
  const r = await matte(blob, opts);
  const [maskGray, patch] = await Promise.all([dataURLToCanvas(r.mask), r.fg ? dataURLToCanvas(r.fg) : null]);
  if (maskGray.width !== canvas.width || maskGray.height !== canvas.height) throw new Error('抠图结果尺寸不对，请重试');
  const [x = 0, y = 0] = r.fg_rect || [];
  return { mask: maskFromGray(maskGray), fg: patch ? { canvas: patch, x, y } : null, ms: r.ms,
    mode: r.mode || opts.mode || 'general', warning: r.warning || null };
}

export function faces(blob) { return call('/api/faces', { body: blob, type: blob.type || 'image/jpeg' }); }

export function inpaint(image, mask) { return call('/api/inpaint', json({ image, mask })); }

export function retouch({ image, smooth = 0, whiten = 0, mask = null }) { return call('/api/retouch', json({ image, smooth, whiten, mask })); }

export async function save(data, filename, { subdir = null, dpi = null } = {}) {
  const dataURL = typeof data === 'string' ? data : await blobToDataURL(data);
  return call('/api/save', json({ data: dataURL, filename, subdir, dpi }));
}

export function openOutput(path = null) { return call('/api/open-output', json(path ? { path } : {})); }
