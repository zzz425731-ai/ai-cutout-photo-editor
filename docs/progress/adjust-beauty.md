# adjust-beauty progress

## 2026-09-26 session 1
- Started: previous run left no notes and my files were still stubs. Read FRONTEND-API, core adjust/render/store/actions/ui, retouch engine.
- Plan: adjust panel (filters w/ thumbs, 一键优化, 3 slider groups, reset) → beauty panel (smooth/whiten via /api/retouch, base-source state per result canvas) → tests → cdp UI drive + screenshots.
- DONE (adjust): panel built (一键优化 / 12 filter tiles with live thumbnails / strength / 3 collapsible slider groups with per-group reset / 全部重置), FILTERS += portrait 人像, food 美食 (data only), vivid toned down.
  cdp drive a2.mjs: all features + undo/redo OK, 0 console errors. 12 MP drag: panel sync 0.14 ms/commit; renders are core/SwiftShader-bound.
- NEXT: beauty panel (retouch via server, base-source state per result canvas), then unit tests for both.
- 进度 (beauty): panel built — sliders → /api/retouch from the pre-beauty base (state per result canvas in a WeakMap),
  one commit per release (source+fg), 0/0 = exact original (verified by pixel hash), undo/redo sync, quick low-res
  preview overlay while holding / before the full result on >1.6 MP photos, 按住对比 overlay, inline status, face hint.
  NOTE: machine commit memory is nearly exhausted (steam.exe leak, ~1 GB commit free) → server returns 503 for
  bigger retouch jobs at times; errors are shown gracefully. Test with small photos.
- NEXT: unit tests (adjust auto/filters, beauty merge + fetch-mocked commit flow), 1920 screenshots, cutout+仅人物区域.

## 2026-09-26 session 2 (resumed after usage limit)
- Resumed. Tests files exist (adjust.test.js, beauty.test.js). Running tests.html, then 1920 screenshots + cutout 仅人物区域 check.
- 一键优化 cast: added near-white 2nd cue (must agree, min amount), magenta guard for warm fix, softer tint. Tungsten test now indoor room; added "conflicting cues" test. autosheet OK. 168/168.
- NEXT: beauty 仅人物区域 + 1280/1920 screenshots of both panels.
- FIXED: beauty status/face line used class "busy" which collides with the global .busy overlay (fixed, full-screen, opacity 0) → the inline progress was invisible. Renamed to "working". Toasts suppressed while panel open (inline status shows errors).
- 仅人物区域 verified (b5.mjs): mask → background 0 % changed, undo/redo toggle state OK, 1280+1920.
- DONE session 2: tests 168/168, a2 (adjust, 1920) ALL OK, b3/b5 (beauty, person-only, 1280/1920) ALL OK, b7 empty states + no-face OK, 0 console errors. Filter sheets re-checked (portrait/corgi/afro).
