# frontend-core progress

## 2026-09-25 session 1
- DONE: read all core; wrote docs/FRONTEND-API.md (complete guide for phase-2 panel authors).
- DONE: new core helpers (additive, documented): store.commitRegions (multi-plane one undo step),
  brush `mirror` option (paint source + fg together), actions.replaceSource / syncFg (keep 去色边 fg in sync
  when source changes). Tests: web/js/tests/core.test.js.
- DONE: web/js/tests/panels/<id>.test.js stubs for the 9 phase-2 panels, auto-loaded by run.js (dynamic import).
- tests.html: 97/97 green before QA.
- NOTE: tests/cdp.mjs b.close() hangs (Browser.close never answers) — in drivers race it with a timeout
  and process.exit(); kill leftover chrome by PID.
- NEXT: STEP 2 adversarial QA with cdp.mjs (server on port 7883).

## 2026-09-26 session 2 (QA run on shared server :7885)
- Started: re-read core + cutout/background; server up (DirectML). Plan: run tests.html, then adversarial cdp QA list.
- QA done so far: all samples/5000px drop/alpha/20x20/txt/fake/paste/multi-drop OK; cutout both modes + 去色边 patch
  + feather/shift + restore/cancel OK; brush dabs land within 0.05 doc px at 25/100/400 %, panned, dsf 1 & 2;
  background: 25 steps undo/redo pixel-exact; save → 输出 decodes (JPG 1920x2889, PNG RGBA); export PNG/JPG/WebP/sizes OK.
- FIXED: 「已抠出主体 null」 (append(null)); AI info now per image (maskAI.__matte), PNG-alpha docs say 「图片自带透明背景」/「恢复初始」;
  keep/erase ghost rim (brush `linear` option for masks); slider drags merged across releases (store.endCoalesce + ui.slider);
  number-box blur made an empty undo step; toasts covered the export dialog's buttons (now cleared on modal open, top while modal);
  toasts centred over the canvas; 4096 @100 % slider drags froze (preview/full alternation) → per-scale full-cost estimate +
  refine postponed while a button is held; history 1 GB → 512 MB + alpha-only mask diffs (¼); tiny images fit up to 800 %;
  undo ignored mid-stroke; brush size slider power curve 2..800; shadow/stroke defaults & ranges scale with image size.
- NEXT: re-run QA drivers on the fixes, screenshots at 1280/1920, update FRONTEND-API.md.
- 12:55 DONE (cont.): worker prewarm (core/mask-worker.js + render.prewarm) → full-quality refine / export on 4096 px
  no longer blocks the page (main-thread max block after slider release ≤ 70 ms, was 1.1–1.7 s); adaptive preview
  scale; render cache 900 → 600 MB; PNG-alpha docs get fg with the PNG's own soft-edge colours (white halo fixed),
  去色边 hidden for non-AI masks. FRONTEND-API.md updated. tests.html 128/128.
- NEXT: final screenshot pass 1280/1920 + dsf2, re-run QA1/2/4/5 on the fixed code.
- 13:20 FINAL: re-ran QA1–QA9 on the fixed code (1280×720, 1920×1080, dsf 2): 0 console errors, undo/redo pixel-exact,
  输出 test files deleted. Extra hardening: lostpointercapture ends a stroke at the last pointer position;
  missed button releases can't block the HQ refine. tests.html 128/128.
