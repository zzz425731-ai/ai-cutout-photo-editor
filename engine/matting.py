"""抠图：BiRefNet_lite（通用）+ MODNet（人像）+ 发丝细化 + 去色边。

对外接口：
    alpha, patch = matte(rgb, mode="general"|"portrait", decontam=True)
    rgb: HxWx3 uint8 → alpha: HxW uint8；patch: 去色边补丁 dict 或 None（见 fg_patch）

流程（本次质量验证见 docs/matting-quality-20260929.md）：
  1. BiRefNet 1024×1024 → sigmoid → 双线性放大到原图尺寸；
  2. 人像模式：用 MODNet 判断「哪里是人」，去掉 BiRefNet 顺带抠进来的非人物体（比如人靠着的车），
     补上 BiRefNet 漏掉的人体部分；
  3. 补洞/去碎块：仅补低置信小洞，保留真孔洞、发丝连接和高置信小前景；
  4. 发丝细化（color-line）：只在「又宽又软」的边缘区（头发、毛发）里，用局部前景色/背景色
     按像素重新估计透明度，让一根根发丝从背景里分离出来；背景越杂乱越少改动；
  5. 去色边：Blur-Fusion + 平滑背景下的可信锚点解混色，估计半透明区真实前景色。
"""
import numpy as np
import cv2

from . import runtime

BIREF_SIZE = 1024
MEAN = np.array([0.485, 0.456, 0.406], np.float32)
STD = np.array([0.229, 0.224, 0.225], np.float32)

P = {
    # 补洞 / 去碎块
    "speck": 0.0005,        # 仅检查面积 < 0.05% 的低置信孤立碎块；保护细线/软连接/高置信前景
    "hole_unsure": 0.15,    # 封闭的洞里模型平均 alpha ≥ 此值且最小值 ≥ 0.05（模型没把握）→ 补上
    # 发丝细化（color-line）
    "cl": True,
    "cl_wide": 2.0,         # 「宽」软边：不确定带经过半径 wide×放大倍数 的开运算后还剩下的部分
    "cl_grow": 4.0,         # 再向外扩 grow×放大倍数，把模型漏掉的外圈发丝也包进来
    "cl_rfrac": 1 / 40,     # 局部前景/背景色的估计窗口 = 长边 / 40
    "cl_k": 2.0,            # 背景纹理惩罚：背景方差 × k 接近前景/背景色差时不再相信颜色
    "cl_denoise": 80.0,     # 去噪高斯 σ = 80 × 估计的噪声水平（颗粒感重的照片先轻微平滑再算）
    # 人像
    "modnet_ref": 512,      # MODNet 短边分辨率（实测 512 最好，1024 会出现块状误判）
    "person_gate": 0.006,   # 人像门控：MODNet 人物区域向外扩 0.6% 长边，范围外的 BiRefNet 结果去掉
    "person_min": 0.004,    # MODNet 检出的人物面积 < 0.4% 就认为没有人 → 退回通用模式
}


# ----------------------------------------------------------------------------
# 模型推理
# ----------------------------------------------------------------------------
def _resize(img, w, h):
    ih, iw = img.shape[:2]
    interp = cv2.INTER_AREA if (w < iw and h < ih) else cv2.INTER_LINEAR
    return cv2.resize(img, (w, h), interpolation=interp)


def birefnet_raw(rgb):
    """→ 1024×1024 float32 alpha（0..1）。"""
    x = _resize(rgb, BIREF_SIZE, BIREF_SIZE).astype(np.float32) * (1.0 / 255.0)
    x = (x - MEAN) / STD
    x = np.ascontiguousarray(x.transpose(2, 0, 1)[None])
    y = runtime.run("general", {"input_image": x})[0][0, 0]
    if y.min() < -0.01 or y.max() > 1.01:  # 实测输出是 logits
        y = 1.0 / (1.0 + np.exp(-np.clip(y, -30, 30)))
    return np.clip(y, 0, 1).astype(np.float32)


def modnet_raw(rgb, ref=None):
    """→ MODNet alpha（推理分辨率下，float32 0..1）。短边缩放到 ref，两边取 32 的倍数。"""
    ref = ref or P["modnet_ref"]
    h, w = rgb.shape[:2]
    if max(h, w) < ref or min(h, w) > ref:
        if w >= h:
            rh, rw = ref, int(round(w / h * ref))
        else:
            rw, rh = ref, int(round(h / w * ref))
    else:
        rh, rw = h, w
    rh = max(32, rh - rh % 32)
    rw = max(32, rw - rw % 32)
    x = _resize(rgb, rw, rh).astype(np.float32) * (1.0 / 127.5) - 1.0
    x = np.ascontiguousarray(x.transpose(2, 0, 1)[None])
    y = runtime.run("portrait", {"input": x})[0][0, 0]
    return np.clip(y, 0, 1).astype(np.float32)


# ----------------------------------------------------------------------------
# 工具
# ----------------------------------------------------------------------------
def _disk(r):
    r = max(1, int(round(r)))
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))


def _bbox(mask, pad, shape):
    ys = np.nonzero(mask.any(1))[0]
    if len(ys) == 0:
        return None
    xs = np.nonzero(mask.any(0))[0]
    H, W = shape[:2]
    return (max(0, ys[0] - pad), min(H, ys[-1] + pad + 1), max(0, xs[0] - pad), min(W, xs[-1] + pad + 1))


def _upsample(a, W, H):
    return np.clip(cv2.resize(a, (W, H), interpolation=cv2.INTER_LINEAR), 0, 1)


def clean(alpha):
    """只清理低置信噪点；保护真孔洞、小物体及半透明发丝之间的连接。"""
    H, W = alpha.shape
    area = H * W
    alpha = alpha.copy()
    # 1) 封闭的洞
    hole = (alpha < 0.5).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(hole, connectivity=4)
    if n > 2:
        border = np.zeros(n, bool)
        border[np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))] = True
        cand = [i for i in range(1, n) if not border[i] and stats[i, cv2.CC_STAT_AREA] < 0.02 * area]
        if cand:
            idx = lab.ravel()
            cnt = np.bincount(idx, minlength=n)
            mean = np.bincount(idx, weights=alpha.ravel(), minlength=n) / np.maximum(cnt, 1)
            mn = np.full(n, 1.0, np.float32)
            np.minimum.at(mn, idx, alpha.ravel())
            # 面积小不能证明是误检：耳环、指缝、卷发之间的真背景孔也很小。
            fill = [i for i in cand if mean[i] >= P["hole_unsure"] and mn[i] >= 0.05]
            if fill:
                alpha[np.isin(lab, fill)] = 1.0
    # 2) 孤立的前景碎块
    solid = (alpha >= 0.5).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(solid, connectivity=8)
    if n > 2:
        areas = stats[1:, cv2.CC_STAT_AREA]
        small = np.nonzero(areas < max(16, P["speck"] * area))[0] + 1
        if 0 < len(small) < n - 1:  # 至少留下一个大块
            peak = np.zeros(n, np.float32)
            np.maximum.at(peak, lab.ravel(), alpha.ravel())
            # 0.5 阈值会把同一根发丝切成几段。用低阈值判断是否仍与主体相连，
            # 而不是扩大删除区域后再尝试补回已经丢失的发丝。
            _, soft_lab = cv2.connectedComponents((alpha > 0.05).astype(np.uint8), connectivity=8)
            big_ids = np.setdiff1d(np.arange(1, n), small)
            main_soft = np.unique(soft_lab[np.isin(lab, big_ids)])
            attached = np.zeros(n, bool)
            attached[np.unique(lab[np.isin(soft_lab, main_soft)])] = True
            widths = stats[:, cv2.CC_STAT_WIDTH]
            heights = stats[:, cv2.CC_STAT_HEIGHT]
            longest = np.maximum(widths, heights)
            # 主体附近的狭长弱前景可能是断开的发丝、胡须或动物毛。
            # 远处的细线仍可能是背景噪点，不仅凭长宽比保留。
            slender = ((longest >= max(6, round(max(H, W) * 0.003))) &
                       (stats[:, cv2.CC_STAT_AREA] / np.maximum(longest, 1) <= 3))
            near_main = cv2.dilate(np.isin(lab, big_ids).astype(np.uint8),
                                   _disk(max(3, max(H, W) * 0.006))).astype(bool)
            nearby = np.zeros(n, bool)
            nearby[np.unique(lab[near_main])] = True
            small = small[(peak[small] < 0.85) & ~attached[small] & ~(slender[small] & nearby[small])]
            if len(small) == 0:
                return alpha
            kill = np.isin(lab, small)
            big = (solid > 0) & ~kill
            # 连同碎块周围的半透明像素一起去掉，但不碰大块旁边的软边
            halo = cv2.dilate(kill.astype(np.uint8), _disk(3)).astype(bool) & (alpha < 0.5)
            halo &= ~cv2.dilate(big.astype(np.uint8), _disk(4)).astype(bool)
            alpha[kill | halo] = 0.0
    return alpha


def _noise_level(gray_u8, where, max_px=1_500_000):
    """Immerkær 噪声估计（只在 where 为真的像素上统计）。gray_u8: uint8。
    大图只取一部分行块来算，结果足够稳定，也不用整张图的 float 副本。"""
    H = gray_u8.shape[0]
    if gray_u8.size > max_px:
        step = int(np.ceil(gray_u8.size / max_px))
        rows = np.concatenate([np.arange(y, min(H, y + 64)) for y in range(0, H, 64 * step)])
        gray_u8, where = gray_u8[rows], where[rows]
    if np.count_nonzero(where) < 200:
        return 0.0
    k = np.array([[1, -2, 1], [-2, 4, -2], [1, -2, 1]], np.float32)
    lap = np.abs(cv2.filter2D(gray_u8.astype(np.float32) * (1.0 / 255.0), -1, k))
    return float(np.sqrt(np.pi / 2) * lap[where].mean() / 6)


# 大窗口的局部统计量（局部前景色/背景色/方差）在缩小的图上算，再只在需要的像素上双线性取值：
# 窗口半径约 100 像素时缩小 8~12 倍几乎没有差别，但 1200 万像素的照片不用再建好几个全尺寸 float 数组。
def _down(img, f):
    if f <= 1:
        return img.astype(np.float32) if img.dtype != np.float32 else img
    h, w = img.shape[:2]
    return cv2.resize(img, (max(1, -(-w // f)), max(1, -(-h // f))), interpolation=cv2.INTER_AREA).astype(np.float32)


def _sampler(ys, xs, f):
    """返回 sample(img_lowres) → 在全尺寸坐标 (ys, xs) 处的双线性取值（N×C 或 N）。"""
    if f <= 1:
        return lambda img: img[ys, xs]
    mx = ((xs.astype(np.float32) + 0.5) / f - 0.5)[None]
    my = ((ys.astype(np.float32) + 0.5) / f - 0.5)[None]
    # remap 的坐标图宽度不能超过 32767：分段取
    CH = 32000

    def sample(img):
        parts = [cv2.remap(img, mx[:, i:i + CH], my[:, i:i + CH], cv2.INTER_LINEAR,
                           borderMode=cv2.BORDER_REPLICATE)[0] for i in range(0, mx.shape[1], CH)]
        return np.concatenate(parts, 0) if parts else np.zeros((0,) + img.shape[2:], np.float32)
    return sample


def _sq_down(Iu8, f):
    """缩小后的 |I|²（0..1 尺度），逐通道用 uint16 平方，避免全尺寸 float 数组。"""
    acc = None
    for c in range(3):
        sq = Iu8[..., c].astype(np.uint16)
        sq *= sq
        d = _down(sq, f) * (1.0 / 65025.0)
        acc = d if acc is None else acc + d
    return acc


def refine_colorline(rgb, a0, scale):
    """发丝细化：在「又宽又软」的边缘区内，用局部前景色 F / 背景色 B 按像素估计
    alpha = ((I-B)·(F-B)) / |F-B|²，并按可信度与模型 alpha 混合：
      可信度 = 背景够平滑（方差小于色差） × 模型本身不确定（alpha 越接近 1 越少改）× 区域权重。
    细而清晰的边（人脸、衣服、物体轮廓）不进入该区域，保持模型原样。
    F / B / 方差这些大窗口统计量在缩小 f 倍的图上算，逐像素公式仍用原图像素。"""
    H, W = a0.shape
    L = max(H, W)
    unsure = ((a0 > 0.02) & (a0 < 0.98)).astype(np.uint8)
    wide = cv2.morphologyEx(unsure, cv2.MORPH_OPEN, _disk(max(2.0, P["cl_wide"] * scale)))
    if not wide.any():
        return a0
    del unsure
    reg = cv2.dilate(wide, _disk(max(2.0, P["cl_grow"] * scale)))
    del wide
    r1 = int(np.clip(round(L * P["cl_rfrac"]), 9, 121))
    y0, y1, x0, x1 = _bbox(reg, r1 + 2, a0.shape)
    Iu8 = rgb[y0:y1, x0:x1]
    a = a0[y0:y1, x0:x1]
    # 区域权重：区域的高斯羽化；它 > 0 的像素才需要计算
    sw = max(1.0, scale)
    w_u8 = cv2.GaussianBlur(reg[y0:y1, x0:x1] * np.uint8(255), (0, 0), sw)
    del reg
    ys, xs = np.nonzero(w_u8)
    if len(ys) == 0:
        return a0
    # 颗粒感重的照片先按噪声水平轻微平滑（只用于算 alpha）
    n = _noise_level(cv2.cvtColor(Iu8, cv2.COLOR_RGB2GRAY), a < 0.02)
    sig = float(np.clip(P["cl_denoise"] * n, 0, 1.5))
    # ---- 缩小图上的局部统计
    f = max(1, r1 // 8)
    k = max(3, int(round(r1 / f)))
    Is = _down(Iu8, f) * (1.0 / 255.0)
    IIs = _sq_down(Iu8, f)
    As = _down(a, f)
    wF = As * As
    wB = (1 - As) * (1 - As)
    sF = cv2.blur(wF, (k, k))
    sB = cv2.blur(wB, (k, k))
    F = cv2.blur(Is * wF[..., None], (k, k)) / (sF[..., None] + 1e-5)
    B = cv2.blur(Is * wB[..., None], (k, k)) / (sB[..., None] + 1e-5)
    varB = np.maximum(cv2.blur(IIs * wB, (k, k)) / (sB + 1e-5) - (B * B).sum(-1), 0)
    stats_a = np.dstack([F, sF])                  # 4 通道一次取样
    stats_b = np.dstack([B, sB])
    samp = _sampler(ys, xs, f)
    sa, sb, vB = samp(stats_a), samp(stats_b), samp(varB)
    Fp, sFp = sa[:, :3], sa[:, 3]
    Bp, sBp = sb[:, :3], sb[:, 3]
    # ---- 逐像素（原图分辨率，只算区域内的像素）
    if sig > 0.25:
        Idp = cv2.GaussianBlur(Iu8, (0, 0), sig)[ys, xs].astype(np.float32) * (1.0 / 255.0)
    else:
        Idp = Iu8[ys, xs].astype(np.float32) * (1.0 / 255.0)
    ap = a[ys, xs]
    d = Fp - Bp
    dd = (d * d).sum(-1)
    ac = np.clip(((Idp - Bp) * d).sum(-1) / (dd + 1e-6), 0, 1)
    t = np.clip((dd - P["cl_k"] * vB) / (dd + 1e-6), 0, 1)
    t *= np.clip(sFp / 0.02, 0, 1) * np.clip(sBp / 0.02, 0, 1)
    g = np.clip((1 - ap) * 2.0, 0, 1)
    wp = w_u8[ys, xs].astype(np.float32) * (1.0 / 255.0)
    out = a0.copy()
    out[ys + y0, xs + x0] = ap + (t * g * wp) * (ac - ap)
    return out


def estimate_foreground(rgb, alpha):
    """两遍 Blur-Fusion 前景估计，并在平滑背景/前景锚点可信时正则化解混色。
    rgb uint8，alpha float32 → (ys, xs, F)：半透明像素的坐标和估计的前景色（N×3 float32 0..1），
    没有半透明像素时返回 None。
    两遍的模糊统计分别在缩小 f1 / f2 倍的图上算，最后一步的公式用原图像素。"""
    H, W = alpha.shape
    L = max(H, W)
    r1 = int(np.clip(round(L / 40), 9, 91))
    r2 = max(3, r1 // 15)
    band = (alpha > 0.01) & (alpha < 0.99)
    bb = _bbox(band, r1 + 2, alpha.shape)
    if bb is None:
        return None
    y0, y1, x0, x1 = bb
    Iu8 = rgb[y0:y1, x0:x1]
    a = alpha[y0:y1, x0:x1]
    ys, xs = np.nonzero(band[y0:y1, x0:x1])
    # 第一遍（大窗口）在 1/f1 尺寸
    f1 = max(1, r1 // 8)
    k1 = max(3, int(round(r1 / f1)))
    I1 = _down(Iu8, f1) * (1.0 / 255.0)
    a1 = _down(a, f1)
    ba = cv2.blur(a1, (k1, k1))[..., None]
    bF1 = cv2.blur(I1 * a1[..., None], (k1, k1)) / (ba + 1e-5)
    bB1 = cv2.blur(I1 * (1 - a1)[..., None], (k1, k1)) / ((1 - ba) + 1e-5)
    # 对平滑纯色背景，使用确定的前/背景样本能避免半透明混色被当成真实前景色。
    # 复杂背景或没有不透明前景锚点时仍使用下面的 Blur-Fusion。
    wf = (a1 >= 0.98).astype(np.float32)
    wb = (a1 <= 0.02).astype(np.float32)
    anchor_kernel = (2 * k1 + 1, 2 * k1 + 1)
    sf = cv2.blur(wf, anchor_kernel)
    sb = cv2.blur(wb, anchor_kernel)
    anchored_f = cv2.blur(I1 * wf[..., None], anchor_kernel) / (sf[..., None] + 1e-6)
    anchored_b = cv2.blur(I1 * wb[..., None], anchor_kernel) / (sb[..., None] + 1e-6)
    # 二阶矩在缩小前计算，避免细背景纹理被降采样抹平后误判成纯色。
    var_b = np.maximum(cv2.blur(_sq_down(Iu8, f1) * wb, anchor_kernel) / (sb + 1e-6) -
                       (anchored_b * anchored_b).sum(-1), 0)
    del I1, a1, ba
    # 第二遍（小窗口）在 1/f2 尺寸：先在这个尺寸上得到第一遍的 F
    f2 = max(1, r2 // 2)
    k2 = max(3, int(round(r2 / f2)))
    I2 = _down(Iu8, f2) * (1.0 / 255.0)
    a2 = _down(a, f2)
    h2, w2 = a2.shape
    up = lambda m: cv2.resize(m, (w2, h2), interpolation=cv2.INTER_LINEAR)
    bF1u, bB1u = up(bF1), up(bB1)
    A2 = a2[..., None]
    F1 = np.clip(bF1u + A2 * (I2 - A2 * bF1u - (1 - A2) * bB1u), 0, 1)
    del bF1u, I2
    ba2 = cv2.blur(a2, (k2, k2))[..., None]
    bF2 = cv2.blur(F1 * A2, (k2, k2)) / (ba2 + 1e-5)
    bB2 = cv2.blur(bB1u * (1 - A2), (k2, k2)) / ((1 - ba2) + 1e-5)
    del F1, bB1u, ba2
    samp = _sampler(ys, xs, f2)
    bFp, bBp = samp(bF2), samp(bB2)
    Ip = Iu8[ys, xs].astype(np.float32) * (1.0 / 255.0)
    ap = a[ys, xs][:, None]
    F = np.clip(bFp + ap * (Ip - ap * bFp - (1 - ap) * bBp), 0, 1)
    anchors = _sampler(ys, xs, f1)(np.dstack([anchored_f, anchored_b, sf, sb, var_b]))
    fp, bp = anchors[:, :3], anchors[:, 3:6]
    # 正则化的解混色：透明度越低越依赖附近前景，避免除以很小的 alpha 放大噪声。
    regularizer = 0.01
    unmixed = (ap * (Ip - (1 - ap) * bp) + regularizer * fp) / (ap * ap + regularizer)
    trust = np.clip(anchors[:, 6] / 0.1, 0, 1) * np.clip(anchors[:, 7] / 0.1, 0, 1)
    trust *= np.clip(1 - anchors[:, 8] / 0.002, 0, 1)
    # 解混色超出色域通常表示 alpha/局部颜色不可靠，按程度退回原算法。
    overshoot = np.maximum(-unmixed, unmixed - 1).max(-1)
    trust *= np.clip(1 - np.maximum(overshoot, 0) / 0.1, 0, 1)
    F += trust[:, None] * (np.clip(unmixed, 0, 1) - F)
    return ys + y0, xs + x0, F


# ----------------------------------------------------------------------------
# 两种模式
# ----------------------------------------------------------------------------
def person_fuse(b, m, has_face=True):
    """人像融合：b = BiRefNet alpha，m = MODNet alpha（同尺寸）。
    返回 None 表示「看起来不是人像」（没检出人 / 没有人脸且两个模型分歧太大），调用方改用通用结果。"""
    H, W = b.shape
    L = max(H, W)
    person = m > 0.5
    if person.mean() < P["person_min"]:
        return None
    solid_b = b > 0.5
    inter = np.count_nonzero(person & solid_b)
    union = max(1, np.count_nonzero(person | solid_b))
    if not has_face and inter / union < 0.5:
        return None
    # 门控：BiRefNet 的结果只保留在 MODNet 认为是人的地方（允许轮廓外扩一点点给发丝），
    # 这样人靠着的车、身后的物体会被去掉，而人物轮廓仍用 BiRefNet 更锐利的边。
    r = max(2.0, P["person_gate"] * L)
    mdil = cv2.dilate(m, _disk(r))
    gate = np.clip((mdil - 0.05) / 0.2, 0, 1)
    gate = cv2.GaussianBlur(gate, (0, 0), max(1.0, r / 2))
    fused = b * gate
    # BiRefNet 漏掉而 MODNet 有把握的人体部分：远离 BiRefNet 轮廓的地方用 MODNet
    near_b = cv2.dilate(solid_b.astype(np.uint8), _disk(max(3.0, 0.01 * L))).astype(np.float32)
    near_b = cv2.GaussianBlur(near_b, (0, 0), max(1.0, 0.004 * L))
    return np.maximum(fused, m * (1 - near_b))


def alpha_general(rgb, refine=True):
    H, W = rgb.shape[:2]
    a = _upsample(birefnet_raw(rgb), W, H)
    if refine:
        a = clean(a)
        if P["cl"]:
            a = refine_colorline(rgb, a, max(1.0, max(H, W) / BIREF_SIZE))
    return a


def alpha_portrait(rgb, refine=True):
    H, W = rgb.shape[:2]
    b = _upsample(birefnet_raw(rgb), W, H)
    m = _upsample(modnet_raw(rgb), W, H)
    try:
        from . import face
        has_face = len(face.detect(rgb)) > 0
    except Exception:
        has_face = True
    a = person_fuse(b, m, has_face)
    if a is None:  # 没有人：按通用模式处理
        a = b
    if refine:
        a = clean(a)
        if P["cl"]:
            a = refine_colorline(rgb, a, max(1.0, max(H, W) / BIREF_SIZE))
    return a


def fg_patch(rgb, alpha8):
    """去色边补丁：只包含半透明像素的新颜色。
    → {"x", "y", "rgba": hxwx4 uint8（被替换的像素 A=255，其余 A=0）}，没有半透明像素时 None。
    前端把补丁画在原图副本上即得到去色边后的前景图（其它像素保持原图、无损）。"""
    af = alpha8.astype(np.float32) * (1.0 / 255.0)
    r = estimate_foreground(rgb, af)
    del af
    if r is None:
        return None
    ys, xs, F = r
    y0, x0 = int(ys.min()), int(xs.min())
    h, w = int(ys.max()) - y0 + 1, int(xs.max()) - x0 + 1
    rgba = np.zeros((h, w, 4), np.uint8)
    rgba[ys - y0, xs - x0, :3] = (F * 255 + 0.5).astype(np.uint8)
    rgba[ys - y0, xs - x0, 3] = 255
    return {"x": x0, "y": y0, "rgba": rgba}


def matte(rgb, mode="general", decontam=True, refine=True):
    """→ (alpha uint8 HxW, 去色边补丁 dict 或 None —— 见 fg_patch)"""
    a = alpha_portrait(rgb, refine) if mode == "portrait" else alpha_general(rgb, refine)
    alpha8 = (np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)
    del a
    return alpha8, (fg_patch(rgb, alpha8) if decontam else None)
