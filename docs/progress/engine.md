# Track "engine" progress — DONE (2026-09-26, orchestrator)
- BiRefNet runs as mixed-precision fp16 on DirectML (models/birefnet_lite_fp16.onnx, made by engine/tofp16.py + engine/onnxmini.py from the fp32 file; generated automatically if missing). VRAM ~5 GB, process WS ~0.5 GB, inference 0.3 s.
- refine_colorline / estimate_foreground: large-window stats on downscaled images + per-pixel formulas only on edge pixels (remap sampling). 12 MP: general 1.3 s, portrait 2.0 s, + 0.3 s encoding; process peak ~0.7 GB. Quality vs previous outputs: alpha mean diff <= 0.0012, visually identical.
- /api/matte now returns fg as a 去色边 PATCH (RGBA, fg_rect=[x,y,w,h]); front-end api.js/actions.js updated.
- runtime: global DirectML lock (concurrent session creation + inference crashed with access violation); CPU sessions limited to 8 threads.
- LaMa fails on DirectML (MatMul E_INVALIDARG in FFC) -> stays on CPU; loaded lazily on first use.
- tests/test_engine.py 16/16 green.
