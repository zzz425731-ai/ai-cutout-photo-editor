"""Run existing backend suites with isolated output and no cleanup of old results."""
import datetime
import json
import os
from pathlib import Path
import socket
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
os.environ["OPENBLAS_NUM_THREADS"] = "4"
os.environ["KT_TEST_PORT"] = "7884"
os.environ["PYTHONIOENCODING"] = "utf-8"
for stream in (sys.stdout, sys.stderr):
    stream.reconfigure(encoding="utf-8", errors="replace")

from engine import models_present
assert all(models_present().values()), "All models must already exist; this audit must not download any."

out_base = (ROOT / "tests" / "out").resolve()
run_dir = out_base / ("fullcheck_backend_20260929_" + datetime.datetime.now().strftime("%H%M%S"))
assert run_dir.parent == out_base and not run_dir.exists()
run_dir.mkdir()
save_dir = run_dir / "server_save"
assert save_dir.resolve().is_relative_to(out_base) and not save_dir.exists()

with socket.socket() as probe:
    if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    probe.bind(("127.0.0.1", 7884))

import test_server
import test_engine

test_server.OUT = str(run_dir)
test_server.SAVE_DIR = str(save_dir)
test_server.LOG = str(run_dir / "server_process.log")
test_engine.OUT = str(run_dir / "engine")
Path(test_engine.OUT).mkdir()


class Tee:
    def __init__(self, stream, file):
        self.stream, self.file = stream, file

    def write(self, text):
        self.stream.write(text)
        self.file.write(text)
        self.file.flush()

    def flush(self):
        self.stream.flush()
        self.file.flush()


results = {"output": str(run_dir), "models_present": models_present()}
print("ISOLATED_OUTPUT=" + str(run_dir), flush=True)
with open(run_dir / "suite.log", "w", encoding="utf-8") as log:
    old_out, old_err = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = Tee(old_out, log), Tee(old_err, log)
    try:
        started = time.perf_counter()
        results["server_exit"] = test_server.main([])
        results["server_seconds"] = round(time.perf_counter() - started, 2)
        started = time.perf_counter()
        results["engine_exit"] = test_engine.main([
            "decode", "dpi", "data_url", "faces", "inpaint", "retouch", "runtime"
        ])
        results["engine_seconds"] = round(time.perf_counter() - started, 2)
    finally:
        test_server.stop_server()
        sys.stdout, sys.stderr = old_out, old_err
        (run_dir / "summary.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(results, ensure_ascii=False, indent=2))
sys.exit(max(results.get("server_exit", 1), results.get("engine_exit", 1)))
