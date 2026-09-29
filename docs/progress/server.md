# Track "server" progress — DONE (2026-09-26, orchestrator)
- Previous hardening edits verified: tests/test_server.py 17/17 green (security, bad inputs, concurrency, save, formats).
- Heavy endpoints serialized (BoundedSemaphore(1)); process runs at BELOW_NORMAL priority; only general+portrait preloaded.
- Not done: tests/test_adversarial_backend.py (optional extra), desktop shortcut helper.
