"""消除笔：LaMa（512×512 固定输入）+ OpenCV 兜底。

inpaint(rgb, mask) → (out_rgb, "lama"|"opencv")
    rgb: HxWx3 uint8；mask: HxW uint8，>127 = 要去掉的地方。

LaMa 的输入/输出（实测）：
    image: [1,3,512,512] float32 RGB 0..1；mask: [1,1,512,512] float32 {0,1}
    output: [1,3,512,512] float32 RGB 0..255
"""
import numpy as np
import cv2

from . import models_present, runtime

LAMA = 512

P = {
    "ctx": 2.5,        # 上下文裁剪边长 = 蒙版外框长边 × ctx
    "min_crop": 512,   # 裁剪边长下限（小蒙版时尽量 1:1 送进模型，结果最清晰）
    "dilate": 0.012,   # 送进模型前把蒙版向外扩（相对裁剪边长），盖住物体边缘的残影
    "feather": 0.006,  # 贴回原图时的羽化（相对裁剪边长）
    "merge": 1.35,     # 两块蒙版的合并外框不超过单独外框 × merge 时合成一次处理
}


def _disk(r):
    r = max(1, int(round(r)))
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))


def _components(m):
    """蒙版连通块 → 外框列表 [(y0,y1,x0,x1)]，靠得近的合并。"""
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m.astype(np.uint8), connectivity=8)
    boxes = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        boxes.append([y, y + h, x, x + w])
    if len(boxes) > 12:  # 太多零碎笔画：当作一整块
        ys0 = min(b[0] for b in boxes); ys1 = max(b[1] for b in boxes)
        xs0 = min(b[2] for b in boxes); xs1 = max(b[3] for b in boxes)
        return [[ys0, ys1, xs0, xs1]]
    merged = True
    while merged and len(boxes) > 1:
        merged = False
        for i in range(len(boxes)):
            for j in range(i + 1, len(boxes)):
                a, b = boxes[i], boxes[j]
                u = [min(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), max(a[3], b[3])]
                side_u = max(u[1] - u[0], u[3] - u[2])
                side_ab = max(a[1] - a[0], a[3] - a[2], b[1] - b[0], b[3] - b[2])
                if side_u <= side_ab * P["merge"] or side_u * P["ctx"] <= P["min_crop"]:
                    boxes[i] = u
                    del boxes[j]
                    merged = True
                    break
            if merged:
                break
    return boxes


def _crop_box(box, H, W):
    y0, y1, x0, x1 = box
    side = int(max(y1 - y0, x1 - x0) * P["ctx"])
    side = max(side, min(P["min_crop"], max(H, W)), 256)
    cy, cx = (y0 + y1) / 2, (x0 + x1) / 2
    sy = min(side, H)
    sx = min(side, W)
    top = int(round(cy - sy / 2)); left = int(round(cx - sx / 2))
    top = max(0, min(H - sy, top)); left = max(0, min(W - sx, left))
    return top, top + sy, left, left + sx, side


def _run_lama(img, m):
    """img: SxSx3 uint8（S 任意），m: SxS bool → SxSx3 uint8。"""
    S = img.shape[0]
    if S != LAMA:
        interp = cv2.INTER_AREA if S > LAMA else cv2.INTER_CUBIC
        x = cv2.resize(img, (LAMA, LAMA), interpolation=interp)
        mm = cv2.resize(m.astype(np.uint8) * 255, (LAMA, LAMA), interpolation=cv2.INTER_AREA) > 0
    else:
        x, mm = img, m
    xin = np.ascontiguousarray((x.astype(np.float32) / 255.0).transpose(2, 0, 1)[None])
    min_ = np.ascontiguousarray(mm.astype(np.float32)[None, None])
    y = runtime.run("inpaint", {"image": xin, "mask": min_})[0][0]
    y = np.clip(y.transpose(1, 2, 0), 0, 255)
    if y.max() <= 1.5:  # 万一某个版本的模型输出 0..1
        y = y * 255.0
    y = (y + 0.5).astype(np.uint8)
    if S != LAMA:
        interp = cv2.INTER_AREA if S < LAMA else cv2.INTER_CUBIC
        y = cv2.resize(y, (S, S), interpolation=interp)
    return y


def _run_opencv(img, m):
    S = img.shape[0]
    lim = 768
    if S > lim:
        x = cv2.resize(img, (lim, lim), interpolation=cv2.INTER_AREA)
        mm = cv2.resize(m.astype(np.uint8) * 255, (lim, lim), interpolation=cv2.INTER_AREA) > 0
    else:
        x, mm = img, m
    r = max(3, int(x.shape[0] / 100))
    y = cv2.inpaint(cv2.cvtColor(x, cv2.COLOR_RGB2BGR), mm.astype(np.uint8) * 255, r, cv2.INPAINT_TELEA)
    y = cv2.cvtColor(y, cv2.COLOR_BGR2RGB)
    if S > lim:
        y = cv2.resize(y, (S, S), interpolation=cv2.INTER_CUBIC)
    return y


def inpaint(rgb, mask, engine=None):
    H, W = rgb.shape[:2]
    m = mask > 127
    if engine is None:
        engine = "lama" if models_present().get("inpaint") else "opencv"
    out = rgb.copy()
    if not m.any():
        return out, engine
    used = engine
    for box in _components(m):
        y0, y1, x0, x1, side = _crop_box(box, H, W)
        crop = out[y0:y1, x0:x1]
        cm = m[y0:y1, x0:x1]
        ch, cw = crop.shape[:2]
        # 补成正方形（镜像填充，避免黑边影响模型）
        S = max(ch, cw)
        pad_b, pad_r = S - ch, S - cw
        if pad_b or pad_r:
            sq = cv2.copyMakeBorder(crop, 0, pad_b, 0, pad_r, cv2.BORDER_REFLECT_101 if min(ch, cw) > 1 else cv2.BORDER_REPLICATE)
            sm = np.zeros((S, S), bool)
            sm[:ch, :cw] = cm
        else:
            sq, sm = crop, cm
        d = max(2.0, P["dilate"] * S)
        smd = cv2.dilate(sm.astype(np.uint8), _disk(d)).astype(bool)
        res = None
        if used == "lama":
            try:
                res = _run_lama(sq, smd)
            except Exception as e:
                runtime.log(f"[提示] AI 消除失败，改用快速消除：{runtime.errmsg(e)[:200]}")
                used = "opencv"
        if res is None:
            res = _run_opencv(sq, smd)
        res = res[:ch, :cw]
        # 只在（稍微扩大并羽化的）蒙版内贴回
        f = max(1.0, P["feather"] * S)
        w = cv2.GaussianBlur(smd[:ch, :cw].astype(np.float32), (0, 0), f)
        w = np.maximum(w, cm.astype(np.float32))[..., None]
        blended = crop.astype(np.float32) * (1 - w) + res.astype(np.float32) * w
        out[y0:y1, x0:x1] = (blended + 0.5).astype(np.uint8)
    return out, used
