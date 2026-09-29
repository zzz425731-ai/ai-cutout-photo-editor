"""对比备份算法和当前算法，输出 JSON 指标及同一推理结果的前后对照图。

python tests/evaluate_matting_quality.py              # 已有模型原始 alpha，无需推理
python tests/evaluate_matting_quality.py --infer      # 重新运行实际模型；缓存复用原始 alpha
真实照片没有人工真值，差异指标仅用来定位人工检查，不能当作质量得分。
"""
import argparse
import importlib.util
import json
from pathlib import Path
import sys
import time

import cv2
import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from engine import matting
from test_matting_quality import synthetic_edge, foreground_metrics

OUT = ROOT / 'tests' / 'out' / 'quality_20260929'
OUT.mkdir(parents=True, exist_ok=True)
spec = importlib.util.spec_from_file_location('engine._baseline_matting', ROOT / '_backup_20260929' / 'engine' / 'matting.py')
baseline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(baseline)


def fg_for(module, rgb, alpha):
    fg = rgb.copy()
    result = module.estimate_foreground(rgb, alpha)
    if result is not None:
        ys, xs, colors = result
        fg[ys, xs] = np.rint(colors * 255).astype(np.uint8)
    return fg


def composite(fg, alpha, color):
    return np.clip(fg.astype(np.float32) * alpha[..., None] +
                   np.array(color) * (1 - alpha[..., None]), 0, 255).astype(np.uint8)


def compare_image(name, rgb, old_a, new_a, old_fg, new_fg):
    h, w = old_a.shape
    panels = []
    # 统一对同一处发丝/边缘放大。真实照片没有 alpha GT，不声称差异就是改善。
    delta = np.abs(old_a - new_a) + (np.abs(old_fg.astype(float) - new_fg).mean(-1) / 255) * new_a
    score = cv2.blur(delta.astype(np.float32), (81, 81))
    cy, cx = np.unravel_index(score.argmax(), score.shape)
    crop_size = min(h, w, 360)
    y0 = int(np.clip(cy - crop_size // 2, 0, h - crop_size))
    x0 = int(np.clip(cx - crop_size // 2, 0, w - crop_size))
    crop = (slice(y0, y0 + crop_size), slice(x0, x0 + crop_size))
    for color, title in (((25, 28, 34), 'DARK'), ((245, 245, 245), 'LIGHT')):
        old = composite(old_fg, old_a, color)
        new = composite(new_fg, new_a, color)
        small_old = cv2.resize(old, (int(w * 480 / h), 480), interpolation=cv2.INTER_AREA)
        small_new = cv2.resize(new, (int(w * 480 / h), 480), interpolation=cv2.INTER_AREA)
        close_old = cv2.resize(old[crop], (480, 480), interpolation=cv2.INTER_NEAREST)
        close_new = cv2.resize(new[crop], (480, 480), interpolation=cv2.INTER_NEAREST)
        row = Image.fromarray(np.concatenate([small_old, small_new, close_old, close_new], axis=1))
        labeled = Image.new('RGB', (row.width, row.height + 28), 'white')
        labeled.paste(row, (0, 28))
        draw = ImageDraw.Draw(labeled)
        for pos, label in ((0, f'{title} BEFORE'), (small_old.shape[1], 'AFTER'),
                           (2 * small_old.shape[1], 'BEFORE detail'),
                           (2 * small_old.shape[1] + 480, 'AFTER detail')):
            draw.text((pos + 5, 6), label, fill='black')
        panels.append(np.asarray(labeled))
    Image.fromarray(np.concatenate(panels, axis=0)).save(OUT / f'{name}_comparison.jpg', quality=94)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--infer', action='store_true')
    parser.add_argument('--names', nargs='*')
    args = parser.parse_args()
    report = {'synthetic': [], 'photos': [], 'photo_note': 'No manual ground truth; differences are inspection aids, not quality scores.'}
    truth = np.zeros((256, 256), np.float32)
    truth[50:210, 80:200] = 1
    truth[120:122, 130:132] = 0
    truth[100, 69:80] = 0.2
    truth[100, 60:69] = 0.7
    truth[150:178, 77] = 0.65
    truth[20:23, 20:23] = 0.98
    noisy = truth.copy()
    noisy[30:33, 30:33] = 0.6
    noisy[120:123, 160:163] = 0.3
    old_clean, new_clean = baseline.clean(noisy), matting.clean(noisy)
    region = (np.abs(old_clean - truth) > 1e-5) | (np.abs(new_clean - truth) > 1e-5) | (noisy != truth)
    report['synthetic_cleanup'] = {
        'before_alpha_mae_affected': float(np.abs(old_clean - truth)[region].mean()),
        'after_alpha_mae_affected': float(np.abs(new_clean - truth)[region].mean()),
        'affected_pixels': int(region.sum())}
    for fg, bg in (((35, 24, 18), (245, 240, 230)), ((80, 38, 24), (230, 120, 180)),
                   ((48, 50, 60), (20, 210, 100)), ((225, 210, 160), (30, 45, 65))):
        rgb, alpha, truth = synthetic_edge(fg, bg)
        before = foreground_metrics(baseline, rgb, alpha, truth)
        after = foreground_metrics(matting, rgb, alpha, truth)
        report['synthetic'].append({'fg': fg, 'bg': bg, 'before_composite_mae_255': before,
                                    'after_composite_mae_255': after, 'improvement_pct': (1 - after / before) * 100})
    report['synthetic_textured_backgrounds'] = []
    for kind in ('checker', 'noise'):
        _, alpha, truth = synthetic_edge()
        yy, xx = np.indices(alpha.shape)
        if kind == 'checker':
            bg = np.where(((xx // 2 + yy // 2) % 2)[..., None], np.array([0.8, 0.2, 0.6]), np.array([0.2, 0.8, 0.2]))
        else:
            bg = np.random.default_rng(3).uniform(0.4, 1, (*alpha.shape, 3))
        rgb = np.rint((truth * alpha[..., None] + bg * (1 - alpha[..., None])) * 255).astype(np.uint8)
        report['synthetic_textured_backgrounds'].append({'kind': kind,
            'before_composite_mae_255': foreground_metrics(baseline, rgb, alpha, truth),
            'after_composite_mae_255': foreground_metrics(matting, rgb, alpha, truth)})
    names = args.names or [p.name for p in sorted((ROOT / 'tests' / 'samples').iterdir()) if p.suffix in ('.jpg', '.png')]
    for name in names:
        rgb = np.asarray(Image.open(ROOT / 'tests' / 'samples' / name).convert('RGB'))
        h, w = rgb.shape[:2]
        portrait = any(part in name for part in ('woman', 'man-', 'football', 'vitmatte'))
        mode = 'portrait' if portrait else 'general'
        stem = Path(name).stem + '_' + mode
        cache = OUT / f'{stem}_raw.npy'
        start = time.perf_counter()
        if cache.exists():
            raw = np.load(cache)
        elif args.infer:
            raw = (matting.alpha_portrait if portrait else matting.alpha_general)(rgb, refine=False)
            np.save(cache, raw)
        else:
            raw_path = ROOT / 'tests' / 'out' / 'matting' / f'{stem}_mask_raw.png'
            raw = np.asarray(Image.open(raw_path)).astype(np.float32) / 255
        scale = max(1, max(h, w) / matting.BIREF_SIZE)
        old_clean = baseline.clean(raw)
        new_clean = matting.clean(raw)
        old_a = baseline.refine_colorline(rgb, old_clean, scale)
        new_a = matting.refine_colorline(rgb, new_clean, scale)
        old_fg = fg_for(baseline, rgb, old_a)
        new_fg = fg_for(matting, rgb, new_a)
        assert np.isfinite(new_a).all() and new_a.min() >= 0 and new_a.max() <= 1
        row = {'name': name, 'mode': mode, 'shape': [h, w], 'seconds': round(time.perf_counter() - start, 2),
               'alpha_abs_change_mean_255': float(np.abs(old_a - new_a).mean() * 255),
               'retained_detail_pixels': int(((new_clean > old_clean + 0.05) & (raw > 0.05)).sum()),
               'preserved_hole_pixels': int(((new_clean + 0.05 < old_clean) & (raw < 0.5)).sum()),
               'foreground_change_mean_255': float((np.abs(old_fg.astype(float) - new_fg) * new_a[..., None]).mean())}
        report['photos'].append(row)
        compare_image(stem, rgb, old_a, new_a, old_fg, new_fg)
        Image.fromarray(np.rint(new_a * 255).astype(np.uint8)).save(OUT / f'{stem}_alpha.png')
        print(json.dumps(row, ensure_ascii=True), flush=True)
    (OUT / 'metrics.json').write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding='utf-8')
    print(json.dumps(report['synthetic'], indent=2), flush=True)


if __name__ == '__main__':
    main()
