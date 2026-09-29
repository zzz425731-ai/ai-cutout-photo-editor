"""美颜：磨皮（保边平滑 + 保留细纹理）与美白（皮肤提亮 + 轻微去黄）。

retouch(rgb, smooth 0..100, whiten 0..100, mask=None) → rgb

皮肤区域：
  - 有人脸：从两颊/鼻梁采样这个人自己的肤色（YCrCb 中位数与离散度），按颜色距离得到「像皮肤的程度」；
    再乘以人物蒙版（前端传入的主体蒙版；没传就用 MODNet 现算一个），这样和肤色接近的背景（粉墙）不会被美白；
    磨皮只作用在脸部椭圆内，美白作用于人物身上所有皮肤（脸、耳朵、脖子、手臂颜色一致）；
  - 没有人脸：用通用的 YCrCb 肤色范围 ∩ 可选主体蒙版。
磨皮时用人脸关键点把眼睛、眉毛、嘴唇挖掉，保证它们清晰；暗色的发丝因为亮度/颜色不像皮肤也会被排除。
"""
import numpy as np
import cv2

from . import face as face_mod
from . import models_present

P = {
    "gf_r": 0.018,               # 磨皮导向滤波半径（相对脸宽）
    "gf_eps": (0.0006, 0.0045),  # 强度 0→100 时的 eps（越大越平滑）
    "texture": (0.65, 0.35),     # 加回的细纹理比例（强度 0→100），保留毛孔质感，避免「塑料脸」
    "tex_sigma": 0.0035,         # 细纹理尺度（相对脸宽）
    "whiten_beta": 4.0,          # 美白提亮曲线强度（100 时 beta = 1 + 4）
    "whiten_deyellow": 0.22,     # 美白 100 时 Lab b* 缩小比例
}


def _box(x, r):
    return cv2.boxFilter(x, -1, (2 * r + 1, 2 * r + 1), normalize=True, borderType=cv2.BORDER_REFLECT)


def _guided_self(I, r, eps, s=1):
    """每通道自导向滤波（保边平滑），可降采样 s 倍计算系数。I: HxWx3 float32 0..1。"""
    H, W = I.shape[:2]
    if s > 1:
        Is = cv2.resize(I, (max(1, W // s), max(1, H // s)), interpolation=cv2.INTER_AREA)
        rs = max(1, r // s)
    else:
        Is, rs = I, r
    m = _box(Is, rs)
    v = _box(Is * Is, rs) - m * m
    a = v / (v + eps)
    b = m - a * m
    a = _box(a, rs)
    b = _box(b, rs)
    if s > 1:
        a = cv2.resize(a, (W, H), interpolation=cv2.INTER_LINEAR)
        b = cv2.resize(b, (W, H), interpolation=cv2.INTER_LINEAR)
    return a * I + b


def _skin_generic(ycc):
    y, cr, cb = ycc[..., 0], ycc[..., 1], ycc[..., 2]
    m = (cr >= 133) & (cr <= 178) & (cb >= 77) & (cb <= 130) & (y >= 50)
    return m.astype(np.float32)


def _skin_stats(ycc, faces):
    """从每张脸的两颊、额头、鼻梁采样肤色 → (Y 中位数, Cr/Cb 中位数, Cr/Cb 尺度)。"""
    samples = []
    H, W = ycc.shape[:2]
    for f in faces:
        (rex, rey), (lex, ley), (nx, ny) = f["landmarks"][0], f["landmarks"][1], f["landmarks"][2]
        ed = max(4.0, np.hypot(lex - rex, ley - rey))
        pts = [(rex - 0.05 * ed, (rey + ny) / 2 + 0.25 * ed), (lex + 0.05 * ed, (ley + ny) / 2 + 0.25 * ed),
               ((rex + lex) / 2, (rey + ny) / 2)]
        r = max(2, int(ed * 0.12))
        for px, py in pts:
            x, y = int(px), int(py)
            if r <= x < W - r and r <= y < H - r:
                samples.append(ycc[y - r:y + r, x - r:x + r].reshape(-1, 3))
    if not samples:
        return None
    s = np.concatenate(samples).astype(np.float32)
    med = np.median(s, 0)
    mad = np.median(np.abs(s - med), 0) * 1.4826
    return med, mad


def _skin_adaptive(ycc, stats):
    med, mad = stats
    y = ycc[..., 0].astype(np.float32)
    cr = ycc[..., 1].astype(np.float32)
    cb = ycc[..., 2].astype(np.float32)
    scr = max(4.0, 3.0 * mad[1])
    scb = max(4.0, 3.0 * mad[2])
    d2 = ((cr - med[1]) / scr) ** 2 + ((cb - med[2]) / scb) ** 2
    p = np.exp(-0.5 * d2)
    # 太暗的（发丝、眉毛、瞳孔、鼻孔）不是皮肤；阴影里的皮肤亮度可低到中位数的一半
    ylo = 0.5 * med[0]
    p *= np.clip((y - ylo) / max(1.0, 0.15 * med[0]), 0, 1)
    return p.astype(np.float32)


def _ellipses(shape, faces, sx, sy, dy, neck=False):
    """每张脸一个软椭圆：半轴 = (sx·w, sy·h)，中心下移 dy·h。"""
    H, W = shape[:2]
    reg = np.zeros((H, W), np.float32)
    for f in faces:
        cx = f["x"] + f["w"] / 2
        cy = f["y"] + f["h"] * (0.5 + dy)
        cv2.ellipse(reg, (int(cx), int(cy)), (max(1, int(f["w"] * sx)), max(1, int(f["h"] * sy))), 0, 0, 360, 1.0, -1)
        if neck:
            cv2.ellipse(reg, (int(cx), int(f["y"] + f["h"] * 1.45)), (max(1, int(f["w"] * 0.55)), max(1, int(f["h"] * 0.75))),
                        0, 0, 360, 1.0, -1)
    return reg


def _protect(shape, faces, lips=True):
    """眼睛（含睫毛）、眉毛、嘴唇 → 保护权重。"""
    H, W = shape[:2]
    prot = np.zeros((H, W), np.float32)
    for f in faces:
        lm = f["landmarks"]
        (rex, rey), (lex, ley) = lm[0], lm[1]
        ed = max(1.0, np.hypot(lex - rex, ley - rey))
        ang = float(np.degrees(np.arctan2(ley - rey, lex - rex)))
        for ex, ey in ((rex, rey), (lex, ley)):
            cv2.ellipse(prot, (int(ex), int(ey)), (int(ed * 0.3), int(ed * 0.17)), ang, 0, 360, 1.0, -1)
            cv2.ellipse(prot, (int(ex), int(ey - ed * 0.33)), (int(ed * 0.4), int(ed * 0.13)), ang, 0, 360, 1.0, -1)
        if lips:
            (rmx, rmy), (lmx, lmy) = lm[3], lm[4]
            mw = max(1.0, np.hypot(lmx - rmx, lmy - rmy))
            cv2.ellipse(prot, (int((rmx + lmx) / 2), int((rmy + lmy) / 2)), (int(mw * 0.6), int(mw * 0.32)), ang, 0, 360, 0.7, -1)
    return prot


def _shift_faces(faces, x0, y0):
    return [dict(f, x=f["x"] - x0, y=f["y"] - y0, landmarks=[[p[0] - x0, p[1] - y0] for p in f["landmarks"]])
            for f in faces]


def _person_mask(rgb):
    """没有传主体蒙版时，用 MODNet 估一个人像蒙版（uint8），失败返回 None。"""
    if not models_present().get("portrait"):
        return None
    try:
        from . import matting
        H, W = rgb.shape[:2]
        m = matting.modnet_raw(rgb)
        m = cv2.resize(m, (W, H), interpolation=cv2.INTER_LINEAR)
        return (np.clip(m, 0, 1) * 255 + 0.5).astype(np.uint8)
    except Exception:
        return None


def retouch(rgb, smooth=0, whiten=0, mask=None):
    smooth = float(np.clip(smooth, 0, 100)) / 100.0
    whiten = float(np.clip(whiten, 0, 100)) / 100.0
    if smooth <= 0 and whiten <= 0:
        return rgb.copy()
    H, W = rgb.shape[:2]
    faces = []
    if models_present().get("face") and min(H, W) >= 32:
        faces = [f for f in face_mod.detect(rgb) if f["score"] >= 0.6 and f["w"] >= 24]
    if mask is None and faces:
        mask = _person_mask(rgb)  # 让美白/磨皮不碰到和肤色接近的背景（如粉色墙）

    # 处理范围（ROI）：人物蒙版的外框 ∪ 人脸区域；都没有就整张图
    boxes = []
    if mask is not None:
        ys = np.nonzero((mask > 12).any(1))[0]
        xs = np.nonzero((mask > 12).any(0))[0]
        if len(ys) == 0:
            return rgb.copy()
        boxes.append((ys[0], ys[-1] + 1, xs[0], xs[-1] + 1))
    fw = float(np.median([f["w"] for f in faces])) if faces else max(H, W) * 0.3
    for f in faces:
        boxes.append((int(f["y"] - 0.3 * f["h"]), int(f["y"] + 2.2 * f["h"]), int(f["x"] - 0.3 * f["w"]), int(f["x"] + 1.3 * f["w"])))
    if boxes and mask is not None:
        y0 = max(0, min(b[0] for b in boxes)); y1 = min(H, max(b[1] for b in boxes))
        x0 = max(0, min(b[2] for b in boxes)); x1 = min(W, max(b[3] for b in boxes))
        if mask is not None:  # 蒙版外的像素本来就不会改
            my0, my1, mx0, mx1 = boxes[0]
            y0, y1, x0, x1 = max(y0, my0), min(y1, my1), max(x0, mx0), min(x1, mx1)
    else:
        y0, y1, x0, x1 = 0, H, 0, W
    if y1 <= y0 or x1 <= x0:
        return rgb.copy()
    roi = rgb[y0:y1, x0:x1]
    I = roi.astype(np.float32) * (1.0 / 255.0)
    ycc = cv2.cvtColor(roi, cv2.COLOR_RGB2YCrCb)

    sub = _shift_faces(faces, x0, y0) if faces else []
    stats = _skin_stats(ycc, sub) if sub else None
    skin = _skin_adaptive(ycc, stats) if stats is not None else _skin_generic(ycc)
    skin = cv2.GaussianBlur(skin, (0, 0), max(1.0, fw * 0.006))
    if mask is not None:
        skin *= mask[y0:y1, x0:x1].astype(np.float32) * (1.0 / 255.0)

    m_white = skin
    if sub:
        face_reg = cv2.GaussianBlur(_ellipses(roi.shape, sub, 0.52, 0.66, 0.1), (0, 0), fw * 0.05)
        prot = cv2.GaussianBlur(_protect(roi.shape, sub), (0, 0), max(1.0, fw * 0.012))
        m_smooth = skin * face_reg * (1 - np.clip(prot, 0, 1))
    else:
        m_smooth = skin

    out = I
    if smooth > 0:
        r = max(2, int(P["gf_r"] * fw))
        eps = P["gf_eps"][0] + (P["gf_eps"][1] - P["gf_eps"][0]) * smooth
        s = max(1, r // 8)
        base = _guided_self(I, r, eps, s)
        sig = max(0.5, P["tex_sigma"] * fw)
        detail = I - cv2.GaussianBlur(I, (0, 0), sig)
        keep = P["texture"][0] + (P["texture"][1] - P["texture"][0]) * smooth
        sm = base + detail * keep
        amt = np.clip(m_smooth * min(1.0, 0.35 + smooth), 0, 1)[..., None]
        out = I + (sm - I) * amt
    if whiten > 0:
        beta = 1.0 + P["whiten_beta"] * whiten
        bright = np.log1p(out * np.float32(beta - 1)) / np.float32(np.log(beta))
        lab = cv2.cvtColor(np.clip(bright, 0, 1).astype(np.float32), cv2.COLOR_RGB2Lab)
        lab[..., 2] *= np.float32(1 - P["whiten_deyellow"] * whiten)
        lab[..., 1] *= np.float32(1 - 0.06 * whiten)
        bright = cv2.cvtColor(lab, cv2.COLOR_Lab2RGB)
        amt = np.clip(m_white, 0, 1)[..., None]
        out = out + (bright - out) * amt
    res = rgb.copy()
    res[y0:y1, x0:x1] = np.clip(out * 255 + 0.5, 0, 255).astype(np.uint8)
    return res
