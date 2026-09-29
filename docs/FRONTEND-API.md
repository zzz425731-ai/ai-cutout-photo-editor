# Frontend API guide (for phase-2 panel authors)

This describes the front-end core **as actually implemented** in `web/js/` (verified against the code).
ARCHITECTURE.md is the contract; where this file is more specific, this file is right.
All user-facing text: short, friendly **Simplified Chinese**. No CDN / external resources.

Files you own as a phase-2 author: `web/js/panels/<id>.js`, `web/css/panels/<id>.css`,
`web/js/tests/panels/<id>.test.js` (already created, auto-loaded by `tests.html`), and any NEW files you
add under `web/js/tools/` or `web/js/panels/<id>/`. `web/js/layers/render-layers.js` belongs to the
text/sticker author(s). Everything else in `web/` is core (frontend-core track) — ask, don't edit.

---------------------------------------------------------------------------------------------------
## 1. Panel registration & lifecycle (`core/panels.js`)

```js
registerPanel({
  id: 'mosaic',            // keep the stub's id / title / icon / order
  title: '打码',           // rail label (2–4 chars) and panel heading
  icon: 'mosaic',          // icons.js name OR a full '<svg…>' string (stubs pass icon('mosaic', 22))
  order: 100,              // rail order: cutout 10, background 20, idphoto 30, adjust 40, beauty 50,
                           // crop 60, text 70, sticker 80, erase 90, mosaic 100, batch 110
  tip: '…',                // rail tooltip
  subtitle: '…',           // optional grey line under the heading
  requiresDoc: true,       // default true: without an image the panel shows 「先打开一张图片」 instead
  mount(el, ctx) { … },    // build UI into el (empty .panel-body)
  unmount() { … },         // optional
});
```

Lifecycle (exact):
- `mount(el, ctx)` runs every time the panel is shown, **and again whenever a new image is opened**
  (`doc:loaded` remounts the current panel). Build everything from `store.doc` inside mount; never cache
  doc state in module scope across mounts.
- Before each mount the previous panel is unmounted: first every `ctx.on(...)` subscription and every
  `ctx.onDispose(fn)` callback is removed/run, then `unmount()`. Then `tools.setTool('pan')` is called
  (so the old tool's `deactivate()` runs) — **a panel must re-activate its own tool in mount if it wants one active**.
- `mount` throwing is caught: the panel shows 「这个功能暂时出了点问题…」 and the error goes to the console.
- `requiresDoc:false` panels (batch) mount with `store.doc === null` possible.
- `showPanel(id)`, `currentPanelId()`, `getPanels()`, `refreshPanel()` (remount current) are exported.

`ctx` passed to mount:

| key | what |
|---|---|
| `store` | `core/store.js` store object |
| `viewport` | `core/viewport.js` viewport object |
| `tools` | module: `registerTool, setTool, currentTool, getTool` |
| `brush` | module: `createBrushStroke, brushSizeStep, drawBrushCursor` |
| `ui` | module `core/ui.js` (all helpers below) |
| `api` | module `core/api.js` |
| `io` | module `core/io.js` |
| `render` | module: `renderDoc, effectiveMask, prewarm, clearRenderCache, renderCacheInfo, hexToRgb` |
| `actions` | module `core/actions.js` |
| `exporter` | module `core/exporter.js` |
| `icons` | `{ icon, ICONS }` |
| `panels` | module `core/panels.js` |
| `el` | same as the `el` argument |
| `on(evt, fn)` | `store.on` that is removed automatically on unmount (returns `off`) |
| `onDispose(fn)` | cleanup callback run on unmount |

You may also import core modules directly (`import { store } from '../core/store.js'`) — same singletons.
`window.__app` is the same ctx (debug / CDP tests only).

### Minimal complete panel (copy this)

```js
// panels/mosaic.js
import { registerPanel } from '../core/panels.js';
import { store } from '../core/store.js';
import { setTool } from '../core/tools.js';
import { h, section, slider, segmented, button, toast, busy } from '../core/ui.js';
import { icon } from '../core/icons.js';
import '../tools/mosaic-brush.js';            // your tool module registers itself on import

registerPanel({
  id: 'mosaic', title: '打码', icon: icon('mosaic', 22), order: 100, tip: '马赛克、模糊，一键给人脸打码',
  mount(el, ctx) {
    const state = { kind: 'mosaic' };            // per-mount UI state (not undoable)
    const kind = segmented({ block: true, value: 'mosaic',
      options: [{ value: 'mosaic', label: '马赛克' }, { value: 'blur', label: '模糊' }],
      onChange: (v) => { state.kind = v; } });
    const size = slider({ label: '画笔大小', min: 2, max: 400, unit: 'px', value: store.ui.brush.size,
      onInput: (v) => { store.ui.brush.size = v; store.emit('brush:changed', store.ui.brush); } });
    // a doc value → one coalesced undo step per slider drag
    const strength = slider({ label: '强度', min: 0, max: 100, value: store.doc.mosaic?.strength ?? 50, defaultValue: 50,
      onInput: (v) => store.commit('打码强度', (d) => { d.mosaic = { ...(d.mosaic || {}), strength: v }; }, { coalesce: 'mosaic.strength' }) });
    const go = button({ text: '开始涂抹', icon: 'brush', primary: true, block: true, onClick: () => setTool('mosaic-brush', { kind: state.kind }) });
    const sec = section('打码', '在要遮住的地方涂一涂');
    sec.append(kind, size, strength, go);
    el.append(sec);

    function sync() {                            // keep controls in sync after undo/redo
      strength.setValue(store.doc.mosaic?.strength ?? 50);
      size.setValue(store.ui.brush.size);
    }
    ctx.on('doc:changed', (p) => { if (p?.reason !== 'bump') sync(); });   // skip per-dab bumps
    ctx.on('brush:changed', () => size.setValue(store.ui.brush.size));      // [ ] keys
    sync();
  },
});
```
CSS for the panel goes in `css/panels/<id>.css` (already linked). Prefix your classes with the panel id.

---------------------------------------------------------------------------------------------------
## 2. Document model (`store.doc`, created by `createDoc` in `core/store.js`)

```js
{
  name: '照片',             // file base name (no extension); used by suggestFilename → '照片_抠图.png'
  width, height,            // size of every pixel plane (source/fg/mask/maskAI)
  source: HTMLCanvasElement,// opaque RGB photo (all photo edits land here). NOT created with willReadFrequently
  fg: Canvas|null,          // 去色边 copy of source (from /api/matte): equals source except in the soft edge band
  mask: Canvas|null,        // subject mask in the ALPHA channel (RGB = 0). created with { willRead: true }
  maskAI: Canvas|null,      // untouched AI mask (「恢复AI结果」)
  cutout: false,            // true ⇒ subject separated from background using mask
  edge: { feather: 0, shift: 0 },                         // full-res px; feather 0..30, shift -15..15
  bg: { type: 'original', color: '#ffffff', color2: '#4a90e2', angle: 180, image: null, blur: 24 },
      // type: 'original'|'transparent'|'color'|'gradient'|'image'|'blur'; image = Canvas (cover-fit)
  fx: { shadow: { on: false, blur: 30, dx: 0, dy: 12, opacity: 0.35, color: '#000000' },
        stroke: { on: false, width: 12, color: '#ffffff' } },
  adjust: { exposure: 0, brightness: 0, contrast: 0, saturation: 0, vibrance: 0, temperature: 0, tint: 0,
            highlights: 0, shadows: 0, sharpen: 0, vignette: 0, fade: 0, grain: 0,
            filter: 'none', filterStrength: 100 },
  layers: [],               // text/emoji/image layers (section 8)
  dpi: null,                // e.g. 300 → written into saved JPEG/PNG by /api/save
}
```
Defaults are exported: `DEFAULT_EDGE, DEFAULT_BG, DEFAULT_FX, DEFAULT_ADJUST` (clone before use:
`cloneData(DEFAULT_ADJUST)`). `createDoc({ source, name, ...overrides })`.

- A PNG/WebP with transparency opens as `cutout:true`, `bg.type:'transparent'`, `mask` = its alpha,
  `maskAI` = copy, `source` = the image flattened on white, `fg` = source with the PNG's own colours in
  semi-transparent pixels (no white halo on new backgrounds; `null` if the alpha is hard-edged).
- `maskAI.__matte = { mode, ms }` is set by 一键抠图 (absent for PNG-alpha docs) — the 抠图 panel shows it.
- Panels may add their own **plain-data** fields (e.g. `doc.idphoto = {...}`); commit/undo handles them
  (a field missing in an older snapshot is deleted on undo). Canvases anywhere in the doc are kept by reference.
- Images are capped to 4096 px long side on load (toast tells the user).

---------------------------------------------------------------------------------------------------
## 3. Store (`core/store.js`)

```js
import { store, createDoc, cloneData, uidOf, bumpCanvas, dirtySince, unionRect,
         DEFAULT_EDGE, DEFAULT_BG, DEFAULT_FX, DEFAULT_ADJUST } from '../core/store.js';
```
| API | behaviour |
|---|---|
| `store.doc` | current doc or `null`. **Identity never changes on undo/redo** (same object, fields replaced). |
| `store.ui` | `{ panel, tool, selectedLayerId, brush:{size:40,hardness:0.7}, showMask:true, cutoutMode:'general' }` + runtime extras set by core: `brushing` (mask brush stroke active), `lastMatte:{mode,ms}`, `lastColor`, `lastGradient`, `serverStatus` (`/api/status` result). Not undoable. Panels may add namespaced keys (`store.ui.mosaicKind`). |
| `store.setDoc(doc)` | new document, clears history, `dirty=false`; emits `doc:loaded`, `doc:changed{reason:'load'}`, `history:changed`. Use `actions.loadFile` for user files. |
| `store.commit(label, mutate, { coalesce })` | snapshots all plain data (deep clone; canvases by reference), runs `mutate(doc)`, pushes one undo step, clears redo, `dirty=true`, emits `doc:changed{reason:'commit',label}` + `history:changed`. Returns mutate's return value. If `mutate` throws, the doc is rolled back and the error re-thrown. Consecutive commits with the same `coalesce` key within **800 ms** (and empty redo stack) merge into one step (label = latest). Use keys like `'mosaic.strength'`. |
| `store.commitRegion(label, plane, rect, before, after?)` | after a brush mutated `doc[plane]` (name string or a canvas) **in place**: records `{x,y,w,h}` before/after `ImageData` (after read from the plane if omitted), marks the rect dirty for render caches, one undo step. |
| `store.commitRegions(label, parts)` | same, several planes in ONE undo step. `parts = [{ plane, rect, before, after? }, …]`, falsy parts skipped. Use for brushes with `mirror` (source + fg). |
| `store.endCoalesce(key?)` | ends the current coalescing run so the next commit starts a new step. `ui.slider` calls it when a mouse drag is released (and after number-box entry / double-click reset), so **every drag is one undo step** even when two drags follow within 800 ms. Call it yourself for other continuous controls (e.g. a native colour picker's `change`). |
| `store.undo()` / `redo()` | return `false` if nothing to do. Emit `doc:changed{reason:'undo'|'redo', label, plane?, rect?}` + `history:changed`. |
| `canUndo() canRedo() undoLabel() redoLabel() historyInfo()` | `historyInfo() → { undo, redo, bytes, labels }` |
| `store.bump(plane, rect?)` | mark a plane (doc field name **or canvas**) changed in place; rect limits the change (partial cache update). Emits `doc:changed{reason:'bump', plane, rect}` (→ re-render). Not an undo step. |
| `store.dirty`, `store.markSaved()` | unsaved flag (status bar 「有未保存的修改」, unload/open prompts) |
| `store.version` | increments on every doc change |
| `setHistoryLimits({maxSteps, maxBytes})`, `getHistoryLimits()` | defaults 80 steps / 512 MB (region diffs + planes only referenced by history). Region diffs whose RGB is all 0 (mask planes) are stored alpha-only (¼ memory) automatically. |
| `store.on(evt, fn) → off`, `off`, `emit(evt, payload)` | listener errors are caught and logged |

Events actually emitted:

| event | payload | when |
|---|---|---|
| `doc:loaded` | doc | new image (setDoc) |
| `doc:changed` | `{reason:'load'|'commit'|'undo'|'redo'|'bump', label?, plane?, rect?}` | any doc change. `bump` fires per brush dab — filter it out in UI sync. |
| `history:changed` | – | undo/redo stacks or dirty changed |
| `panel:changed` | `{id}` | rail switch |
| `tool:changed` | `{id, opts}` | setTool (always emitted), mask-brush X toggle |
| `layer:selected` | `{id}` | emitted by main.js with `{id:null}` after Delete removes the selected layer; layer panels emit it on selection |
| `brush:changed` | `store.ui.brush` | `[` `]` keys, brush size sliders, new image (size reset to 4% of short side, 8..300) |
| `view:changed` | `{zoom}` | zoom / pan / fit |
| `cutout:running` | bool | `/api/matte` started / finished |
| `saved` | `{path}` | 保存 succeeded |
| `exported` | `{blob, format}` | export-dialog download |
| `files:dropped` | `File[]` | drop of **2+ files while the batch panel is active** (1 file, or other panels → opened as the doc) |

(`busy` and `mask:view` from older docs are **not** emitted.)

---------------------------------------------------------------------------------------------------
## 4. Rendering (`core/render.js`) and cache rules

`renderDoc(doc, { scale = 1, showOriginal = false, target, noLayers = false, maskView = false }) → canvas`
- `scale` is **clamped to ≤ 1**; output size `round(W*scale) × round(H*scale)`; `target` canvas is resized/reused.
- Pipeline: `photo = adjust(source)`; `showOriginal` → unadjusted source only. `maskView` → photo + red over
  removed area. If `!cutout || !mask` → photo. Else background (`original` photo / `blur` blurred photo /
  `transparent` nothing / `color` / `gradient` color→color2 at `angle` (180 = top→bottom) / `image` cover-fit,
  white if null) → stroke (outline behind subject) → shadow → subject = adjust(fg ?? source) ∩ effective mask.
  Then `drawLayers(ctx, doc, scale)` unless `noLayers`.
- `effectiveMask(doc, scale=1) → { arr: Uint8Array, canvas, w, h }` — mask after 收缩/扩展 + 羽化 (cached;
  treat as read-only). Use it (scale 1) when you need "what the user sees as the subject".
- `clearRenderCache()` (called on image open), `renderCacheInfo() → {entries, bytes}` (600 MB LRU).
- `prewarm(doc, scale) → Promise<bool>` computes the slow full-resolution mask stages (收缩/扩展, 羽化, 描边 distance
  field) in a module worker (`core/mask-worker.js`) and stores them in the cache; the viewport's full-quality refine and
  `exportDoc` use it, so big images don't freeze the page. Optional — `renderDoc` stays synchronous and correct without it.

**The viewport re-renders automatically on every `doc:changed`** (commit/undo/redo/bump/commitRegion).
You only call `viewport.requestRender()` for view-only state that is not in the doc (e.g. `store.ui.showMask`).

**Cache invalidation rules** (caches key on `uidOf(canvas)` + `canvas.__v`):
1. Whole-image operations: create a NEW canvas and assign it inside `store.commit` → new identity → caches
   miss automatically, undo restores the old canvas. Never modify a doc canvas in place inside `commit`
   (undo would not restore it).
2. In-place pixel edits (brushes): after each change call `store.bump('source'|'fg'|'mask'|…, rect)` (or with the
   canvas) so previews update; finish with `commitRegion`/`commitRegions` (they bump the final rect too).
   Forgetting bump = stale preview/export (the GL adjust texture is also keyed by `__v`).
3. `bg.image`, layer canvases, scene images are drawn directly every render (not cached): no bump needed,
   but mutate them only via commit with a new canvas, or call `store.bump(canvas)` to trigger a redraw.
4. **`doc.fg` is used for the cut-out subject.** Any edit to `source` must also reach `fg` or the subject keeps
   the old pixels: use `actions.replaceSource(label, newCanvas, { rect })` for whole results (inpaint, retouch,
   box mosaic) or the brush `mirror: doc.fg` option + `commitRegions` for in-place strokes. `io.mapPlanes`
   handles crop/rotate/flip/resize for all four planes.

---------------------------------------------------------------------------------------------------
## 5. Viewport (`core/viewport.js`)

| API | |
|---|---|
| `zoom`, `panX`, `panY` | screen px = doc px × zoom + pan (stage CSS px, origin = stage top-left) |
| `toDoc(e) → {x,y}` | client event (or `{clientX, clientY}`) → doc px (floats, may be outside the image) |
| `toScreen(x, y) → {x,y}` | doc px → stage CSS px (use in overlays) |
| `docRect() → {x,y,w,h}` | image rect in stage CSS px |
| `pointer` | `{ x, y, sx, sy, inside }` last pointer (doc px and stage CSS px) |
| `width`, `height`, `dpr` | stage CSS size, devicePixelRatio |
| `fit()`, `fitZoom()`, `setZoom(z, ax?, ay?)`, `zoomBy(f, ax?, ay?)`, `zoomStep(±1)`, `panBy(dx, dy)` | zoom 0.02..16; pan is clamped so ≥60 px of the image stays visible |
| `requestRender()` | re-render the doc next frame (coalesced) |
| `requestOverlay()` | redraw only overlays (tool cursor, handles) |
| `addOverlay(fn(ctx, viewport)) → remove()` | extra overlay (e.g. crop frame, face boxes). ctx is pre-scaled to CSS px; call `remove` in `ctx.onDispose` |
| `setCompare(bool)`, `compare` | hold-to-compare (shows unadjusted source only) |
| `isPanning`, `spaceHeld`, `previewScale`, `lastRenderMs`, `preview`, `renderNow()`, `updateCursor()` | |

The stage auto-fits when the doc size changes (e.g. after crop); fit zoom is ≤ 200 % (tiny images up to 800 %).
Preview renders at ≤1 scale, stepping by √2 with zoom×dpr. When a full-quality render at that scale is slow (big
image, high zoom) it renders a cheaper preview while changes keep coming (slider drag, brushing) and refines ~240 ms
after they stop — never while a mouse button is still held — with the heavy mask maths prewarmed in a worker.
`viewport.isStroking` is true while a tool stroke is in progress (main.js ignores Ctrl+Z/Y then);
`viewport.renderCount` counts renders (tests).

---------------------------------------------------------------------------------------------------
## 6. Tools (`core/tools.js`) and brush engine (`core/brush.js`)

```js
registerTool({
  id: 'mosaic-brush',
  cursor: 'none',          // CSS cursor over the stage ('none' + drawBrushCursor for brushes)
  hint: '…',               // status-bar text (string or getter; emit 'tool:changed' to refresh a getter)
  pans: false,             // true → left-drag pans (like the default 'pan' tool)
  maskView: false,         // true → while active (and store.ui.showMask) stage shows photo + red removed area
  activate(opts) {}, deactivate() {},            // deactivate MUST finish/cancel an open stroke
  onPointerDown(pt, e) {}, onPointerMove(pt, e) {}, onPointerUp(pt, e) {},
  onDoubleClick(pt, e) {}, onKey(e) {},          // onKey: keydown, not while typing in inputs or with a modal open
  drawOverlay(ctx, viewport) {},                 // stage CSS px; drawn after every pointer move
});
setTool('mosaic-brush', { kind: 'blur' });       // unknown id → 'pan'; always emits tool:changed
currentTool(); getTool(id);
```
- `pt = {x, y}` in doc px (float, unclamped). `onPointerMove` is also called for hover (no button) — track
  your own "stroke active" state. Moves while pressed deliver coalesced events (smooth strokes).
- Space+drag and middle-drag always pan (the tool doesn't see those events); wheel zooms; the pointer is
  captured during a stroke; `pointercancel` → `onPointerUp`.
- `[` / `]` are handled globally in main.js: they change `store.ui.brush.size` (×1.2 steps, 2..800), emit
  `brush:changed` and redraw overlays. So read the size from `store.ui.brush.size` at stroke start.
- `X` toggles 保留/擦除 only inside mask-brush (its own onKey). `Delete/Backspace` deletes
  `store.ui.selectedLayerId` (main.js). Ctrl+Z/Y/S/O/E/0/1/+/- and `\` (compare) are global.

`createBrushStroke(o)`:
| option | |
|---|---|
| `plane` | canvas modified in place (gets a `willReadFrequently` 2D context; for planes you create use `createCanvas(w,h,{willRead:true})`) |
| `mode` | `'paint'` (source-over `color`; on a mask = add) · `'erase'` (reduce alpha) · `'pattern'` (blend toward `pattern`) |
| `size` | diameter in doc px (≥1). Divide screen sizes by `viewport.zoom` if you want screen-constant brushes |
| `hardness` | 0..1 (default 0.7), anti-aliased rim ≥ ~1px |
| `opacity` | 0..1 max per stroke (stamps never accumulate within one stroke) |
| `color` | hex for paint mode |
| `pattern` | same-size canvas (e.g. a pixelated or blurred copy of `source`) for mosaic / blur / restore brushes |
| `mirror` | optional second same-size canvas that receives the identical stroke (use `doc.fg` when painting `doc.source`) |
| `spacing` | stamp spacing as a fraction of size (default 0.1) |
| `linear` | mask planes: `paint` adds alpha and `erase` subtracts it (instead of source-over / multiply) — erasing exactly over a kept dab leaves no ghost rim. Used by the 抠图 mask brush |
| `onStamp(x, y, r)` | callback per stamp |

Returns `{ addPoint(x,y) → dirtyRect|null, end() → {rect, before, after, mirror?:{before,after}}|null, cancel() → rect|null, bbox, lastStamp }`.

Complete brush-on-photo tool pattern:
```js
let stroke = null, planes = null;
onPointerDown(pt) {
  const d = store.doc;
  planes = { src: d.source, fg: d.fg };
  stroke = createBrushStroke({ plane: d.source, mirror: d.fg, mode: 'pattern', pattern: myPixelated,
                               size: store.ui.brush.size, hardness: store.ui.brush.hardness });
  step(pt);
},
onPointerMove(pt) { if (stroke) step(pt); },
onPointerUp(pt) { if (stroke) { step(pt); finish(); } },
deactivate() { finish(); },
// helpers
function step(pt) { const r = stroke.addPoint(pt.x, pt.y); if (r) { store.bump('source', r); if (planes.fg) store.bump('fg', r); } }
function finish() {
  if (!stroke) return;
  const res = stroke.end(); stroke = null;
  if (!res || store.doc?.source !== planes.src) return;          // doc replaced meanwhile → drop
  store.commitRegions('马赛克', [{ plane: 'source', ...res }, res.mirror && { plane: 'fg', rect: res.rect, ...res.mirror }]);
}
```
`drawBrushCursor(ctx, viewport, { size, hardness, mode: 'keep'|'erase'|null })` draws the round cursor at
`viewport.pointer` (hidden while panning / space held). `brushSizeStep(size, dir)`.

---------------------------------------------------------------------------------------------------
## 7. io helpers (`core/io.js`) — all return NEW canvases

`MAX_SIDE = 4096` · `createCanvas(w, h, { willRead })` · `ctx2d(c)` · `cloneCanvas(c)` ·
`cropCanvas(c, {x,y,w,h})` (may extend outside → transparent) · `rotateCanvas90(c, 1|-1|2)` ·
`rotateCanvas(c, radians, { fill })` (same size, for straighten) · `flipCanvas(c, 'h'|'v')` ·
`resizeCanvas(c, w, h, { willRead })` (high quality, step-halving) ·
`mapPlanes(doc, fn(plane, key)) → { source, fg, mask, maskAI, width, height }` — apply a geometric op to all
planes; use as `store.commit('旋转', d => Object.assign(d, mapPlanes(d, c => rotateCanvas90(c, 1))))`.
**It does not touch `layers` or `bg.image`** — move/scale layer x/y yourself in the same commit.
`maskFromGray(c)` (R → alpha) · `grayFromMask(mask)` (alpha → opaque white-on-black, for /api/inpaint masks) ·
`maskFromAlpha(Uint8Array, w, h)` · `readAlpha(c, rect?) → Uint8Array` · `hasTransparency(c)` ·
`flatten(c, '#fff')` · `splitAlpha(c) → { source, mask, fg|null }` ·
`canvasToBlob(c, type='image/png', quality)` (quality 0..1 or 0..100) · `canvasToDataURL(c, type, q)` ·
`blobToDataURL(blob)` · `blobToCanvas(blob, {willRead})` · `dataURLToCanvas(url, {willRead})` ·
`loadImageFile(file, { maxSide }) → canvas` with `canvas.meta = { origWidth, origHeight, downscaled, hasAlpha, name }`
(throws Chinese errors for non-images / HEIC / broken files) · `downloadBlob(blob, filename)` ·
`thumbDataURL(c, maxSide=160, type='image/jpeg')`.

---------------------------------------------------------------------------------------------------
## 8. Layers (`layers/render-layers.js`, owned by the text/sticker author)

Stored in `doc.layers` (drawn in array order, last = top) as plain objects; image layers hold a `canvas`
by reference. Common: `{ id, type:'text'|'emoji'|'image', x, y /* centre, doc px */, rotation /* rad */, scale, opacity, hidden }`.
text: `{ text, fontSize, fontFamily, color, bold, italic, align, lineHeight, letterSpacing, stroke:{on,width,color}, shadow:{on,color,blur,dx,dy}, bg:{on,color,opacity,padding,radius} }` ·
emoji: `{ char, size }` · image: `{ canvas, width, height }` (base size before `scale`).
API: `drawLayers(ctx, doc, scale)`, `drawLayer(ctx, L, scale)`, `layerSize(L)`, `layerCorners(L)`,
`hitTestLayers(doc, x, y)`, `createTextLayer(props)`, `createEmojiLayer(props)`, `createImageLayer(canvas, props)`,
`newLayerId()`, `DEFAULT_FONT`, `EMOJI_FONT`.
- Add/modify only through `store.commit` (`d.layers = [...d.layers, L]`, drags with `coalesce: 'layer.move.'+id`).
- **After undo the layer objects are new clones** — keep the selected layer by `store.ui.selectedLayerId` and look
  it up (`store.doc.layers.find(l => l.id === id)`), never hold object references across commits.
- Selection: set `store.ui.selectedLayerId` and emit `layer:selected {id}`. A layer-transform tool should live in
  `web/js/tools/` (new file) and draw handles via `drawOverlay` using `layerCorners` + `viewport.toScreen`.
- Layers are excluded from hold-to-compare and are drawn on top of everything (after the subject).

---------------------------------------------------------------------------------------------------
## 9. API client (`core/api.js`) — all throw `Error` with a Chinese message (`err.status` = HTTP code)

`status()` · `matte(blob, { mode:'general'|'portrait', decontam=true })` → `{ mask, fg, fg_rect, width, height, ms }` (data URLs; `fg` is a 去色边 PATCH: RGBA, opaque only at corrected soft-edge pixels, placed at `fg_rect=[x,y,w,h]`) ·
`matteCanvas(canvas, opts) → { mask: Canvas(alpha), fg: { canvas, x, y }|null, ms }` — to get a full fg plane: copy the source and `drawImage(fg.canvas, fg.x, fg.y)` (that is what `actions.runCutout` does) ·
`faces(blob) → { faces:[{x,y,w,h,score,landmarks:[[x,y]×5]}], width, height }` (input px; sort by area desc) ·
`inpaint(imageDataURL, maskDataURL) → { image, ms, engine }` (mask white = remove, same size) ·
`retouch({ image, smooth, whiten, mask }) → { image, ms }` ·
`save(dataURLOrBlob, filename, { subdir, dpi }) → { path }` · `openOutput(path?)` (opens Explorer — never call it in tests).
Send photos as JPEG blobs (`canvasToBlob(doc.source, 'image/jpeg', 0.95)`); send masks as PNG data URLs.
Server-side results replace `source` via `actions.replaceSource` (keeps fg in sync).

Pattern for any server call:
```js
const doc = store.doc, src = doc.source;
const b = ui.busy('正在消除…');
try {
  await actions.nextFrame();                                   // let the busy overlay paint
  const r = await api.inpaint(io.canvasToDataURL(src, 'image/png'), io.canvasToDataURL(io.grayFromMask(myMask), 'image/png'));
  if (store.doc !== doc || doc.source !== src) return;         // user opened another image / undid meanwhile
  const out = await io.dataURLToCanvas(r.image);
  actions.replaceSource('消除', out, { rect: bboxOfMask });
} catch (err) { ui.toast(err.message || '处理失败，请重试', 'error'); }
finally { b.done(); }
```

---------------------------------------------------------------------------------------------------
## 10. UI kit (`core/ui.js`)

Every value control returns a DOM element with `el.setValue(v)` (silent, no callback), `el.getValue()`, `el.setDisabled(bool)`.
| helper | signature / notes |
|---|---|
| `h(tag, attrs, ...children)` | attrs: `class`, `style` (object; `--vars` ok), `html`, `onclick`/`on*` functions, `data-*`, booleans (`true` → attribute, `false/null` → skipped) |
| `section(title, hint?, { icon, right })` | `<section class="sec">` with `.sec-h` header (+ `right` element) and `.sec-hint`; append controls to it |
| `slider({ label, min=0, max=100, step=1, value, unit, defaultValue, hint, power, format(v), onInput(v), onChange(v) })` | range + editable number box; `onInput` every move (commit with `coalesce`), `onChange` on release/number entry; double-click label → `defaultValue`. Releasing a drag calls `store.endCoalesce()`. Focus/blur of the number box without a change fires nothing. `power: 2` → non-linear track (fine control at the low end, e.g. brush size 2..800); then `el.input` runs 0..1000 internally — always use `getValue/setValue`. `el.input` = the range |
| `toggle({ label, hint, value, onChange(bool) })` | switch row; `el.input` = checkbox |
| `segmented({ options:[{value,label,icon?,tip?,key?}], value, onChange(v), onReselect(v), block, size:'sm', className })` | `value:null` = none selected |
| `colorSwatches({ colors:[{value,name}|'#hex'], value, custom=true, onChange(hex), onInput(hex) })` | custom opens native picker; `onInput` fires continuously while dragging it (use a coalesce key); closing the picker ends the coalescing run |
| `button({ text, icon, primary, variant:'secondary'|'ghost'|'danger', size:'sm'|'lg', block, tip, key, className, disabled, onClick })` | `b.setDisabled(d)`, `b.setText(t)` |
| `select({ options:[{value,label}], value, onChange })` | native select |
| `field(label, control, hint?)`, `row(...children)` (flex, children flex:1), `hint(text)`, `divider()` | |
| `toast(msg, type='info'|'success'|'error'|'warning', { action:{text,onClick}, duration })` → `{el, close}` | max 4 visible; default 3.2 s, error 6 s, with action 7 s. Centred over the canvas area; opening a modal dismisses older toasts, and toasts raised while a modal is open show at the top of the window |
| `busy(msg) → { update(msg), done() }`, `isBusy()` | full-stage spinner, counts nested calls; blocks rail/panel clicks and shortcuts. **Always `done()` in `finally`** |
| `confirm(msg, { title, okText, cancelText, danger, width }) → Promise<bool>` | |
| `modal({ title, content: Node|html, buttons:[{text, primary, variant, icon, id, value, onClick(close)}], width, closable, onClose }) → { el, body, close(v), result }` | a button without `onClick` closes with its `value`; with `onClick`: return `false` to stay open, and if it has no `value` you must call `close()` yourself. Esc closes, Enter = primary |
| `pickFiles({ accept='image/*', multiple }) → Promise<File[]>` | `[]` on cancel |
| `comingSoon({...})`, `initTooltips()` | tooltips: any element with `data-tip="…"` (+ `data-key="Ctrl+Z"`) |

---------------------------------------------------------------------------------------------------
## 11. actions (`core/actions.js`)

| | |
|---|---|
| `nextFrame()` | resolves after the browser painted — await it after `busy()` before heavy sync work |
| `openImage()`, `loadFile(file, { name })` | open flow (unsaved-changes confirm, 4096 cap, alpha PNG → cut-out doc) |
| `runCutout({ mode, then, label='一键抠图' }) → Promise<bool>` | /api/matte on `source`; one commit sets `mask`, `maskAI`, `fg`, `cutout=true`, `bg.type 'original'→'transparent'` (first time) then runs `then(doc)` inside the same commit |
| `isCutoutRunning()` | |
| `ensureCutout(then, { label='更换背景', reason }) → Promise<bool>` | if already cut out: `store.commit(label, then)`; else asks 「需要先抠图」 and runs `runCutout({ then })` (one undo step). Use for anything that needs a subject (证件照, 批量…) |
| `cancelCutout()`, `restoreAI()`, `setDecontam(on)` | 取消抠图 / 恢复AI结果 (also resets edge) / 去色边 |
| `replaceSource(label, newSource, { rect, then }) → bool` | one undo step: `source = newSource`, `fg` re-synced (changed pixels take the new photo), `then(d)` inside the commit. Same size required |
| `syncFg(oldSource, newSource, fg, rect?) → Canvas|null` | the fg merge used above |
| `saveToOutput({ format, quality=0.92, maxSide }) → {path}|null` | render → /api/save (dpi = `doc.dpi`) → toast with 「打开文件夹」 |

exporter (`core/exporter.js`): `exportDoc(doc, { format:'png'|'jpg'|'webp', quality, maxSide, background='#fff' }) → Blob`,
`exportCanvas(doc, { maxSide, flattenColor }) → Canvas`, `docHasTransparency(doc)`, `defaultSaveFormat(doc)`,
`suggestFilename(doc, fmt)`. export-dialog: `openExportDialog()` (Ctrl+E).

adjust (`core/adjust.js`): `ADJUST_PARAMS` (`[{key,label,min,max}]` for the 13 sliders), `FILTERS`
(`{ id: { name, params?, matrix?(3×4), split?{shadows,highlights} } }`; add presets by assigning `FILTERS.myId = {...}`
at module load), `applyAdjust(src, params, { out, docSize }) → canvas`, `adjustIsIdentity`, `adjustKey`,
`effectiveParams`, `setAdjustBackend('auto'|'gl'|'cpu')`, `adjustBackend()`. `doc.adjust` applies to the photo
and the subject (fg) alike; filter thumbnails: `applyAdjust(smallCanvas, { ...DEFAULT_ADJUST, filter: id })`.

maskops (`core/maskops.js`): `morph(arr,w,h,r)`, `blurMask(arr,w,h,sigma)`, `edgeMask(arr,w,h,shift,feather)`,
`distanceOutside(bin,w,h)`, `clampRect`, `expandRect`, `subRect`, `putRect`, `alphaToCanvas(arr,w,h,canvas,rect?,rgb?)`,
`canvasAlpha(canvas, rect?, dst?)`.

---------------------------------------------------------------------------------------------------
## 12. Icons (`core/icons.js`)

`icon(name, size = 20, extraAttrs = '') → '<svg class="ico" …>'` (24×24 viewBox, stroke = currentColor, 1.8 width).
Names: image imagePlus folderOpen undo redo plus minus fit compare save export chevronDown chevronRight cutout
background idphoto adjust beauty crop text sticker erase mosaic batch brush brushPlus eraser wand sparkles reset
close check info alert success folder eye trash hand chip wrench upload palette person cube shadow outline
keyboard lock logo. Unknown names render `info`.
Need another icon? Register it at module load from your panel: `ICONS.rotate = '<path d="…"/>'` (inner SVG
markup only; pick a unique name, prefix with your panel id if in doubt).

---------------------------------------------------------------------------------------------------
## 13. CSS conventions (`css/base.css`)

Tokens (`:root`): `--accent #3464f0`, `--accent-hover`, `--accent-active`, `--accent-soft #edf2ff`, `--accent-soft-2`,
`--accent-text`, `--focus-ring`, `--bg`, `--surface #fff`, `--surface-2`, `--surface-3`, `--hover`, `--pressed`,
`--border`, `--border-soft`, `--border-strong`, `--track`, `--text`, `--text-2`, `--text-3`, `--text-4`,
`--danger`, `--danger-soft`, `--success`, `--warning`, `--radius 8px`, `--radius-sm 6px`, `--radius-lg 12px`,
`--shadow-sm`, `--shadow`, `--shadow-lg`, `--font`, `--ease`, `--panel-w 304px` (280 px under 1180 px wide).
Panel body is 304 − 2×20 px padding − 8 px scrollbar gutter ≈ **256 px** of content width: keep grids ≤ 4 columns.

Reusable classes: `.sec` `.sec-h` `.sec-title` `.sec-hint` · `.hint` `.divider` `.row` `.field` `.field-label`
(`.field-label.mt` adds 14 px top margin) ·
`.btn` (`.primary .secondary .ghost .danger .sm .lg .block`) · `.icon-btn` · `.seg .seg-btn .on` ·
`.swatches .sw` · `.select .num-input .text-input` (34 px inputs) · `.ctl.slider/.toggle` ·
`.coming-soon` · `.panel-empty`. Tiles in background.css (`.bg-tile`, `.scene`, `.grad-chip`) are background-panel
private — copy the look, not the class names. Stage/overlay z-index: busy 30, drop-hint 20, modal 1000, toast 1100, tooltip 1200.

---------------------------------------------------------------------------------------------------
## 14. Pitfalls checklist

1. mount runs again on every panel switch and new image — no stale module state; subscribe with `ctx.on`.
2. Filter `doc:changed` with `reason === 'bump'` out of UI syncs (it fires per brush dab).
3. After undo/redo nested objects (`doc.bg`, `doc.layers[i]`, your `doc.xyz`) are NEW objects — re-read from `store.doc`.
4. Whole-image pixel ops → new canvas inside `commit` (or `replaceSource`). In-place → brush + `bump` + `commitRegion(s)`.
5. Editing `source` without updating `fg` leaves the cut-out subject showing old pixels (see 4.4).
6. Check the doc is still the same after any `await` (`store.doc === doc && doc.source === src`) before committing.
7. `busy().done()` in `finally`; `await nextFrame()` after `busy()` before heavy synchronous work.
8. Brushes: read `store.ui.brush.size` per stroke (the `[ ]` keys change it); finish strokes in `deactivate`.
9. Use `createCanvas(w, h, { willRead: true })` for planes you read back often; the first `getContext` options stick.
10. `renderDoc` never upscales (scale ≤ 1). For thumbnails render at `scale = 160 / max(W,H)`.
11. Coalesce keys must be unique per control (`'<panel>.<field>'`); a different key always starts a new step.
12. Text inputs: keydown on INPUT/TEXTAREA (except range/checkbox) is ignored by global shortcuts; for other
    focusable widgets stop propagation yourself if a key would clash (`[ ] \ x Delete`).
13. Everything user-visible in Chinese; no English leftovers in labels, toasts, tooltips or errors.
14. Tests: put them in `web/js/tests/panels/<id>.test.js` (auto-loaded). Run `tests.html` headless via
    `tests/cdp.mjs`; the page must end with 0 failures and 0 console errors.
