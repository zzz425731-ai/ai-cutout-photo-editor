"""Model downloader regression tests using tiny fixtures over local HTTP only."""
import contextlib
import io
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from engine import download_models

PAYLOAD = b"local-test-weights\x00\x01\xfe\xff" * 512


class ModelHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_HEAD(self):
        self.server.seen.append(("HEAD", self.path, self.headers.get("Range")))
        if self.path.startswith("/missing"):
            self.send_error(404)
            return
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/model")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Length", str(len(PAYLOAD)))
        self.end_headers()

    def do_GET(self):
        requested_range = self.headers.get("Range")
        self.server.seen.append(("GET", self.path, requested_range))
        if self.path.startswith("/missing"):
            self.send_error(404)
            return
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/model")
            self.end_headers()
            return
        start = int(requested_range.removeprefix("bytes=").removesuffix("-")) if requested_range and self.path != "/ignore-range" else 0
        body = PAYLOAD[start:]
        self.send_response(206 if start else 200)
        self.send_header("Content-Length", str(len(body)))
        if start:
            self.send_header("Content-Range", f"bytes {start}-{len(PAYLOAD)-1}/{len(PAYLOAD)}")
        self.end_headers()
        self.wfile.write(body[:100] if self.path == "/truncated" else body)


class ModelDownloadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), ModelHandler)
        cls.httpd.seen = []
        cls.worker = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.worker.start()
        cls.base = "http://127.0.0.1:" + str(cls.httpd.server_address[1])

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.worker.join(timeout=3)

    def setUp(self):
        # Explicitly resolve and confine the only directory cleaned by these tests.
        self.output = (ROOT / "tests" / "out" / "github-upload").resolve()
        self.output.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="download-test-", dir=self.output)
        self.folder = Path(self.temp.name).resolve()
        assert self.folder.parent == self.output
        self.addCleanup(self.temp.cleanup)
        self.dest = self.folder / "fixture.onnx"
        self.partial = self.folder / "fixture.onnx.part"
        self.httpd.seen.clear()
        # Local HTTP must bypass any configured corporate/system proxy.
        self.proxy = patch.dict(os.environ, {"NO_PROXY": "127.0.0.1,localhost"})
        self.proxy.start()
        self.addCleanup(self.proxy.stop)

    def download(self, path="/model"):
        with contextlib.redirect_stdout(io.StringIO()):
            download_models._download(self.base + path, str(self.dest), "测试模型")

    def test_download_and_atomic_completion(self):
        self.download()
        self.assertEqual(self.dest.read_bytes(), PAYLOAD)
        self.assertFalse(self.partial.exists())

    def test_completed_file_skips_get(self):
        self.dest.write_bytes(PAYLOAD)
        self.download()
        self.assertEqual([method for method, _, _ in self.httpd.seen], ["HEAD"])

    def test_partial_file_resumes(self):
        self.partial.write_bytes(PAYLOAD[:173])
        self.download()
        self.assertEqual(self.dest.read_bytes(), PAYLOAD)
        self.assertIn(("GET", "/model", "bytes=173-"), self.httpd.seen)
        self.assertFalse(self.partial.exists())

    def test_range_unsupported_restarts_file(self):
        self.partial.write_bytes(PAYLOAD[:173])
        self.download("/ignore-range")
        self.assertEqual(self.dest.read_bytes(), PAYLOAD)

    def test_redirect_is_followed(self):
        self.download("/redirect")
        self.assertEqual(self.dest.read_bytes(), PAYLOAD)

    def test_truncated_response_keeps_partial_and_existing_file(self):
        self.dest.write_bytes(b"previous-model")
        with self.assertRaisesRegex(OSError, "下载不完整"):
            self.download("/truncated")
        self.assertEqual(self.dest.read_bytes(), b"previous-model")
        self.assertTrue(self.partial.exists())
        self.assertLess(self.partial.stat().st_size, len(PAYLOAD))

    def test_failed_host_falls_back(self):
        with patch.object(download_models, "MODEL_DIR", str(self.folder)), \
             patch.object(download_models, "MODELS", [("fixture.onnx", "model", "测试模型")]), \
             patch.object(download_models, "HOSTS", [self.base + "/missing-host", self.base]), \
             contextlib.redirect_stdout(io.StringIO()):
            download_models.main()
        self.assertEqual(self.dest.read_bytes(), PAYLOAD)


if __name__ == "__main__":
    unittest.main()
