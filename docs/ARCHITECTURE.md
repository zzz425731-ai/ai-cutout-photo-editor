# AI抠图P图工具 — Architecture & Contracts

A local, offline photo cut-out (抠图) + photo-editing (P图) tool with a Chinese-language
interface on Windows 11. User double-clicks `启动抠图P图工具.bat` → a local
Python server starts → the browser opens the editor UI. All AI runs locally on the GPU
(RTX 5060 Laptop via DirectML) with CPU fallback. **No internet needed at runtime**:
the web UI must not load anything from a CDN (no external fonts/scripts/images).

All user-facing text is **Simplified Chinese**, short and friendly. Assume the user
does not know Photoshop terms: prefer 「抠图」「换背景」「消除笔」「打码」「证件照」 wording
and give one-line hints under controls where useful.

## Development reference environment
- Windows 11, Python 3.14.5 in the project `.venv` (installed: numpy 2.5,
  pillow 12.3, onnxruntime-directml 1.24.x, opencv-python-headless 5.0).
  No torch, no flask — **backend uses the Python stdlib `http.server` only** (+ numpy/cv2/PIL/onnxruntime).
- GPU: NVIDIA RTX 5060 Laptop (8GB) + AMD Radeon 610M iGPU (hybrid laptop!). DirectML
  `device_id` 0 may be the AMD iGPU — pick the NVIDIA adapter (benchmark / probe).
- CPU: Ryzen 9 9955HX 16C/32T, RAM 15GB.
- Browsers: Chrome (`C:\Program Files\Google\Chrome\Application\chrome.exe`) and Edge.
  Target Chrome/Edge (Chromium) only. WebGL2, OffscreenCanvas, createImageBitmap are available.
- If an HTTP(S) proxy is configured, local server requests must bypass it
  (for example, set `NO_PROXY=127.0.0.1,localhost`).

## Folder layout (root = the project directory)
```
启动抠图P图工具.bat         double-click launcher (UTF-8, chcp 65001)
server.py                  HTTP server: static web/ + JSON/binary API
engine/                    Python AI engine (no web code here)
  runtime.py               ORT session factory: DirectML (NVIDIA adapter) → CPU fallback
  matting.py               BiRefNet_lite (general) + MODNet (portrait) + edge refine + color decontam
  inpaint.py               LaMa (512x512 fixed) + cv2.inpaint fallback
  face.py                  YuNet face detection
  retouch.py               磨皮 / 美白
  imageio.py               decode/encode helpers (bytes/dataURL <-> numpy)
  download_models.py       (exists) downloads models into models/
models/                    birefnet_lite.onnx, modnet.onnx, lama_fp32.onnx, yunet.onnx (present)
web/
  index.html
  css/base.css             core styles & design tokens
  css/panels/<id>.css      one file per panel (linked from index.html)
  js/main.js               entry (type=module)
  js/core/*.js             core framework (store, render, viewport, tools, ui, api, io, gpu)
  js/panels/<id>.js        one module per left-rail panel
  js/tools/<id>.js         canvas tools (brushes, crop, layer transform)
  js/layers/render-layers.js  draws text/sticker/image layers (owned by the text/sticker panel author)
  tests.html + js/tests/   in-browser test harness (runs in headless Chrome)
tests/                     Python tests + tests/samples/README.md (instructions for local test photos)
输出/                      default output folder for saved images
docs/                      this file + reports
```

## Backend HTTP API (server.py)
- Binds **127.0.0.1 only**. Port: first free of 7860..7879. On start: print the URL and
  `webbrowser.open` it. If the tool is already running (a previous instance answers
  `/api/status`), just open the browser to it and exit.
- Rejects requests whose `Host` header isn't `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding).
- Every `POST /api/*` must carry header `X-KT: 1` (forces CORS preflight → other websites
  can't call the API). No CORS headers are ever sent.
- Static: `GET /` → `web/index.html`; `GET /<path>` → file under `web/` (reject `..`/absolute;
  correct MIME incl. `.js` = `text/javascript`, `.mjs`, `.css`, `.svg`, `.woff2`). `Cache-Control: no-store`.
- Max request body 256 MB. Errors → HTTP 4xx/5xx with JSON `{"error": "<中文说明>"}`.
- Single-image endpoints take the **raw image bytes** as the body (`Content-Type: image/jpeg|png|webp`).
  Multi-input endpoints take JSON with data URLs. Responses are JSON; images in responses are
  data URLs (`data:image/png;base64,...`).

| Method & path | Request | Response |
|---|---|---|
| `GET /api/status` | – | `{"ok":true,"version":"1.0","provider":"DirectML"|"CPU","device":"NVIDIA GeForce RTX 5060 Laptop GPU"|"CPU","models":{"general":bool,"portrait":bool,"inpaint":bool,"face":bool},"output_dir":"C:\\...\\输出"}` |
| `POST /api/matte?mode=general|portrait&decontam=1|0` | image bytes | `{"mask":"data:image/png;base64,..." (8-bit gray, same W×H as input), "fg": 去色边 patch — dataURL PNG **RGBA**, opaque only at the colour-corrected soft-edge pixels, or null, "fg_rect": [x,y,w,h] where the patch goes, or null, "width":W,"height":H,"ms":int}` (front-end: fg plane = copy of source with the patch drawn at fg_rect) |
| `POST /api/faces` | image bytes | `{"faces":[{"x":..,"y":..,"w":..,"h":..,"score":0.97,"landmarks":[[x,y]×5: right eye, left eye, nose, right mouth, left mouth]}],"width":W,"height":H}` (input pixel coords, sorted by area desc) |
| `POST /api/inpaint` | JSON `{"image": dataURL, "mask": dataURL}` mask white(>127)=remove, same size as image | `{"image": dataURL PNG same size, "ms":int, "engine":"lama"|"opencv"}` |
| `POST /api/retouch` | JSON `{"image": dataURL, "smooth":0-100, "whiten":0-100, "mask": dataURL|null}` (optional subject mask restricts effect) | `{"image": dataURL PNG same size, "ms":int}` |
| `POST /api/save` | JSON `{"data": dataURL, "filename":"照片_抠图.png", "subdir": "批量_20260925_1530" | null, "dpi": 300 | null}` | `{"path": "C:\\...\\输出\\照片_抠图.png"}` — filename sanitized (strip `\/:*?"<>|`, control chars), never overwrites (appends ` (2)`, ` (3)`), subdir is a single sanitized folder name inside 输出. JPEG/PNG DPI metadata written when `dpi` given (use PIL). |
| `POST /api/open-output` | JSON `{"path": optional file path inside 输出}` | opens Explorer at 输出 (or `/select,` the file). `{"ok":true}` |

### Engine requirements
- **Memory use is important** on machines with limited available RAM:
  BiRefNet runs as a mixed-precision fp16 model on DirectML (`models/birefnet_lite_fp16.onnx`, generated from
  the fp32 file by `engine/tofp16.py`; fp32 needs ~10 GB VRAM and spills into system RAM). Post-processing computes
  large-window statistics on downscaled images and evaluates per-pixel formulas only on the edge pixels.
  Measured: 12 MP matte ≈ 1.3 s (general) / 2.0 s (portrait) + 0.3 s encoding, process peak ≈ 0.7 GB.
- Sessions are created lazily and cached; one lock per model (serialize runs). The general
  matting model is preloaded in a background thread at server start so the first click is fast.
- DirectML: `SessionOptions.enable_mem_pattern=False`, `execution_mode=ORT_SEQUENTIAL`. Choose
  the NVIDIA adapter. Verify each model on DML once (compare against CPU on a test image);
  if DML errors or outputs differ badly, fall back to CPU for that model. Report the real provider in `/api/status`.
- **general** = BiRefNet_lite: RGB → resize 1024×1024 (bilinear) → /255 → normalize mean
  (0.485,0.456,0.406) std (0.229,0.224,0.225) → NCHW float32. Output: check whether it is
  logits (apply sigmoid) or already [0,1]. Upsample to the original size, then **edge refinement**
  (e.g. fast guided filter guided by the full-res image, only inside an uncertainty band around the
  edge) so hair/fur edges follow the photo, then remove tiny specks (< 0.05% of area). Must not eat
  holes into solid subjects or add halos.
- **portrait** = MODNet (+BiRefNet): MODNet input RGB, shortest edge 512, both sides multiple of 32,
  normalize mean 0.5 std 0.5. Recommended fusion: BiRefNet gives the robust shape; inside the edge
  band use MODNet's soft alpha for hair. Pick whatever measurably looks best on the sample portraits.
- **decontam** (去色边): estimate the true foreground colour in the semi-transparent band
  (e.g. blur-fusion, Forte & Pitié 2021) so edges don't carry the old background's colour.
  `fg` = input image everywhere except pixels with 0.01 < alpha < 0.99, which get the estimated
  foreground colour. (Pixels with alpha≈0 must stay the original photo — the user may paint them back.)
- **inpaint** = LaMa `lama_fp32.onnx`, fixed 512×512 input. Inspect input/output names/ranges.
  Around the mask bbox take a context crop (≈ bbox × 2–3, min 256px, clipped), pad to square,
  resize to 512, run, resize back, and composite **only inside the (slightly dilated, feathered)
  mask** onto the original full-res image. Fallback: `cv2.inpaint(..., cv2.INPAINT_TELEA)`.
- **faces**: `cv2.FaceDetectorYN` with yunet.onnx; detect on a copy downscaled to ≤1280px long
  side; map coordinates back. Score threshold 0.6.
- **retouch**: skin-aware smoothing (edge-preserving: guided/bilateral filter, strength by
  `smooth`) + whitening (brightening curve on skin, strength by `whiten`); skin mask from YCrCb
  ranges ∩ (face-expanded region if faces found, else whole image) ∩ optional subject mask.
  Must keep eyes/brows/hair detail. Target < 1.5 s on a 12 MP photo.
- Performance targets on this machine (12 MP JPEG, warm): matte < 3 s, faces < 0.3 s, inpaint < 2 s.

## Frontend architecture (vanilla ES modules, no build step, no external deps)

### Working resolution
Images are loaded with EXIF orientation applied and **capped at 4096 px on the long side**
(inform the user with a toast if downscaled). Pixel planes are `HTMLCanvasElement`s.

### Document model (`store.doc`)
```js
doc = {
  name: '照片',                 // base file name without extension
  width, height,               // pixel size of all planes
  source: Canvas,              // opaque RGB photo (all pixel edits land here)
  fg: Canvas|null,             // colour-decontaminated copy of source (from /api/matte); same size
  mask: Canvas|null,           // subject mask stored in the ALPHA channel (RGB black); same size
  maskAI: Canvas|null,         // the untouched AI mask (for 「恢复AI结果」)
  cutout: false,               // true ⇒ subject is separated from background using mask
  edge: { feather: 0, shift: 0 },     // px at full res; feather 0..30, shift -15..15 (shrink/expand)
  bg: { type: 'original'|'transparent'|'color'|'gradient'|'image'|'blur',
        color: '#ffffff', color2: '#4a90e2', angle: 180,   // gradient: color→color2
        image: Canvas|null, blur: 24 },                    // image: cover-fit; blur: blurred original
  fx: { shadow: { on:false, blur:30, dx:0, dy:12, opacity:0.35, color:'#000000' },
        stroke: { on:false, width:12, color:'#ffffff' } },  // sticker-style outline around subject
  adjust: { exposure:0, brightness:0, contrast:0, saturation:0, vibrance:0, temperature:0, tint:0,
            highlights:0, shadows:0, sharpen:0, vignette:0, fade:0, grain:0,  // each -100..100 (sharpen/vignette/fade/grain 0..100)
            filter: 'none', filterStrength: 100 },           // named preset (see adjust engine)
  layers: [ /* text / emoji / image layers, drawn on top, in order */ ],
  dpi: null,                   // e.g. 300 for ID photos (passed to /api/save)
}
layer (common) = { id, type:'text'|'image'|'emoji', x, y /* centre, doc px */, rotation /* rad */,
                   scale, opacity, hidden:false }
```
Pixel planes are treated as **immutable** for whole-image operations (crop/rotate/matte/inpaint
create new canvases and swap references). Brush tools mutate a plane in place and record a
**region diff** (before/after `ImageData` of the stroke's bbox) in history — never full copies per stroke.

### Rendering pipeline (`core/render.js`)
`renderDoc(doc, { scale = 1, showOriginal = false, target?, noLayers = false }) → canvas`
1. `photo = adjust(source)`, `subjectRGB = adjust(fg ?? source)` (adjust engine, WebGL2).
2. If `showOriginal` → just draw `source` (unadjusted, no cutout, no layers).
3. If `!cutout || !mask` → draw `photo`.
4. Else: effective mask = mask post-processed by `edge.shift` (erode/dilate) and `edge.feather`
   (blur); draw background per `bg.type` (`original` = photo, `blur` = blurred photo, `transparent` =
   nothing); then subject = subjectRGB ∩ effective mask, with `fx.stroke` (outline behind subject),
   `fx.shadow` (drop shadow behind subject), then the subject itself.
5. Draw `layers` via `drawLayers(ctx, doc, scale)` from `js/layers/render-layers.js`.
Preview renders at the viewport's device-pixel scale (≤1) for speed; export renders at scale 1.
Expensive intermediate results are cached by (plane version, params, scale).

### Adjust engine (`core/adjust.js`, WebGL2 with a slower CPU/ctx.filter fallback)
Implements every `doc.adjust` parameter in one shader pass (+ separable passes for sharpen).
Named filter presets live in a data table (`FILTERS` exported from `core/adjust.js`):
`none 原图, fresh 清新, warm 暖阳, cool 冷调, bw 黑白, vintage 复古, film 胶片, japan 日系,
vivid 鲜艳, cinematic 电影` — each is a set of base params plus an optional 4×5 colour matrix /
split-tone; `filterStrength` blends it. Panels may add presets to the table.

### Core modules and public APIs (panels/tools rely on these — keep them stable)
- `core/store.js` — `store.doc`, `store.ui = { panel, tool, selectedLayerId, brush:{size,hardness} }`,
  `store.on(evt, fn)`/`off`/`emit`. Events: `doc:loaded`, `doc:changed` (payload `{reason}`),
  `history:changed`, `panel:changed`, `tool:changed`, `layer:selected`, `busy`.
  `store.setDoc(doc)` (new document, clears history),
  `store.commit(label, mutate(doc), { coalesce?: key })` — records an undo step then mutates;
  consecutive commits with the same `coalesce` key within 800 ms merge into one step (sliders),
  `store.commitRegion(label, planeName, rect, beforeImageData)` — after a brush stroke already
  mutated the plane in place, `store.undo()`, `store.redo()`, `store.canUndo()`, `store.canRedo()`,
  `store.bump(planeName)` — mark a plane changed (invalidates caches), `store.dirty` flag.
- `core/viewport.js` — the stage canvas: zoom/pan/fit, checkerboard, hi-DPI, `viewport.toDoc(e)`
  → `{x,y}` doc px, `viewport.toScreen(x,y)`, `viewport.zoom`, `viewport.requestRender()`
  (re-render the doc), `viewport.requestOverlay()` (redraw only tool overlays),
  hold-to-compare (show original).
- `core/tools.js` — registry: `registerTool(tool)`, `setTool(id, options?)`, `currentTool()`.
  Tool interface: `{ id, cursor?, activate?(opts), deactivate?(), onPointerDown(pt, e),
  onPointerMove(pt, e), onPointerUp(pt, e), onKey?(e), drawOverlay?(ctx, viewport) }`.
  Built in: `pan` (default when no layers), plus `core/brush.js` — shared brush engine:
  `createBrushStroke({ plane, mode:'paint'|'erase', size, hardness, color, onStamp? })`
  handles pointer interpolation, soft round stamps, bbox tracking, and returns the bbox +
  before-ImageData for `commitRegion`; brush cursor overlay; `[` `]` change size.
- `core/panels.js` — registry: `registerPanel({ id, title, icon /* svg string */, order, mount(el, ctx), unmount?(), requiresDoc?: true })`.
  The left rail is generated from the registry. `ctx = { store, viewport, tools, api, ui, render, io }`.
- `core/ui.js` — Chinese UI kit: `section(title, hint?)`, `slider({label,min,max,step,value,unit,onInput,onChange})`,
  `toggle`, `segmented`, `colorSwatches({colors, value, custom:true})`, `button({text, primary, icon})`,
  `select`, `toast(msg, type='info'|'success'|'error', {action})`, `busy(msg)` → `{update(msg), done()}`,
  `confirm(msg)` → Promise<bool>, `modal({title, content, buttons})`, `pickFiles({accept, multiple})`.
- `core/api.js` — `status()`, `matte(blob,{mode,decontam})`, `faces(blob)`, `inpaint(imageDataURL, maskDataURL)`,
  `retouch({image, smooth, whiten, mask})`, `save(dataURLOrBlob, filename, {subdir, dpi})`,
  `openOutput(path?)`. Adds `X-KT: 1`. Throws `Error` with a Chinese message.
- `core/io.js` — `loadImageFile(file)` (EXIF-aware, 4096 cap) → canvas, `canvasToBlob(c, type, q)`,
  `blobToCanvas`, `dataURLToCanvas`, `canvasToDataURL`, `createCanvas(w,h)`, `cloneCanvas`,
  `cropCanvas`, `rotateCanvas90(c, dir)`, `flipCanvas(c, 'h'|'v')`, `resizeCanvas(c, w, h)`,
  `maskFromGray(canvas)` (gray→alpha), `grayFromMask`.
- `core/exporter.js` — `exportDoc(doc, {format:'png'|'jpg'|'webp', quality, maxSide})` → Blob.
  Top bar 「保存」 = save to 输出 (PNG when result has transparency, else JPG 92) + toast with
  「打开文件夹」; 「导出▾」 = format/quality/size + browser download.

### UI layout
Top bar: app name · 打开图片 · 撤销/重做 · 缩放 %/适应窗口 · 按住对比原图 · 保存 · 导出▾ · GPU/CPU badge.
Left: vertical icon rail of panels (icon + 2–4 char label) → panel column (≈300 px) with the
active panel. Centre: stage with checkerboard for transparency; empty state = big drop zone
「拖入图片 / 点击打开 / Ctrl+V 粘贴」. Bottom status bar: 尺寸 · 缩放 · 提示.
Keyboard: Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z, Ctrl+O, Ctrl+S, Ctrl+V, Space-drag pan, wheel zoom,
Ctrl+0 fit, Ctrl+1 100%, `[` `]` brush size, Delete removes selected layer, hold `\` = compare.
Light theme, calm neutral greys, one accent colour, 8px radius, system font stack
(`"Microsoft YaHei UI","PingFang SC",system-ui,sans-serif`). Must look polished and modern.

### Panels (rail order) and owners
| id | 名称 | contents | phase |
|---|---|---|---|
| `cutout` | 抠图 | 一键抠图 (模式: 通用 / 人像发丝), 去色边 toggle, 边缘 羽化/收缩扩展, 手动修补 画笔(保留/擦除, 大小, 硬度), 显示蒙版 overlay, 恢复AI结果, 取消抠图 | core |
| `background` | 背景 | 原背景/透明/纯色(证件照红蓝白 + 常用色 + 自定义)/渐变/图片/虚化; 主体 阴影 & 描边 | core |
| `idphoto` | 证件照 | size presets, 底色, auto-framing from face+mask, manual 缩放/上下/左右, 排版打印(6寸) | phase 2 |
| `adjust` | 调色 | filter preset thumbnails + strength, all adjust sliders, 重置 | phase 2 |
| `beauty` | 美颜 | 磨皮, 美白 via /api/retouch | phase 2 |
| `crop` | 裁剪 | ratios, rotate 90, flip, straighten, resize | phase 2 |
| `text` | 文字 | text layers + layer transform tool | phase 2 |
| `sticker` | 贴纸 | emoji stickers, 添加图片 as layer | phase 2 |
| `erase` | 消除 | 消除笔 via /api/inpaint | phase 2 |
| `mosaic` | 打码 | 马赛克/模糊 brush & box, 一键人脸打码, 涂鸦画笔 | phase 2 |
| `batch` | 批量 | batch 抠图/换底/压缩 for many files → 输出/批量_时间 | phase 2 |

## Testing
- Python: `tests/test_engine.py` & `tests/test_server.py` (plain asserts, runnable with `python tests/test_engine.py`).
  Visual outputs go to `tests/out/` (can be viewed with the Read tool).
- Browser: headless Chrome can load pages from the running server, e.g.
  `chrome --headless=new --disable-gpu=false --screenshot=out.png --window-size=1600,1000 http://127.0.0.1:7860/`
  or `--dump-dom` with `--virtual-time-budget=15000` on `web/tests.html` (a harness page that
  runs module tests and writes results into the DOM). Use a throw-away `--user-data-dir` in the scratch dir.
