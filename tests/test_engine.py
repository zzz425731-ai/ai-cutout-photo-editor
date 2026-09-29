"""引擎测试（纯 assert，直接运行：python tests/test_engine.py [关键字...]）。

可视化结果写到 tests/out/engine/，可以直接打开看。
"""
import io
import os
import sys
import time
import traceback

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

import numpy as np
import cv2
from PIL import Image

from engine import imageio, matting, inpaint, face, retouch, runtime, models_present

SAMPLES = os.path.join(ROOT, "tests", "samples")
OUT = os.path.join(ROOT, "tests", "out", "engine")
os.makedirs(OUT, exist_ok=True)


def sample(name):
    with open(os.path.join(SAMPLES, name), "rb") as f:
        return f.read()


def rgb_of(name):
    return imageio.decode_rgb(sample(name))


def save(arr, name):
    Image.fromarray(arr).save(os.path.join(OUT, name))


def png_bytes(im, **kw):
    b = io.BytesIO()
    im.save(b, "PNG", **kw)
    return b.getvalue()


def apply_patch(rgb, patch):
    """去色边补丁 → 完整前景图（和前端 mergeFg 一样：补丁画在原图副本上）。"""
    fg = rgb.copy()
    if patch is not None:
        h, w = patch["rgba"].shape[:2]
        sub = fg[patch["y"]:patch["y"] + h, patch["x"]:patch["x"] + w]
        sel = patch["rgba"][..., 3] > 0
        sub[sel] = patch["rgba"][..., :3][sel]
    return fg


def comp(fg, a, color=(220, 30, 40)):
    af = a.astype(np.float32)[..., None] / 255
    return (fg.astype(np.float32) * af + np.array(color, np.float32) * (1 - af)).astype(np.uint8)


# ----------------------------------------------------------------------------
# imageio
# ----------------------------------------------------------------------------
def test_decode_modes():
    base = Image.open(os.path.join(SAMPLES, "corgi.jpg")).convert("RGB")
    W, H = base.size
    ref = np.asarray(base)
    # 灰度
    g = imageio.decode_rgb(png_bytes(base.convert("L")))
    assert g.shape == (H, W, 3) and g.dtype == np.uint8
    assert np.all(g[..., 0] == g[..., 1])
    # 16 位灰度：数值要按比例缩到 8 位，而不是被截断成全白
    a16 = (np.asarray(base.convert("L")).astype(np.uint16) * 257)
    im16 = Image.fromarray(a16)  # mode I;16
    d16 = imageio.decode_rgb(png_bytes(im16))
    assert abs(int(d16[..., 0].astype(int).mean()) - int(np.asarray(base.convert("L")).mean())) <= 1, "16 位灰度转换不对"
    # CMYK JPEG
    b = io.BytesIO()
    base.convert("CMYK").save(b, "JPEG", quality=95)
    c = imageio.decode_rgb(b.getvalue())
    assert c.shape == (H, W, 3)
    assert np.abs(c.astype(int) - ref.astype(int)).mean() < 12, "CMYK 解码偏色太大"
    # 带透明 PNG：rgb + alpha；decode_rgb 合成到白底
    rgba = base.convert("RGBA")
    arr = np.asarray(rgba).copy()
    arr[:, : W // 2, 3] = 0
    rb = png_bytes(Image.fromarray(arr))
    rgb, alpha = imageio.decode_rgba(rb)
    assert alpha is not None and alpha[:, : W // 2].max() == 0 and alpha[:, W // 2:].min() == 255
    white = imageio.decode_rgb(rb)
    assert white[:, : W // 2].min() == 255
    # 调色板 + 透明
    p = base.convert("P", palette=Image.ADAPTIVE, colors=64)
    p.info["transparency"] = 0
    rgb, alpha = imageio.decode_rgba(png_bytes(p, transparency=0))
    assert rgb.shape == (H, W, 3)
    # 1 位图
    one = imageio.decode_rgb(png_bytes(base.convert("1")))
    assert set(np.unique(one)) <= {0, 255}
    # WEBP
    b = io.BytesIO()
    base.save(b, "WEBP", quality=90)
    assert imageio.decode_rgb(b.getvalue()).shape == (H, W, 3)


def test_decode_exif_rotation():
    base = Image.open(os.path.join(SAMPLES, "corgi.jpg")).convert("RGB")
    W, H = base.size
    exif = Image.Exif()
    exif[0x0112] = 6  # 顺时针转 90°
    b = io.BytesIO()
    base.save(b, "JPEG", exif=exif.tobytes(), quality=92)
    rgb = imageio.decode_rgb(b.getvalue())
    assert rgb.shape == (W, H, 3), f"EXIF 方向没处理：{rgb.shape}"


def test_decode_bad_input():
    for bad in (b"", b"not an image", b"\x89PNG\r\n\x1a\n" + b"\0" * 40, sample("corgi.jpg")[:200]):
        try:
            imageio.decode_rgb(bad)
        except imageio.ImageError as e:
            assert any("一" <= ch <= "鿿" for ch in str(e)), "错误信息应为中文"
        else:
            raise AssertionError("坏图片应该报错")


def test_dpi_roundtrip():
    rgb = rgb_of("corgi.jpg")
    for fmt in ("PNG", "JPEG"):
        b = io.BytesIO()
        Image.fromarray(rgb).save(b, fmt)
        data = imageio.set_dpi(b.getvalue(), 300)
        im = Image.open(io.BytesIO(data))
        dpi = im.info.get("dpi")
        assert dpi and round(dpi[0]) == 300 and round(dpi[1]) == 300, f"{fmt} DPI = {dpi}"
        assert np.array_equal(np.asarray(im.convert("RGB")), np.asarray(Image.open(b).convert("RGB"))), "写 DPI 不能改像素"
        # 再写一次（替换已有的）
        data2 = imageio.set_dpi(data, 150)
        assert round(Image.open(io.BytesIO(data2)).info["dpi"][0]) == 150
    # 没有 JFIF 头的 JPEG（带 EXIF）
    b = io.BytesIO()
    exif = Image.Exif()
    exif[0x010F] = "test"
    Image.fromarray(rgb).save(b, "JPEG", exif=exif.tobytes())
    d = imageio.set_dpi(b.getvalue(), 300)
    assert round(Image.open(io.BytesIO(d)).info["dpi"][0]) == 300


def test_data_url():
    data = sample("butterfly.jpg")
    url = imageio.to_data_url(data, "image/jpeg")
    back, mime = imageio.parse_data_url(url)
    assert back == data and mime == "image/jpeg"


# ----------------------------------------------------------------------------
# 抠图
# ----------------------------------------------------------------------------
def _matte_all_samples():
    names = sorted(os.listdir(SAMPLES))
    res = {}
    for n in names:
        rgb = rgb_of(n)
        H, W = rgb.shape[:2]
        for mode in ("general", "portrait"):
            t = time.perf_counter()
            a, patch = matting.matte(rgb, mode=mode, decontam=True)
            ms = (time.perf_counter() - t) * 1000
            fg = apply_patch(rgb, patch)
            assert a.shape == (H, W) and a.dtype == np.uint8
            assert fg.shape == (H, W, 3) and fg.dtype == np.uint8
            # 去色边只改半透明像素；完全透明/完全不透明处保持原图
            sel = (a <= 2) | (a >= 253)
            assert np.array_equal(fg[sel], rgb[sel]), "fg 在非半透明处必须等于原图"
            base = os.path.splitext(n)[0]
            save(a, f"{base}_{mode}_mask.png")
            save(np.concatenate([comp(fg, a), comp(fg, a, (255, 255, 255))], 1), f"{base}_{mode}_comp.jpg")
            res[(n, mode)] = (a, ms)
            print(f"    {n:45s} {mode:8s} {ms:7.0f} ms  前景占比 {100 * (a > 127).mean():5.1f}%")
    return res


_MATTE = {}


def test_matting_samples():
    _MATTE.update(_matte_all_samples())
    # 人像：脸部中心必须是前景，四角是背景
    a, _ = _MATTE[("portrait-of-woman.jpg", "portrait")]
    H, W = a.shape
    assert a[int(H * 0.45), W // 2] > 240
    assert a[5, 5] < 10 and a[5, W - 6] < 10
    # 爆炸头：头发外圈要有半透明过渡（发丝），而不是一刀切
    a, _ = _MATTE[("woman-with-afro_medium.jpg", "portrait")]
    soft = ((a > 10) & (a < 245)).mean()
    assert soft > 0.005, f"发丝半透明区太少：{soft:.4f}"
    # 柯基：主体大致在右半中部
    a, _ = _MATTE[("corgi.jpg", "general")]
    assert a[int(a.shape[0] * 0.55), int(a.shape[1] * 0.6)] > 200


def test_portrait_mode_drops_car():
    a_g, _ = _MATTE.get(("young-man-standing-and-leaning-on-car.jpg", "general")) or (None, 0)
    a_p, _ = _MATTE.get(("young-man-standing-and-leaning-on-car.jpg", "portrait")) or (None, 0)
    if a_g is None:
        rgb = rgb_of("young-man-standing-and-leaning-on-car.jpg")
        a_g, _ = matting.matte(rgb, "general", decontam=False)
        a_p, _ = matting.matte(rgb, "portrait", decontam=False)
    H, W = a_p.shape
    car = (int(H * 0.62), int(W * 0.12))   # 车头引擎盖
    body = (int(H * 0.33), int(W * 0.6))   # 人的上身
    assert a_g[car] > 128, "通用模式应该把车一起抠出来（显著物体）"
    assert a_p[car] < 30, "人像模式不应包含车"
    assert a_p[body] > 200


def test_group_photo_keeps_everyone():
    """三个人并排的「合影」：两种模式都要保留所有人。"""
    names = ["portrait-of-woman.jpg", "woman-with-afro_medium.jpg", "young-man-standing-and-leaning-on-car.jpg"]
    tiles = []
    for n in names:
        im = Image.open(os.path.join(SAMPLES, n)).convert("RGB")
        im = im.resize((int(im.width * 900 / im.height), 900), Image.LANCZOS)
        tiles.append(np.asarray(im))
    group = np.concatenate(tiles, 1)
    xs = np.cumsum([0] + [t.shape[1] for t in tiles])
    for mode in ("general", "portrait"):
        a, patch = matting.matte(group, mode)
        fg = apply_patch(group, patch)
        save(np.concatenate([group, comp(fg, a)], 0), f"group_{mode}.jpg")
        for i in range(3):
            face_pt = a[int(900 * (0.42 if i < 2 else 0.18)), int((xs[i] + xs[i + 1]) / 2 + (0 if i < 2 else 30))]
            cover = (a[:, xs[i]:xs[i + 1]] > 127).mean()
            assert cover > 0.08 and face_pt > 128, f"{mode}: 第 {i + 1} 个人丢了（覆盖 {cover:.2f}, 脸 {face_pt}）"
    # 足球比赛：两名主力球员都在
    rgb = rgb_of("football-match.jpg")
    for mode in ("general", "portrait"):
        a, _ = matting.matte(rgb, mode, decontam=False)
        # 左边球员的躯干 (300, 200)、右边 30 号球员的躯干 (500, 250)（x, y）
        assert a[200, 300] > 128 and a[250, 500] > 128, f"{mode}: 球员丢了"


def test_matting_edge_cases():
    # 极小图
    tiny = np.zeros((16, 16, 3), np.uint8)
    tiny[4:12, 4:12] = 200
    for mode in ("general", "portrait"):
        a, patch = matting.matte(tiny, mode)
        assert a.shape == (16, 16) and apply_patch(tiny, patch).shape == (16, 16, 3)
    # 1 像素宽
    a, _ = matting.matte(np.full((1, 50, 3), 128, np.uint8), "general")
    assert a.shape == (1, 50)
    # 纯色图不应崩溃
    a, _ = matting.matte(np.full((300, 400, 3), 90, np.uint8), "portrait")
    assert a.shape == (300, 400)
    # decontam=0 → fg 为 None
    a, fg = matting.matte(rgb_of("butterfly.jpg"), "general", decontam=False)
    assert fg is None


def test_matting_huge():
    rgb = rgb_of("portrait-of-woman.jpg")
    big = cv2.resize(rgb, (4000, 6000), interpolation=cv2.INTER_LINEAR)  # 6000×4000（竖）
    t = time.perf_counter()
    a, fg = matting.matte(big, "portrait")
    ms = (time.perf_counter() - t) * 1000
    print(f"    6000×4000 人像抠图 {ms:.0f} ms")
    assert a.shape == big.shape[:2]
    assert a[2700, 2000] > 240 and a[20, 20] < 10


# ----------------------------------------------------------------------------
# 人脸
# ----------------------------------------------------------------------------
def test_faces():
    rgb = rgb_of("portrait-of-woman.jpg")
    fs = face.detect(rgb)
    assert len(fs) == 1, fs
    f = fs[0]
    H, W = rgb.shape[:2]
    assert 0.2 * W < f["x"] + f["w"] / 2 < 0.8 * W
    assert len(f["landmarks"]) == 5
    (rex, rey), (lex, ley) = f["landmarks"][0], f["landmarks"][1]
    assert rex < lex, "第一个关键点应是照片左侧的眼睛（人物右眼）"
    for x, y in f["landmarks"]:
        assert f["x"] - 5 <= x <= f["x"] + f["w"] + 5 and f["y"] - 5 <= y <= f["y"] + f["h"] + 5
    fs = face.detect(rgb_of("football-match.jpg"))
    assert len(fs) >= 3
    areas = [f["w"] * f["h"] for f in fs]
    assert areas == sorted(areas, reverse=True), "要按面积从大到小排序"
    assert face.detect(rgb_of("butterfly.jpg")) == []
    assert face.detect(np.zeros((8, 8, 3), np.uint8)) == []
    # 大图：坐标要映射回原图
    big = cv2.resize(rgb, (rgb.shape[1] * 2, rgb.shape[0] * 2))
    fb = face.detect(big)[0]
    assert abs(fb["x"] - 2 * f["x"]) < 0.05 * fb["w"] + 8, (fb, f)
    assert abs(fb["w"] - 2 * f["w"]) < 0.08 * fb["w"] + 8, (fb, f)


# ----------------------------------------------------------------------------
# 消除
# ----------------------------------------------------------------------------
def _ellipse_mask(shape, c, axes):
    m = np.zeros(shape[:2], np.uint8)
    cv2.ellipse(m, c, axes, 0, 0, 360, 255, -1)
    return m


def test_inpaint_lama_io():
    """实测 LaMa 的输入输出：RGB、0..1 输入、0..255 输出；把粉色背景里的一块涂掉后应还原成粉色。"""
    rgb = rgb_of("portrait-of-woman.jpg")
    H, W = rgb.shape[:2]
    m = _ellipse_mask(rgb.shape, (int(W * 0.12), int(H * 0.3)), (120, 160))  # 纯背景区域
    out, eng = inpaint.inpaint(rgb, m)
    assert eng == "lama"
    inside = m > 127
    ref = np.median(rgb[int(H * 0.2):int(H * 0.4), 20:int(W * 0.08)].reshape(-1, 3), 0)
    got = np.median(out[inside].reshape(-1, 3), 0)
    assert np.abs(got - ref).max() < 18, f"LaMa 颜色不对（通道顺序/数值范围）：{got} vs {ref}"
    # 远离蒙版的地方一个像素都不能变
    far = cv2.dilate(m, np.ones((61, 61), np.uint8)) == 0
    assert np.array_equal(out[far], rgb[far])


def test_inpaint_remove_person_and_sizes():
    rgb = rgb_of("young-man-standing-and-leaning-on-car.jpg")
    H, W = rgb.shape[:2]
    # 大蒙版：把人整个去掉（用人像抠图的蒙版稍微扩大）
    a, _ = matting.matte(rgb, "portrait", decontam=False)
    m = cv2.dilate((a > 60).astype(np.uint8) * 255, np.ones((15, 15), np.uint8))
    t = time.perf_counter()
    out, eng = inpaint.inpaint(rgb, m)
    print(f"    大蒙版（去掉整个人，{100 * (m > 0).mean():.0f}% 面积）{(time.perf_counter() - t) * 1000:.0f} ms，引擎 {eng}")
    save(np.concatenate([rgb, out], 1), "inpaint_remove_person.jpg")
    assert out.shape == rgb.shape
    # 小蒙版：抹掉一小块，结果要清晰（与周围纹理的清晰度相近）
    m2 = _ellipse_mask(rgb.shape, (int(W * 0.8), int(H * 0.12)), (14, 10))
    out2, _ = inpaint.inpaint(rgb, m2)
    y0, y1, x0, x1 = int(H * 0.12) - 60, int(H * 0.12) + 60, int(W * 0.8) - 60, int(W * 0.8) + 60
    crop = np.concatenate([rgb[y0:y1, x0:x1], out2[y0:y1, x0:x1]], 1)
    save(cv2.resize(crop, None, fx=3, fy=3, interpolation=cv2.INTER_NEAREST), "inpaint_small.png")
    # 多块分散的笔画
    m3 = np.zeros((H, W), np.uint8)
    for cx, cy in ((0.1, 0.1), (0.9, 0.9), (0.15, 0.85)):
        cv2.circle(m3, (int(W * cx), int(H * cy)), 18, 255, -1)
    out3, _ = inpaint.inpaint(rgb, m3)
    assert not np.array_equal(out3, rgb)
    # 空蒙版：原样返回
    out4, _ = inpaint.inpaint(rgb, np.zeros((H, W), np.uint8))
    assert np.array_equal(out4, rgb)
    # 整张图全涂
    out5, _ = inpaint.inpaint(rgb, np.full((H, W), 255, np.uint8))
    assert out5.shape == rgb.shape


def test_inpaint_opencv_fallback():
    rgb = rgb_of("corgi.jpg")
    m = _ellipse_mask(rgb.shape, (100, 100), (30, 20))
    out, eng = inpaint.inpaint(rgb, m, engine="opencv")
    assert eng == "opencv" and out.shape == rgb.shape
    assert not np.array_equal(out[m > 0], rgb[m > 0])
    # LaMa 出错时自动降级
    orig = inpaint._run_lama
    inpaint._run_lama = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom"))
    try:
        out, eng = inpaint.inpaint(rgb, m)
        assert eng == "opencv"
    finally:
        inpaint._run_lama = orig
    # 极小图
    t = np.full((16, 16, 3), 100, np.uint8)
    mm = np.zeros((16, 16), np.uint8)
    mm[6:10, 6:10] = 255
    for e in ("lama", "opencv"):
        o, _ = inpaint.inpaint(t, mm, engine=e)
        assert o.shape == t.shape


# ----------------------------------------------------------------------------
# 美颜
# ----------------------------------------------------------------------------
def _hf_energy(x):
    g = cv2.cvtColor(x, cv2.COLOR_RGB2GRAY).astype(np.float32)
    return float(np.abs(g - cv2.GaussianBlur(g, (0, 0), 3)).mean())


def test_retouch():
    rgb = rgb_of("portrait-of-woman.jpg")
    f = face.detect(rgb)[0]
    assert np.array_equal(retouch.retouch(rgb, 0, 0), rgb)
    t = time.perf_counter()
    out = retouch.retouch(rgb, 50, 0)
    print(f"    磨皮 50（{rgb.shape[1]}×{rgb.shape[0]}）{(time.perf_counter() - t) * 1000:.0f} ms")
    # 脸颊区域（两眼中点正下方偏外）变平滑
    (rex, rey), (lex, ley) = f["landmarks"][0], f["landmarks"][1]
    ed = lex - rex
    cy = int((rey + ley) / 2 + ed * 0.65)
    cx = int(rex)
    r = int(ed * 0.15)
    cheek = (slice(cy - r, cy + r), slice(cx - r, cx + r))
    assert _hf_energy(out[cheek]) < 0.8 * _hf_energy(rgb[cheek]), "磨皮后脸颊应更平滑"
    # 眼睛基本不变（清晰度保留 ≥ 90%）
    er = int(ed * 0.18)
    eye = (slice(int(rey) - er, int(rey) + er), slice(int(rex) - er, int(rex) + er))
    assert _hf_energy(out[eye]) > 0.9 * _hf_energy(rgb[eye]), "眼睛不应被磨糊"
    # 背景完全不变
    assert np.array_equal(out[:50, :50], rgb[:50, :50])
    # 美白：脸颊变亮，且强度单调
    w30 = retouch.retouch(rgb, 0, 30)
    w100 = retouch.retouch(rgb, 0, 100)
    l0 = rgb[cheek].mean()
    l30 = w30[cheek].mean()
    l100 = w100[cheek].mean()
    assert l0 < l30 < l100, (l0, l30, l100)
    # 主体蒙版限制范围：蒙版全黑 → 不变
    same = retouch.retouch(rgb, 80, 80, np.zeros(rgb.shape[:2], np.uint8))
    assert np.array_equal(same, rgb)
    # 前后对比图
    y0, y1 = int(f["y"]), int(f["y"] + f["h"])
    x0, x1 = int(f["x"]), int(f["x"] + f["w"])
    row = np.concatenate([rgb[y0:y1, x0:x1], out[y0:y1, x0:x1], retouch.retouch(rgb, 50, 50)[y0:y1, x0:x1]], 1)
    save(cv2.resize(row, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA), "retouch_face.jpg")
    save(np.concatenate([rgb[cheek], out[cheek]], 1), "retouch_cheek_1to1.png")
    # 没有人脸的图也不能崩
    o = retouch.retouch(rgb_of("corgi.jpg"), 60, 60)
    assert o.shape == rgb_of("corgi.jpg").shape
    o = retouch.retouch(np.full((16, 16, 3), 180, np.uint8), 100, 100)
    assert o.shape == (16, 16, 3)


# ----------------------------------------------------------------------------
# 运行时
# ----------------------------------------------------------------------------
def test_runtime_status():
    prov, dev = runtime.status()
    assert prov in ("DirectML", "CPU")
    assert isinstance(dev, str) and dev
    print(f"    后端：{prov} / {dev}")
    assert all(models_present().values())


def main(argv):
    tests = [(k, v) for k, v in globals().items() if k.startswith("test_") and callable(v)]
    if argv:
        tests = [(k, v) for k, v in tests if any(a in k for a in argv)]
    failed = []
    t_all = time.perf_counter()
    for name, fn in tests:
        t = time.perf_counter()
        print(f"[运行] {name}")
        try:
            fn()
            print(f"[通过] {name}（{time.perf_counter() - t:.1f} 秒）")
        except Exception:
            traceback.print_exc()
            print(f"[失败] {name}")
            failed.append(name)
    print("=" * 60)
    print(f"共 {len(tests)} 项，失败 {len(failed)} 项，用时 {time.perf_counter() - t_all:.0f} 秒")
    if failed:
        print("失败：" + "、".join(failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
