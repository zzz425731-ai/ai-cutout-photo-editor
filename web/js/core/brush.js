// core/brush.js — shared brush engine for tools that paint into a pixel plane.
//
//   const stroke = createBrushStroke({ plane, mode, size, hardness, color, opacity, pattern, onStamp })
//     plane     canvas to modify in place (mask planes: RGB black + alpha)
//     mode      'paint'   source-over `color` (on a mask plane this ADDS to the mask = 保留)
//               'erase'   reduces alpha (on a mask plane = 擦除)
//               'pattern' blends the plane toward `pattern` (a same-size canvas: mosaic / blur / restore brushes)
//     size      diameter in doc px; hardness 0..1 (1 = hard edge, anti-aliased); opacity 0..1
//     onStamp(x, y, radius) optional callback per stamp
//     linear    mask planes: 'paint' ADDS alpha and 'erase' SUBTRACTS it (instead of source-over / multiply),
//               so erasing exactly over a kept dab (or keeping over an erased one) leaves no ghost rim
//     mirror    optional second canvas (same size) that receives the identical stroke, e.g. doc.fg when
//               painting doc.source (keeps the 去色边 copy in sync). Its undo data is returned in end().mirror
//   stroke.addPoint(x, y) → dirty rect {x,y,w,h} | null   (call store.bump(planeName, rect) with it — and bump the mirror)
//   stroke.end() → { rect, before, after, mirror?: { before, after } } | null
//                  (pass to store.commitRegion(label, planeName, rect, before, after), or with a mirror:
//                   store.commitRegions(label, [{ plane:'source', ...res }, { plane:'fg', rect: res.rect, ...res.mirror }]))
//   stroke.cancel() → rect | null                          (restores the plane)
//   Stamps inside one stroke never accumulate (max-blend), so overlapping dabs give an even stroke.
//
//   drawBrushCursor(ctx, viewport, { size, hardness, mode })   circle showing size at the current zoom
//   brushSizeStep(size, dir) → new size for [ / ]

const TILE = 128;

function hexToRgb(hex) {
  let s = String(hex || '#000').replace('#', '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const n = parseInt(s.slice(0, 6), 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function createBrushStroke(o) {
  const plane = o.plane;
  const W = plane.width, H = plane.height;
  const ctx = plane.getContext('2d', { willReadFrequently: true });
  const mode = o.mode || 'paint';
  const size = Math.max(1, o.size || 20);
  const R = size / 2;
  const hard = Math.max(0, Math.min(1, o.hardness ?? 0.7));
  const hardEff = Math.min(hard, Math.max(0, 1 - 1.2 / R)); // ≥ ~1px soft rim for anti-aliasing
  const opacity = Math.max(0, Math.min(1, o.opacity ?? 1));
  const [cr, cg, cb] = hexToRgb(o.color || '#000000');
  const linear = !!o.linear;
  const pattern = o.pattern || null;
  const pctx = pattern ? pattern.getContext('2d', { willReadFrequently: true }) : null;
  const mirror = o.mirror && o.mirror !== plane && o.mirror.width === W && o.mirror.height === H ? o.mirror : null;
  const mctx = mirror ? mirror.getContext('2d', { willReadFrequently: true }) : null;
  const spacing = Math.max(0.75, size * (o.spacing ?? 0.1));
  const tiles = new Map();
  const cols = Math.ceil(W / TILE);
  let bbox = null;
  let pts = [];
  let carry = 0;
  let lastStamp = null;
  let ended = false;
  let dirty = null;

  const falloff = (d) => {
    if (d <= hardEff) return 1;
    if (d >= 1) return 0;
    const t = (d - hardEff) / (1 - hardEff);
    return 1 - t * t * (3 - 2 * t);
  };

  function tileAt(tx, ty) {
    const k = ty * cols + tx;
    let t = tiles.get(k);
    if (!t) {
      const x = tx * TILE, y = ty * TILE;
      const w = Math.min(TILE, W - x), h = Math.min(TILE, H - y);
      const before = ctx.getImageData(x, y, w, h);
      t = { x, y, w, h, before, cur: new ImageData(new Uint8ClampedArray(before.data), w, h), stroke: new Uint8Array(w * h),
        pat: pctx ? pctx.getImageData(x, y, w, h).data : null, d: null, mb: null, mc: null };
      if (mctx) { t.mb = mctx.getImageData(x, y, w, h); t.mc = new ImageData(new Uint8ClampedArray(t.mb.data), w, h); }
      tiles.set(k, t);
    }
    return t;
  }

  function blend(b, c, i, sa, pat) {
    if (linear && mode !== 'pattern') {
      const a = b[i + 3] + (mode === 'erase' ? -sa : sa) * 255;
      c[i] = b[i]; c[i + 1] = b[i + 1]; c[i + 2] = b[i + 2];
      c[i + 3] = a; // Uint8ClampedArray clamps and rounds to nearest → keep + erase of one dab cancels exactly
    } else if (mode === 'erase') {
      c[i + 3] = b[i + 3] * (1 - sa) + 0.5;
    } else if (mode === 'pattern') {
      c[i] = b[i] + (pat[i] - b[i]) * sa + 0.5;
      c[i + 1] = b[i + 1] + (pat[i + 1] - b[i + 1]) * sa + 0.5;
      c[i + 2] = b[i + 2] + (pat[i + 2] - b[i + 2]) * sa + 0.5;
      c[i + 3] = b[i + 3] + (pat[i + 3] - b[i + 3]) * sa + 0.5;
    } else {
      const da = b[i + 3] / 255;
      const oa = sa + da * (1 - sa);
      if (oa <= 0) { c[i + 3] = 0; return; }
      const k = da * (1 - sa);
      c[i] = (cr * sa + b[i] * k) / oa + 0.5;
      c[i + 1] = (cg * sa + b[i + 1] * k) / oa + 0.5;
      c[i + 2] = (cb * sa + b[i + 2] * k) / oa + 0.5;
      c[i + 3] = oa * 255 + 0.5;
    }
  }

  function stamp(cx, cy) {
    const x0 = Math.max(0, Math.floor(cx - R)), y0 = Math.max(0, Math.floor(cy - R));
    const x1 = Math.min(W, Math.ceil(cx + R)), y1 = Math.min(H, Math.ceil(cy + R));
    if (x1 <= x0 || y1 <= y0) return;
    const invR = 1 / R;
    for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y1 - 1) / TILE); ty++) {
      for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x1 - 1) / TILE); tx++) {
        const t = tileAt(tx, ty);
        const ax = Math.max(x0, t.x), ay = Math.max(y0, t.y), bx = Math.min(x1, t.x + t.w), by = Math.min(y1, t.y + t.h);
        const b = t.before.data, c = t.cur.data, st = t.stroke, pat = t.pat;
        const mb = t.mb ? t.mb.data : null, mc = t.mc ? t.mc.data : null;
        let touched = false;
        for (let y = ay; y < by; y++) {
          const dy = (y + 0.5 - cy) * invR;
          const dy2 = dy * dy;
          if (dy2 >= 1) continue;
          let li = (y - t.y) * t.w + (ax - t.x);
          for (let x = ax; x < bx; x++, li++) {
            const dx = (x + 0.5 - cx) * invR;
            const d2 = dx * dx + dy2;
            if (d2 >= 1) continue;
            const s = falloff(Math.sqrt(d2)) * opacity * 255;
            if (s <= st[li]) continue;
            st[li] = s;
            const sa = st[li] / 255;
            const i = li * 4;
            blend(b, c, i, sa, pat);
            if (mb) blend(mb, mc, i, sa, pat);
            touched = true;
          }
        }
        if (touched) {
          const r = { x: ax, y: ay, w: bx - ax, h: by - ay };
          t.d = t.d ? union(t.d, r) : r;
          dirty = dirty ? union(dirty, r) : r;
          bbox = bbox ? union(bbox, r) : { ...r };
        }
      }
    }
    o.onStamp?.(cx, cy, R);
  }

  function flush() {
    for (const t of tiles.values()) {
      if (!t.d) continue;
      ctx.putImageData(t.cur, t.x, t.y, t.d.x - t.x, t.d.y - t.y, t.d.w, t.d.h);
      if (mctx) mctx.putImageData(t.mc, t.x, t.y, t.d.x - t.x, t.d.y - t.y, t.d.w, t.d.h);
      t.d = null;
    }
    const r = dirty;
    dirty = null;
    return r;
  }

  // walk along a polyline, stamping every `spacing` px
  function walk(ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len === 0) return;
    let pos = spacing - carry;
    while (pos <= len) {
      const k = pos / len;
      stamp(ax + dx * k, ay + dy * k);
      lastStamp = [ax + dx * k, ay + dy * k];
      pos += spacing;
    }
    carry = len - (pos - spacing);
  }
  function quad(p0, c, p1) {
    const len = Math.hypot(c[0] - p0[0], c[1] - p0[1]) + Math.hypot(p1[0] - c[0], p1[1] - c[1]);
    const n = Math.max(1, Math.ceil(len / Math.max(1, spacing * 0.5)));
    let prev = p0;
    for (let i = 1; i <= n; i++) {
      const t = i / n, u = 1 - t;
      const p = [u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]];
      walk(prev[0], prev[1], p[0], p[1]);
      prev = p;
    }
  }
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

  return {
    addPoint(x, y) {
      if (ended) return null;
      const p = [x, y];
      if (!pts.length) {
        pts.push(p);
        stamp(x, y);
        lastStamp = p;
        carry = 0;
        return flush();
      }
      const lastP = pts[pts.length - 1];
      if (Math.hypot(x - lastP[0], y - lastP[1]) < 0.5) return null;
      pts.push(p);
      if (pts.length === 2) {
        walk(pts[0][0], pts[0][1], ...mid(pts[0], pts[1]));
      } else {
        const n = pts.length;
        quad(mid(pts[n - 3], pts[n - 2]), pts[n - 2], mid(pts[n - 2], pts[n - 1]));
      }
      if (pts.length > 3) pts = pts.slice(-3);
      return flush();
    },
    /** Finishes the stroke: returns { rect, before, after } or null when nothing changed. */
    end() {
      if (ended) return null;
      if (pts.length >= 2) {
        const n = pts.length;
        walk(...mid(pts[n - 2], pts[n - 1]), pts[n - 1][0], pts[n - 1][1]);
      }
      flush();
      ended = true;
      if (!bbox) return null;
      const r = bbox;
      const collect = (c2d, key) => {
        const after = c2d.getImageData(r.x, r.y, r.w, r.h);
        const before = new ImageData(new Uint8ClampedArray(after.data), r.w, r.h);
        const bd = before.data;
        for (const t of tiles.values()) {
          const ax = Math.max(r.x, t.x), ay = Math.max(r.y, t.y), bx = Math.min(r.x + r.w, t.x + t.w), by = Math.min(r.y + r.h, t.y + t.h);
          if (bx <= ax || by <= ay) continue;
          const src = t[key].data;
          for (let y = ay; y < by; y++) {
            const so = ((y - t.y) * t.w + (ax - t.x)) * 4;
            bd.set(src.subarray(so, so + (bx - ax) * 4), ((y - r.y) * r.w + (ax - r.x)) * 4);
          }
        }
        return { before, after };
      };
      const main = collect(ctx, 'before');
      const res = { rect: { ...r }, before: main.before, after: main.after };
      if (mctx) res.mirror = collect(mctx, 'mb');
      tiles.clear();
      return res;
    },
    cancel() {
      for (const t of tiles.values()) { ctx.putImageData(t.before, t.x, t.y); if (mctx) mctx.putImageData(t.mb, t.x, t.y); }
      ended = true;
      const r = bbox;
      tiles.clear();
      return r;
    },
    get bbox() { return bbox; },
    get lastStamp() { return lastStamp; },
  };
}

function union(a, b) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

export function brushSizeStep(size, dir) {
  const f = dir > 0 ? 1.2 : 1 / 1.2;
  let n = Math.round(size * f);
  if (n === size) n += dir > 0 ? 1 : -1;
  return Math.max(2, Math.min(800, n));
}

/** Draws the round brush cursor at viewport.pointer (screen space). mode: 'keep'|'erase'|other */
export function drawBrushCursor(ctx, viewport, { size, hardness = 0.7, mode = null } = {}) {
  const p = viewport.pointer;
  if (!p.inside || viewport.spaceHeld || viewport.isPanning) return;
  const r = Math.max(1.5, (size / 2) * viewport.zoom);
  const x = p.sx, y = p.sy;
  ctx.save();
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  if (hardness < 0.95 && r > 8) {
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.beginPath(); ctx.arc(x, y, Math.max(2, r * Math.max(0.05, hardness)), 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
  }
  if (mode === 'keep' || mode === 'erase') {
    const g = Math.min(6, Math.max(3, r * 0.25));
    ctx.lineWidth = 3.2;
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.moveTo(x - g, y); ctx.lineTo(x + g, y);
    if (mode === 'keep') { ctx.moveTo(x, y - g); ctx.lineTo(x, y + g); }
    ctx.stroke();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = mode === 'keep' ? '#3ddc84' : '#ff5a6e';
    ctx.beginPath();
    ctx.moveTo(x - g, y); ctx.lineTo(x + g, y);
    if (mode === 'keep') { ctx.moveTo(x, y - g); ctx.lineTo(x, y + g); }
    ctx.stroke();
  }
  ctx.restore();
}
