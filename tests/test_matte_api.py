"""抠图传输回归：python -m unittest discover -s tests -p test_matte_api.py -v

使用临时本机端口、真实 PNG 编解码和可控的引擎返回值，不启动/下载 AI 模型，
也不触碰正在运行的编辑器或「输出」文件夹。
"""
import base64
import http.client
import io
import json
import os
import sys
import threading
import unittest
from unittest.mock import patch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import server
import numpy as np
from PIL import Image
from engine import imageio, matting


class MatteApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = server.Server(("127.0.0.1", 0), server.Handler)
        cls.worker = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.worker.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.worker.join(timeout=3)

    def setUp(self):
        self.models = patch("engine.models_present", return_value={"general": True, "portrait": True})
        self.have_models = self.models.start()
        self.addCleanup(self.models.stop)
        # 单像素高频纹理与渐变：JPEG 重编码、降采样会损坏这个输入。
        yy, xx = np.indices((37, 53))
        self.rgb = np.stack([(xx * 61 + yy * 37) % 256,
                             ((xx + yy) % 2) * 255,
                             (xx * 7 + yy * 11) % 256], axis=-1).astype(np.uint8)
        self.png = imageio.encode_png(self.rgb)
        self.alpha = ((xx * 5 + yy * 3) % 256).astype(np.uint8)

    def post(self, body, query=""):
        if isinstance(body, dict):
            body = json.dumps(body).encode("utf-8")
        conn = http.client.HTTPConnection("127.0.0.1", self.httpd.server_address[1], timeout=5)
        try:
            conn.request("POST", "/api/matte" + query, body,
                         {"X-KT": "1", "Content-Type": "image/png"})
            reply = conn.getresponse()
            return reply.status, json.loads(reply.read().decode("utf-8"))
        finally:
            conn.close()

    @staticmethod
    def png_array(url):
        raw = base64.b64decode(url.split(",", 1)[1])
        with Image.open(io.BytesIO(raw)) as im:
            return np.asarray(im).copy()

    def test_lossless_input_and_edge_patch_roundtrip(self):
        rgba = np.zeros((3, 4, 4), np.uint8)
        rgba[1, 2] = [12, 48, 113, 255]
        edge_patch = {"x": 7, "y": 5, "rgba": rgba}
        with patch.object(matting, "matte", return_value=(self.alpha, edge_patch)) as infer:
            status, result = self.post(self.png)
        self.assertEqual(status, 200)
        np.testing.assert_array_equal(infer.call_args.args[0], self.rgb)
        np.testing.assert_array_equal(self.png_array(result["mask"]), self.alpha)
        np.testing.assert_array_equal(self.png_array(result["fg"]), rgba)
        self.assertEqual(result["fg_rect"], [7, 5, 4, 3])
        self.assertEqual((result["width"], result["height"]), (53, 37))
        self.assertEqual(result["mode"], "general")
        self.assertIsNone(result["warning"])
        self.assertTrue(infer.call_args.kwargs["decontam"])

    def test_png_data_url_and_json_keep_source_pixels(self):
        url = imageio.to_data_url(self.png)
        for body in (url.encode("ascii"), {"image": url}):
            with self.subTest(body_type=type(body).__name__):
                with patch.object(matting, "matte", return_value=(self.alpha, None)) as infer:
                    status, result = self.post(body, "?mode=portrait&decontam=0")
                self.assertEqual(status, 200)
                np.testing.assert_array_equal(infer.call_args.args[0], self.rgb)
                self.assertEqual(infer.call_args.kwargs, {"mode": "portrait", "decontam": False})
                self.assertIsNone(result["fg"])
                self.assertIsNone(result["fg_rect"])
                self.assertEqual(result["mode"], "portrait")

    def test_missing_portrait_model_reports_general_fallback(self):
        self.have_models.return_value = {"general": True, "portrait": False}
        with patch.object(matting, "matte", return_value=(self.alpha, None)) as infer:
            status, result = self.post(self.png, "?mode=portrait")
        self.assertEqual(status, 200)
        self.assertEqual(infer.call_args.kwargs["mode"], "general")
        self.assertEqual(result["mode"], "general")
        self.assertIn("已使用通用抠图", result["warning"])

    def test_missing_general_model_is_actionable_error(self):
        self.have_models.return_value = {"general": False, "portrait": True}
        with patch.object(matting, "matte") as infer:
            status, result = self.post(self.png)
        self.assertEqual(status, 503)
        self.assertIn("模型文件缺失", result["error"])
        infer.assert_not_called()

    def test_invalid_settings_do_not_run_model(self):
        for query in ("?mode=unknown", "?decontam=maybe"):
            with self.subTest(query=query), patch.object(matting, "matte") as infer:
                status, result = self.post(self.png, query)
                self.assertEqual(status, 400)
                self.assertIn("只能", result["error"])
                infer.assert_not_called()

    def test_damaged_image_does_not_run_model(self):
        with patch.object(matting, "matte") as infer:
            status, result = self.post(b"not an image")
        self.assertEqual(status, 400)
        self.assertIn("图片", result["error"])
        infer.assert_not_called()

    def test_exif_orientation_matches_editor(self):
        exif = Image.Exif()
        exif[0x0112] = 6
        buf = io.BytesIO()
        Image.fromarray(self.rgb).save(buf, "PNG", exif=exif)

        def infer(rgb, **kwargs):
            return np.full(rgb.shape[:2], 127, np.uint8), None

        with patch.object(matting, "matte", side_effect=infer) as model:
            status, result = self.post(buf.getvalue())
        self.assertEqual(status, 200)
        self.assertEqual((result["width"], result["height"]), (37, 53))
        np.testing.assert_array_equal(model.call_args.args[0], np.rot90(self.rgb, k=3))
        self.assertEqual(self.png_array(result["mask"]).shape, (53, 37))


if __name__ == "__main__":
    unittest.main()
