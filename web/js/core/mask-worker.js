// core/mask-worker.js — runs the heavy mask maths of render.js off the main thread (module worker).
// Used by render.prewarm(): the viewport's full-quality refine and exports on big images no longer freeze
// the page while 收缩/扩展, 羽化 or 描边 are recomputed at full resolution.
//
//   { id, op: 'edge', src: Uint8Array, w, h, sh, fe }   → { id, out: Uint8Array }   (edgeMask)
//   { id, op: 'dist', src: Uint8Array, w, h, sigma }    → { id, out: Float32Array } (stroke distance field)

import { edgeMask, blurMask, distanceOutside } from './maskops.js';

self.onmessage = (e) => {
  const { id, op, src, w, h } = e.data;
  try {
    let out;
    if (op === 'edge') {
      out = edgeMask(src, w, h, e.data.sh, e.data.fe);
    } else if (op === 'dist') {
      // same steps as render.js strokeCanvas(): soften, threshold, squared distance to the subject
      const soft = blurMask(src, w, h, e.data.sigma);
      const bin = new Uint8Array(soft.length);
      for (let i = 0; i < soft.length; i++) bin[i] = soft[i] > 110 ? 1 : 0;
      out = distanceOutside(bin, w, h);
    } else {
      throw new Error(`unknown op ${op}`);
    }
    self.postMessage({ id, out }, [out.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
