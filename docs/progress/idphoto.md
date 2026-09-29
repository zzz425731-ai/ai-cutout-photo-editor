# idphoto progress

## 2026-09-26 session 1
- Started: read FRONTEND-API.md, ARCHITECTURE.md, cutout/background, actions/api, cdp.mjs.

## 2026-09-26 session 2 (resumed after usage limit)
- Design: doc.idphoto record keeps refs to pre-idphoto planes (orig) + face info + preset/colour/zoom/dx/dy;
  frame = pure computeFrame(); generation via runCutout({mode:'portrait', then}) → one undo step.
- Next: write idphoto.js/css/tests, then cdp tests on 3 portrait samples.
- 21:44 panel+css+tests written; 3 samples generate OK (framing looks right). Soft edge bands added. Next: UI driver for sliders/undo/colours/save-limit/print.
- 22:00 DONE: all features built + verified via cdp (3 portrait samples, corgi no-face, football too-small/multi-face,
  sliders/undo/redo/colours/sizes/custom/stale-confirm/save ≤20KB (19.5 KB, 300 dpi)/print 6寸+5寸). tests.html 182/182 pass.
  Test output files removed from 输出.
