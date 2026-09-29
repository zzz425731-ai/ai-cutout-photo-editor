"""图片编解码：bytes / dataURL <-> numpy（RGB uint8），以及无损写入 DPI。"""
import base64
import binascii
import io
import re
import struct
import zlib

import numpy as np
from PIL import Image, ImageOps

import cv2

MAX_PIXELS = 80_000_000          # 约 8900×8900；再大就拒绝（防止解压炸弹把内存吃光）
Image.MAX_IMAGE_PIXELS = MAX_PIXELS


class ImageError(ValueError):
    """带中文说明的图片错误（server 会转成 400）。"""


_DATAURL_RE = re.compile(r"^data:([\w.+-]+/[\w.+-]+)?((?:;[\w-]+=[^;,]*)*)(;base64)?,", re.I)


def parse_data_url(s):
    """dataURL → (bytes, mime)。也接受纯 base64。"""
    if not isinstance(s, str) or not s:
        raise ImageError("图片数据为空")
    m = _DATAURL_RE.match(s[:256])
    if m:
        mime = (m.group(1) or "application/octet-stream").lower()
        payload = s[m.end():]
        if not m.group(3):
            from urllib.parse import unquote_to_bytes
            return unquote_to_bytes(payload), mime
    else:
        mime, payload = "", s
    try:
        return base64.b64decode(payload, validate=False), mime
    except (binascii.Error, ValueError):
        raise ImageError("图片数据不是有效的 base64")


def to_data_url(data, mime="image/png"):
    return f"data:{mime};base64," + base64.b64encode(data).decode("ascii")


def _to_uint8(arr):
    if arr.dtype == np.uint8:
        return arr
    if arr.dtype == np.uint16:
        return (arr.astype(np.uint32) * 255 + 32767) // 65535
    if arr.dtype in (np.int32, np.int64, np.uint32):  # PIL 的 "I" 模式（16 位灰度 PNG）
        mx = int(arr.max()) if arr.size else 0
        if mx > 255:
            return np.clip((arr.astype(np.float64) * 255.0 / 65535.0).round(), 0, 255)
        return np.clip(arr, 0, 255)
    if arr.dtype in (np.float32, np.float64):         # "F" 模式
        mx = float(arr.max()) if arr.size else 0
        scale = 255.0 if mx <= 1.0 else 1.0
        return np.clip(arr * scale, 0, 255).round()
    if arr.dtype == bool:
        return arr.astype(np.uint8) * 255
    return np.clip(arr, 0, 255)


def _open(data):
    if not data:
        raise ImageError("没有收到图片数据")
    try:
        im = Image.open(io.BytesIO(data))
        im.load()
    except Image.DecompressionBombError:
        raise ImageError("图片太大了（像素过多），请先缩小后再试")
    except Exception:
        raise ImageError("无法识别这张图片，请换一张 JPG / PNG / WEBP 图片试试")
    if im.width * im.height > MAX_PIXELS:
        raise ImageError("图片太大了（像素过多），请先缩小后再试")
    if im.width < 1 or im.height < 1:
        raise ImageError("图片尺寸不正确")
    try:
        im = ImageOps.exif_transpose(im)  # 按 EXIF 方向摆正（与浏览器显示一致）
    except Exception:
        pass
    return im


def decode_rgba(data):
    """bytes → (rgb uint8 HxWx3, alpha uint8 HxW 或 None)。支持灰度/CMYK/16 位/调色板/带透明。"""
    im = _open(data)
    mode = im.mode
    alpha = None
    if mode in ("RGBA", "LA", "PA") or (mode == "P" and "transparency" in im.info) or \
            (mode in ("RGB", "L") and "transparency" in im.info):
        rgba = im.convert("RGBA")
        arr = np.asarray(rgba)
        rgb, alpha = np.ascontiguousarray(arr[..., :3]), np.ascontiguousarray(arr[..., 3])
        if alpha.min() == 255:
            alpha = None
        return rgb, alpha
    if mode in ("I;16", "I;16B", "I;16L", "I", "F"):
        g = _to_uint8(np.asarray(im)).astype(np.uint8)
        return np.ascontiguousarray(np.repeat(g[..., None], 3, axis=2)), None
    if mode != "RGB":
        im = im.convert("RGB")  # L / 1 / P / CMYK / YCbCr / LAB ...
    arr = np.asarray(im)
    if arr.dtype != np.uint8:
        arr = _to_uint8(arr).astype(np.uint8)
    return np.ascontiguousarray(arr), None


def decode_rgb(data, bg=(255, 255, 255)):
    """bytes → RGB uint8。带透明通道的图合成到白底上（AI 模型只吃不透明图）。"""
    rgb, alpha = decode_rgba(data)
    if alpha is not None:
        a = alpha.astype(np.float32)[..., None] / 255.0
        rgb = (rgb.astype(np.float32) * a + np.array(bg, np.float32) * (1 - a) + 0.5).astype(np.uint8)
    return rgb


def decode_gray(data):
    """bytes → 灰度 uint8（蒙版用）。带透明的 PNG：透明处视为 0。"""
    rgb, alpha = decode_rgba(data)
    g = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    if alpha is not None:
        # 前端可能用 alpha 表示蒙版（RGB 黑、alpha=蒙版）：取 亮度 与 alpha 中「更像蒙版」的那一个
        if int(g.max()) == 0:
            return alpha
        g = ((g.astype(np.uint16) * alpha.astype(np.uint16) + 127) // 255).astype(np.uint8)
    return g


def encode_png(arr, level=1):
    """numpy（HxW 灰度 / HxWx3 RGB / HxWx4 RGBA）→ PNG bytes。用 OpenCV 低压缩级别，速度快。"""
    arr = np.ascontiguousarray(arr)
    if arr.ndim == 3 and arr.shape[2] == 3:
        arr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
    elif arr.ndim == 3 and arr.shape[2] == 4:
        arr = cv2.cvtColor(arr, cv2.COLOR_RGBA2BGRA)
    ok, buf = cv2.imencode(".png", arr, [cv2.IMWRITE_PNG_COMPRESSION, int(level)])
    if not ok:
        raise ImageError("图片编码失败")
    return buf.tobytes()


def png_data_url(arr, level=1):
    return to_data_url(encode_png(arr, level), "image/png")


def sniff_ext(data):
    """根据文件头判断格式 → ".png" / ".jpg" / ".webp" / ".gif" / ".bmp" / None。"""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if data[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return ".gif"
    if data[:2] == b"BM":
        return ".bmp"
    return None


# ----------------------------------------------------------------------------
# DPI：直接改文件头，不重新编码（JPEG 不掉画质，PNG 不改像素）
# ----------------------------------------------------------------------------
def _png_set_dpi(data, dpi):
    ppm = int(round(dpi / 0.0254))
    body = struct.pack(">IIB", ppm, ppm, 1)
    chunk = struct.pack(">I", len(body)) + b"pHYs" + body + struct.pack(">I", zlib.crc32(b"pHYs" + body) & 0xFFFFFFFF)
    out = bytearray(data[:8])
    pos = 8
    inserted = False
    while pos + 8 <= len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        ctype = data[pos + 4:pos + 8]
        end = pos + 12 + length
        if end > len(data):
            raise ImageError("PNG 文件不完整")
        if ctype == b"pHYs":
            pos = end
            continue  # 丢掉旧的
        if ctype == b"IDAT" and not inserted:
            out += chunk
            inserted = True
        out += data[pos:end]
        pos = end
        if ctype == b"IEND":
            break
    if not inserted:
        raise ImageError("PNG 文件不完整")
    return bytes(out)


def _jpeg_set_dpi(data, dpi):
    d = int(max(1, min(65535, round(dpi))))
    if data[2:4] == b"\xff\xe0" and data[6:11] == b"JFIF\x00":
        b = bytearray(data)
        # APP0: FFE0 len(2) 'JFIF\0' ver(2) units(1) Xdensity(2) Ydensity(2)
        b[13] = 1
        b[14:16] = struct.pack(">H", d)
        b[16:18] = struct.pack(">H", d)
        return bytes(b)
    app0 = b"\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00\x01\x01" + b"\x01" + struct.pack(">HH", d, d) + b"\x00\x00"
    return data[:2] + app0 + data[2:]


def set_dpi(data, dpi):
    """给 PNG/JPEG 写入 DPI；其它格式原样返回。"""
    try:
        dpi = float(dpi)
    except (TypeError, ValueError):
        return data
    if not (1 <= dpi <= 10000):
        return data
    ext = sniff_ext(data)
    if ext == ".png":
        return _png_set_dpi(data, dpi)
    if ext == ".jpg":
        return _jpeg_set_dpi(data, dpi)
    return data
