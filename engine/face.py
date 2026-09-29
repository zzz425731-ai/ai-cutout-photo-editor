"""人脸定位：OpenCV YuNet（cv2.FaceDetectorYN）。

detect(rgb) → [{"x","y","w","h","score","landmarks":[[x,y]×5]}]，坐标为输入图像素，按面积从大到小。
landmarks 顺序：右眼、左眼、鼻尖、右嘴角、左嘴角（以照片中人物自身的左右为准）。
"""
import threading

import numpy as np
import cv2

from . import model_path

MAX_SIDE = 1280
SCORE = 0.6
NMS = 0.3

_lock = threading.Lock()
_det = None

try:  # OpenCV 5 的新 DNN 引擎会打印无关警告
    cv2.utils.logging.setLogLevel(cv2.utils.logging.LOG_LEVEL_ERROR)
except Exception:
    pass


def _detector(w, h):
    global _det
    if _det is None:
        # 用内存缓冲区加载：OpenCV 读不了含中文的路径（工具目录名就是中文）
        buf = np.fromfile(model_path("face"), dtype=np.uint8)
        _det = cv2.FaceDetectorYN.create("onnx", buf, np.empty(0, np.uint8), (w, h), SCORE, NMS, 5000)
    else:
        _det.setInputSize((w, h))
    return _det


def _detect_once(bgr, scale):
    h, w = bgr.shape[:2]
    det = _detector(w, h)
    _, res = det.detect(bgr)
    out = []
    if res is None:
        return out
    for r in res:
        x, y, fw, fh = (float(v) / scale for v in r[:4])
        lm = [[float(r[4 + 2 * i]) / scale, float(r[5 + 2 * i]) / scale] for i in range(5)]
        out.append({"x": x, "y": y, "w": fw, "h": fh, "score": float(r[14]), "landmarks": lm})
    return out


def detect(rgb):
    H, W = rgb.shape[:2]
    s = min(1.0, MAX_SIDE / max(H, W))
    if s < 1.0:
        small = cv2.resize(rgb, (max(1, int(round(W * s))), max(1, int(round(H * s)))), interpolation=cv2.INTER_AREA)
    else:
        small = rgb
    sh, sw = small.shape[:2]
    if min(sh, sw) < 16:  # 太小的图 YuNet 没法跑
        return []
    bgr = cv2.cvtColor(small, cv2.COLOR_RGB2BGR)
    with _lock:
        faces = _detect_once(bgr, s)
    # 裁剪到图像范围内
    for f in faces:
        x0, y0 = max(0.0, f["x"]), max(0.0, f["y"])
        x1, y1 = min(float(W), f["x"] + f["w"]), min(float(H), f["y"] + f["h"])
        f["x"], f["y"], f["w"], f["h"] = x0, y0, max(0.0, x1 - x0), max(0.0, y1 - y0)
        f["score"] = round(f["score"], 4)
        for k in ("x", "y", "w", "h"):
            f[k] = round(f[k], 1)
        f["landmarks"] = [[round(p[0], 1), round(p[1], 1)] for p in f["landmarks"]]
    faces = [f for f in faces if f["w"] > 0 and f["h"] > 0]
    faces.sort(key=lambda f: f["w"] * f["h"], reverse=True)
    return faces
