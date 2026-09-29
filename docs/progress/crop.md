# crop progress

## 2026-09-26 session 1
- Started: reading FRONTEND-API.md, ARCHITECTURE.md, cutout/background, io/store/viewport/tools.

## 2026-09-26 session 2 (resumed after usage limit; session 1 only read docs)
- Read docs + core (io/viewport/tools/ui/panels/render-layers). Plan: tools/crop-tool.js holds pending
  state (orientation matrix M, straighten θ, crop rect in straightened-frame px, ratio, resize) + pure
  geometry helpers (exported for tests) + overlay that draws viewport.preview transformed; panels/crop.js UI;
  apply = one store.commit with io.mapPlanes + layer transform.
- ~13:40 DONE: tools/crop-tool.js (state, geometry, overlay preview, drag/handles/keys, apply), panels/crop.js,
  css/panels/crop.css, tests/panels/crop.test.js (17 tests; tests.html 145/145 green). First screenshots OK.
- NEXT: full cdp UI run (drag handles/new box/move, keys, resize inputs, custom ratio, undo/redo pixel check,
  1280×720 + 1920×1080 screenshots), polish.
- ~14:10 DONE: exact border constrain, rotated-fit preview zoom, dbl-click apply, success toast, UI drivers
  ui2 (drag/move/new box/keys/ratios/custom/turn/flip/straighten/resize/apply/undo/redo/leave panel),
  ui3 (transparent PNG + layers, empty state, tiny image), ui4 (cursors, slider drag, rotated constraints) all OK.
  NOTE: 8-MP sample flakily loses GPU canvas contents in headless Chrome (low RAM, ~1.8 GB free) — environment.
- NEXT: final regression + screenshots review, final answer.
- ~14:35 DONE (task complete): drag inside an untouched full box draws a new box; Enter on 取消/应用 keeps
  native behaviour; sticky bar pinned to panel bottom; straighten number box widened. tests.html 145/145,
  ui2/ui3/ui4/ui5 drivers ALL OK, 0 console errors. No core files changed.
