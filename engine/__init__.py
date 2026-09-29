"""AI抠图P图工具 — 本地 AI 引擎（抠图 / 消除 / 人脸 / 美颜）。

子模块按需导入，避免启动时就加载所有依赖：
    from engine import matting, inpaint, face, retouch, imageio, runtime
"""
import os

# numpy 自带的 OpenBLAS 默认按 CPU 线程数（本机 32）各预留一块缓冲区，内存紧张时 import numpy 直接失败；
# 引擎几乎不用 BLAS，限制成 4 线程即可（必须在第一次 import numpy 之前设置）。
os.environ.setdefault("OPENBLAS_NUM_THREADS", "4")

ROOT =os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_DIR = os.path.join(ROOT, "models")
ENGINE_DIR = os.path.dirname(os.path.abspath(__file__))

MODEL_FILES = {
    "general": "birefnet_lite.onnx",
    "portrait": "modnet.onnx",
    "inpaint": "lama_fp32.onnx",
    "face": "yunet.onnx",
}


# 显卡（DirectML）上改用的混合精度版本：由 fp32 原模型现场转换（engine/tofp16.py），不需要另外下载
FP16_FILES = {
    "general": "birefnet_lite_fp16.onnx",
}


def model_path(key):
    return os.path.join(MODEL_DIR, MODEL_FILES[key])


def gpu_model_path(key):
    """DirectML 用的模型路径：有 fp16 版本就用它（缺了就从 fp32 现场转换），否则用原模型。"""
    name = FP16_FILES.get(key)
    if not name:
        return model_path(key)
    p = os.path.join(MODEL_DIR, name)
    if not (os.path.isfile(p) and os.path.getsize(p) > 1024):
        from .tofp16 import convert_file
        convert_file(model_path(key), p)
    return p


def models_present():
    """{"general": bool, ...} — 模型文件是否存在（且不是空文件）。"""
    out = {}
    for k in MODEL_FILES:
        p = model_path(k)
        out[k] = os.path.isfile(p) and os.path.getsize(p) > 1024
    return out
