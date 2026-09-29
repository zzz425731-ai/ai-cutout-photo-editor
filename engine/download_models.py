"""下载 AI 模型到 models 目录。已存在且大小正确的文件会跳过。

用法: python -m engine.download_models        (在工具根目录下运行)
"""
import os
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL_DIR = os.path.join(ROOT, "models")

# (本地文件名, Hugging Face 仓库内路径, 说明)
MODELS = [
    ("birefnet_lite.onnx", "onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model.onnx", "通用抠图 BiRefNet_lite"),
    ("modnet.onnx", "Xenova/modnet/resolve/main/onnx/model.onnx", "人像发丝 MODNet"),
    ("lama_fp32.onnx", "Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx", "消除笔 LaMa"),
    ("yunet.onnx", "opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx", "人脸定位 YuNet"),
]

HOSTS = ["https://huggingface.co", "https://hf-mirror.com"]


def _urlopen(request, timeout):
    try:
        return urllib.request.urlopen(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        error.close()  # HTTPError 也持有响应连接；尝试镜像前先释放
        raise


def _remote_size(url):
    request = urllib.request.Request(url, method="HEAD")
    with _urlopen(request, timeout=30) as response:
        return int(response.headers.get("Content-Length", 0))


def _download(url, dest, label):
    tmp = dest + ".part"
    total = _remote_size(url)
    if os.path.exists(dest) and total and os.path.getsize(dest) == total:
        print(f"[跳过] {label} 已存在")
        return
    done = os.path.getsize(tmp) if os.path.exists(tmp) else 0
    headers = {"Range": f"bytes={done}-"} if done else {}
    request = urllib.request.Request(url, headers=headers)
    with _urlopen(request, timeout=60) as response:
        if done and response.status != 206:  # 服务器不支持续传就从头来
            done = 0
        mode = "ab" if done else "wb"
        last = 0.0
        with open(tmp, mode) as f:
            while chunk := response.read(1 << 20):
                f.write(chunk)
                done += len(chunk)
                now = time.time()
                if now - last > 2:
                    pct = done * 100 / total if total else 0
                    print(f"  {label}: {done / 1e6:.0f}/{total / 1e6:.0f} MB ({pct:.0f}%)", flush=True)
                    last = now
    if total and os.path.getsize(tmp) != total:
        raise IOError(f"{label} 下载不完整")
    os.replace(tmp, dest)
    print(f"[完成] {label}")


def main():
    os.makedirs(MODEL_DIR, exist_ok=True)
    failed = []
    for name, path, label in MODELS:
        dest = os.path.join(MODEL_DIR, name)
        for host in HOSTS:
            try:
                _download(f"{host}/{path}", dest, label)
                break
            except Exception as e:  # 换镜像再试
                print(f"[失败] {label} @ {host}: {e}")
        else:
            failed.append(label)
    if failed:
        print("以下模型没下好，请检查网络后重新运行：" + "、".join(failed))
        sys.exit(1)
    print("全部模型就绪。")


if __name__ == "__main__":
    main()
