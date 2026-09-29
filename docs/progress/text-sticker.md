# text-sticker progress

## 2026-09-26 session 1
- Read FRONTEND-API.md, ARCHITECTURE.md, cutout/background panels, core (tools/viewport/store/ui/render).
- Plan: render-layers.js (offscreen device-space compositing for shadow/opacity, vertical text, letter
  spacing, gradient fill, bg border, flipX), tools/layer-tool.js, panels/text.js + panels/text/*.js
  (shared layer list + font detection), panels/sticker.js, CSS, tests.
- NEXT: experiments in headless Chrome (fonts installed, letterSpacing measure, emoji rendering).
- ~12:45 DONE: render-layers.js rewritten (device-space compositing for shadow/opacity, vertical text,
  exact letter spacing, gradient fill, bg border, flipX, sy stretch, emoji glyph boxes); tools/layer-tool.js
  (select/move/snap/scale/rotate/keys/dblclick, one undo step per drag + keep-alive); panels/text.js,
  panels/text/{fonts,layer-list}.js, panels/sticker.js, CSS; unit tests (all mine pass).
  cdp drivers in scratch; screenshots checked (presets, editor, font picker, vertical, stickers, auto-cutout).
- NOTE: store.test 「内存上限」 currently fails — core agent is editing store.js right now (not my code).
- NEXT: regression run, 1280×720 polish, final screenshots.
- ~12:58 DONE: polish (9 花字 in 3×3, cascade placement, layer-list rebuild only on change, Ctrl+D in textarea,
  effect toggles restore visible defaults, drag keep-alive hardening). tests.html 127/127 green, 0 console errors.
  Final cdp runs (interact1/2/3, edge1, sweep, visual1/2) clean. Task complete.
