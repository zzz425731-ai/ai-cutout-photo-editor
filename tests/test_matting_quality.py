"""无需模型的抠图质量回归：python tests/test_matting_quality.py。

合成用例有已知 alpha / 前景真值，不把“改动更多”当成“质量更好”。
"""
from pathlib import Path
import sys
import unittest

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from engine import matting


def synthetic_edge(foreground=(35, 24, 18), background=(245, 240, 230)):
    alpha = np.zeros((128, 192), np.float32)
    cv2.ellipse(alpha, (96, 92), (44, 72), 0, 0, 360, 1, -1)
    alpha = cv2.GaussianBlur(alpha, (0, 0), 2)
    fg = np.broadcast_to(np.array(foreground, np.float32) / 255, (*alpha.shape, 3))
    bg = np.array(background, np.float32) / 255
    rgb = np.rint((fg * alpha[..., None] + bg * (1 - alpha[..., None])) * 255).astype(np.uint8)
    return rgb, alpha, fg


def foreground_metrics(module, rgb, alpha, truth):
    ys, xs, colors = module.estimate_foreground(rgb, alpha)
    weight = alpha[ys, xs, None]
    # 合成到任意新背景时，颜色误差以 alpha 加权；范围以 8 位色值表示。
    return float((np.abs(colors - truth[ys, xs]) * weight).mean() * 255)


class MattingQualityTests(unittest.TestCase):
    def base_alpha(self):
        a = np.zeros((256, 256), np.float32)
        a[50:210, 80:200] = 1
        return a

    def test_confident_small_hole_is_background(self):
        a = self.base_alpha()
        a[120:122, 130:132] = 0
        result = matting.clean(a)
        self.assertEqual(float(result[120:122, 130:132].max()), 0)
        self.assertTrue(np.array_equal(a, result))

    def test_weak_enclosed_model_artifact_is_filled(self):
        a = self.base_alpha()
        a[120:123, 130:133] = 0.3
        self.assertEqual(float(matting.clean(a)[120:123, 130:133].min()), 1)

    def test_soft_bridge_keeps_strand(self):
        a = self.base_alpha()
        a[100, 69:80] = 0.2
        a[100, 60:69] = 0.7
        self.assertTrue(np.array_equal(matting.clean(a), a))

    def test_nearby_separate_thin_strand_is_preserved(self):
        a = self.base_alpha()
        a[80:108, 77] = 0.65
        self.assertTrue(np.array_equal(matting.clean(a), a))

    def test_distant_uncertain_line_is_removed(self):
        a = self.base_alpha()
        a[80:108, 20] = 0.65
        self.assertEqual(float(matting.clean(a)[80:108, 20].max()), 0)

    def test_small_confident_foreground_is_preserved(self):
        a = self.base_alpha()
        a[20:23, 20:23] = 0.98
        self.assertTrue(np.array_equal(matting.clean(a), a))

    def test_isolated_uncertain_speck_is_removed(self):
        a = self.base_alpha()
        a[20:23, 20:23] = 0.6
        result = matting.clean(a)
        self.assertEqual(float(result[20:23, 20:23].max()), 0)
        self.assertEqual(float(result[50:210, 80:200].min()), 1)

    def test_empty_full_tiny_and_input_immutability(self):
        for shape in ((1, 1), (1, 50), (50, 1), (16, 16)):
            for value in (0, 0.4, 1):
                a = np.full(shape, value, np.float32)
                before = a.copy()
                result = matting.clean(a)
                self.assertTrue(np.array_equal(a, before))
                self.assertTrue(np.isfinite(result).all())
                self.assertTrue(np.array_equal(a, result))

    def test_color_decontamination_against_known_foreground(self):
        for fg, bg in (((35, 24, 18), (245, 240, 230)),
                       ((80, 38, 24), (230, 120, 180)),
                       ((48, 50, 60), (20, 210, 100)),
                       ((225, 210, 160), (30, 45, 65))):
            with self.subTest(fg=fg, bg=bg):
                rgb, alpha, truth = synthetic_edge(fg, bg)
                error = foreground_metrics(matting, rgb, alpha, truth)
                # 平滑背景、已知精确 alpha 时，去色后的合成误差应小于 1.5/255。
                self.assertLess(error, 1.5)

    def test_color_patch_keeps_opaque_and_transparent_pixels(self):
        rgb, alpha, _ = synthetic_edge()
        a8 = np.rint(alpha * 255).astype(np.uint8)
        patch = matting.fg_patch(rgb, a8)
        self.assertIsNotNone(patch)
        rgba = patch['rgba']
        actual = a8[patch['y']:patch['y'] + rgba.shape[0], patch['x']:patch['x'] + rgba.shape[1]]
        selected = rgba[..., 3] > 0
        self.assertTrue(np.all((actual[selected] > 2) & (actual[selected] < 253)))
        self.assertIsNone(matting.fg_patch(rgb, np.zeros(a8.shape, np.uint8)))
        self.assertIsNone(matting.fg_patch(rgb, np.full(a8.shape, 255, np.uint8)))

    def test_textured_background_does_not_trigger_aggressive_unmixing(self):
        _, alpha, truth = synthetic_edge()
        yy, xx = np.indices(alpha.shape)
        checker = ((xx // 2 + yy // 2) % 2)[..., None]
        bg = np.where(checker, np.array([0.8, 0.2, 0.6]), np.array([0.2, 0.8, 0.2]))
        rgb = np.rint((truth * alpha[..., None] + bg * (1 - alpha[..., None])) * 255).astype(np.uint8)
        error = foreground_metrics(matting, rgb, alpha, truth)
        self.assertLess(error, 6.5)


if __name__ == '__main__':
    unittest.main(verbosity=2)
