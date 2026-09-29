"""AI抠图P图工具 — 本地服务器（只监听 127.0.0.1）。

用法：python server.py [--port N] [--no-browser]
  默认在 7860..7879 里找第一个空闲端口并自动打开浏览器；
  如果工具已经在运行，就直接打开浏览器到那个地址然后退出。

环境变量（测试用）：
  KT_OUTPUT_DIR   覆盖默认输出文件夹（默认 工具目录\\输出）
  KT_NO_EXPLORER  设为 1 时 /api/open-output 不真的打开资源管理器
"""
import os

# 必须在任何 import numpy 之前：OpenBLAS 默认每个 CPU 线程预留一块内存，内存紧张时 numpy 会直接导入失败
os.environ.setdefault("OPENBLAS_NUM_THREADS", "4")

import argparse
import json
import re
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(ROOT, "web")
OUTPUT_DIR = os.path.abspath(os.environ.get("KT_OUTPUT_DIR") or os.path.join(ROOT, "输出"))
VERSION = "1.0"
PORTS = range(7860, 7880)
MAX_BODY = 256 * 1024 * 1024

MIME = {
    ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon", ".bmp": "image/bmp",
    ".avif": "image/avif",
    ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf",
    ".wasm": "application/wasm",
}

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(errors="replace")
    except Exception:
        pass

try:  # 万一底层库（显卡驱动 / onnxruntime）直接崩溃，至少把出错位置打印到窗口里，方便拍照求助
    import faulthandler
    faulthandler.enable()
except Exception:
    pass


def say(msg=""):
    try:
        print(msg, flush=True)
    except Exception:
        pass


# ----------------------------------------------------------------------------
# 启动检查
# ----------------------------------------------------------------------------
def check_deps():
    missing = []
    for mod, pip_name in (("numpy", "numpy"), ("PIL", "pillow"), ("cv2", "opencv-python-headless"),
                          ("onnxruntime", "onnxruntime-directml")):
        try:
            __import__(mod)
        except Exception:
            missing.append(pip_name)
    if missing:
        say("=" * 60)
        say("  缺少运行所需的组件：" + "、".join(missing))
        say("  请打开「命令提示符」，复制下面这一行运行（需要联网）：")
        say("")
        say("    python -m pip install " + " ".join(missing))
        say("")
        say("  装好后再双击「启动抠图P图工具.bat」。")
        say("=" * 60)
        _pause_on_error()
        sys.exit(1)


def check_models():
    from engine import models_present
    have = models_present()
    if all(have.values()):
        return have
    say("[准备] 第一次使用需要下载 AI 模型（约 460 MB，只需一次），请保持联网……")
    try:
        from engine import download_models
        download_models.main()
    except SystemExit:
        pass
    except Exception as e:
        say(f"[提示] 模型下载失败：{e}")
    have = models_present()
    if not all(have.values()):
        names = {"general": "通用抠图", "portrait": "人像发丝", "inpaint": "消除笔", "face": "人脸定位"}
        say("[提示] 以下功能的模型还没下好，暂时用不了：" + "、".join(names[k] for k, v in have.items() if not v))
        say("       联网后重新启动本工具会自动补下。")
    return have


# ----------------------------------------------------------------------------
# 工具函数
# ----------------------------------------------------------------------------
class ApiError(Exception):
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status = status
        self.msg = msg


# 控制字符、Windows 非法字符、孤立的 UTF-16 代理项（emoji 被截断时会出现，写文件名 / 输出 JSON 都会出错）
_ILLEGAL = re.compile(r'[\\/:*?"<>|\x00-\x1f\x7f\ud800-\udfff]')
_RESERVED = {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "CLOCK$",
             *(f"{d}{i}" for d in ("COM", "LPT") for i in (*"0123456789", "¹", "²", "³"))}


def is_reserved(name):
    """Windows 设备名（CON、nul.png、COM1 .jpg ……）——不能当文件名/文件夹名用。"""
    return name.split(".")[0].rstrip(" ").upper() in _RESERVED


def sanitize_name(name, default="图片", maxlen=120):
    """把用户给的名字变成安全的单个文件名（不含路径、不是设备名、首尾没有空格和点）。"""
    if not isinstance(name, str):
        name = ""
    name = _ILLEGAL.sub("", name)
    name = name.strip(" .　")
    if not name:
        name = default
    if is_reserved(name):
        name = "_" + name
    if len(name) > maxlen:
        base, ext = os.path.splitext(name)
        if len(ext) > 10:
            base, ext = name, ""
        name = base[: max(1, maxlen - len(ext))].rstrip(" .") + ext
    return name


def within(path, root):
    """path 是否在 root 目录里（解析符号链接后）。网络路径一律拒绝（避免去连外部主机）。"""
    if not isinstance(path, str) or not path or "\x00" in path:
        return False
    if path[:2] in ("\\\\", "//", "\\/", "/\\"):
        return False
    try:
        p = os.path.realpath(path)
        r = os.path.realpath(root)
        return os.path.normcase(os.path.commonpath([p, r])) == os.path.normcase(r)
    except Exception:
        return False


def runtime_short(e, n=200):
    try:
        from engine import runtime
        return runtime.short_err(e, n)
    except Exception:
        return str(e)[:n]


def fmt_ms(ms):
    return f"{ms / 1000:.1f} 秒" if ms >= 1000 else f"{ms} 毫秒"


# ----------------------------------------------------------------------------
# API 实现
# ----------------------------------------------------------------------------
def api_status():
    from engine import models_present, runtime
    provider, device = runtime.status()
    return {"ok": True, "version": VERSION, "provider": provider, "device": device,
            "models": models_present(), "output_dir": OUTPUT_DIR}


def _need_model(key, label):
    from engine import models_present
    if not models_present().get(key):
        raise ApiError(503, f"{label}模型文件缺失，请联网后重新启动工具自动下载")


def _image_body(body):
    """单图接口的请求体：约定是图片原始字节；也宽容地接受 dataURL 文本或 {"image": dataURL} JSON。"""
    head = body[:16].lstrip()
    if head[:5].lower() == b"data:" or head[:1] == b"{":
        from engine import imageio
        if head[:1] == b"{":
            return _img_from_json(_json_body(body), "image")
        try:
            data, _ = imageio.parse_data_url(body.strip().decode("ascii"))
        except UnicodeDecodeError:
            raise ApiError(400, "无法识别这张图片，请换一张 JPG / PNG / WEBP 图片试试")
        return data
    return body


def api_matte(body, query):
    from engine import imageio, matting
    mode = (query.get("mode") or ["general"])[0]
    if mode not in ("general", "portrait"):
        raise ApiError(400, "抠图模式只能是 general（通用）或 portrait（人像）")
    dec = (query.get("decontam") or ["1"])[0]
    if dec not in ("0", "1", "true", "false"):
        raise ApiError(400, "decontam 参数只能是 1 或 0")
    decontam = dec in ("1", "true")
    _need_model("general", "抠图")
    warning = None
    if mode == "portrait":
        from engine import models_present
        if not models_present().get("portrait"):
            mode = "general"
            warning = "人像发丝模型暂不可用，已使用通用抠图；联网后重新启动工具可补齐模型"
    t = time.perf_counter()
    rgb = imageio.decode_rgb(_image_body(body))
    alpha, patch = matting.matte(rgb, mode=mode, decontam=decontam)
    # fg 是「去色边补丁」：只含半透明像素的新颜色（RGBA，其余像素透明），fg_rect = [x, y, w, h]；
    # 前端把它画在原图副本上即可。比回传整张前景图小得多、也快得多。
    out = {"mask": imageio.png_data_url(alpha), "fg": None, "fg_rect": None,
           "width": int(rgb.shape[1]), "height": int(rgb.shape[0]),
           "mode": mode, "warning": warning}
    if patch is not None:
        h, w = patch["rgba"].shape[:2]
        out["fg"] = imageio.png_data_url(patch["rgba"])
        out["fg_rect"] = [patch["x"], patch["y"], w, h]
    out["ms"] = int((time.perf_counter() - t) * 1000)
    return out, f"抠图（{'人像' if mode == 'portrait' else '通用'}）"


def api_faces(body, query):
    from engine import face, imageio
    _need_model("face", "人脸定位")
    rgb = imageio.decode_rgb(_image_body(body))
    return {"faces": face.detect(rgb), "width": int(rgb.shape[1]), "height": int(rgb.shape[0])}, "人脸定位"


def _json_body(body):
    try:
        obj = json.loads(body.decode("utf-8-sig"))
    except Exception:
        raise ApiError(400, "请求内容不是有效的 JSON")
    if not isinstance(obj, dict):
        raise ApiError(400, "请求内容格式不正确")
    return obj


def _img_from_json(obj, key, label="图片"):
    from engine import imageio
    v = obj.get(key)
    if not isinstance(v, str) or not v:
        raise ApiError(400, f"缺少{label}数据")
    data, _ = imageio.parse_data_url(v)
    return data


def _num(obj, key, lo, hi, default=0):
    v = obj.get(key, default)
    if v is None:
        v = default
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        try:
            v = float(v)
        except (TypeError, ValueError):
            raise ApiError(400, f"参数 {key} 必须是数字")
    if v != v:  # NaN
        raise ApiError(400, f"参数 {key} 必须是数字")
    return max(lo, min(hi, float(v)))


def _with_alpha(rgb, alpha):
    import numpy as np
    if alpha is None:
        return rgb
    return np.dstack([rgb, alpha])


def api_inpaint(body, query):
    import numpy as np
    import cv2
    from engine import imageio, inpaint
    obj = _json_body(body)
    rgb, alpha = imageio.decode_rgba(_img_from_json(obj, "image"))
    mask = imageio.decode_gray(_img_from_json(obj, "mask", "蒙版"))
    H, W = rgb.shape[:2]
    if mask.shape != (H, W):
        mask = cv2.resize(mask, (W, H), interpolation=cv2.INTER_LINEAR)
    t = time.perf_counter()
    out, engine = inpaint.inpaint(rgb, mask)
    if alpha is not None:  # 透明图：被涂抹处设为不透明
        alpha = np.maximum(alpha, np.where(mask > 127, 255, 0).astype(np.uint8))
    res = {"image": imageio.png_data_url(_with_alpha(out, alpha)), "engine": engine}
    res["ms"] = int((time.perf_counter() - t) * 1000)
    return res, f"消除（{'AI' if engine == 'lama' else '快速'}）"


def api_retouch(body, query):
    import cv2
    from engine import imageio, retouch
    obj = _json_body(body)
    rgb, alpha = imageio.decode_rgba(_img_from_json(obj, "image"))
    smooth = _num(obj, "smooth", 0, 100)
    whiten = _num(obj, "whiten", 0, 100)
    mask = None
    if obj.get("mask"):
        mask = imageio.decode_gray(_img_from_json(obj, "mask", "蒙版"))
        H, W = rgb.shape[:2]
        if mask.shape != (H, W):
            mask = cv2.resize(mask, (W, H), interpolation=cv2.INTER_LINEAR)
    t = time.perf_counter()
    out = retouch.retouch(rgb, smooth, whiten, mask)
    res = {"image": imageio.png_data_url(_with_alpha(out, alpha))}
    res["ms"] = int((time.perf_counter() - t) * 1000)
    return res, "美颜"


_save_lock = threading.Lock()


_IMG_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp")
MAX_PATH_LEN = 250  # 没开「长路径」的 Windows 上完整路径不能超过 260 个字符


def _check_image(data):
    """文件头像图片还不够：让 PIL 解析一下头部，免得把坏数据存成 .png。"""
    from PIL import Image
    import io
    try:
        with Image.open(io.BytesIO(data)) as im:
            ok = im.width >= 1 and im.height >= 1
    except Image.DecompressionBombError:
        ok = True  # 是图片，只是很大——保存不需要解码像素
    except Exception:
        ok = False
    if not ok:
        raise ApiError(400, "保存失败：图片数据已损坏")


def api_save(body, query):
    from engine import imageio
    obj = _json_body(body)
    data = _img_from_json(obj, "data")
    ext = imageio.sniff_ext(data)
    if ext is None:
        raise ApiError(400, "保存失败：数据不是可识别的图片")
    _check_image(data)
    subdir = obj.get("subdir")
    folder = OUTPUT_DIR
    if isinstance(subdir, str) and not subdir.strip():
        subdir = None
    if subdir is not None:
        if not isinstance(subdir, str):
            raise ApiError(400, "子文件夹名称不正确")
        s = subdir.strip()
        if "/" in s or "\\" in s or ":" in s or s.strip(".") == "" or ".." in s or "\x00" in s:
            raise ApiError(400, "子文件夹名称不正确（不能包含路径）")
        room = MAX_PATH_LEN - len(OUTPUT_DIR) - 40  # 给文件名至少留 40 个字符
        if room < 8:
            raise ApiError(500, "输出文件夹的路径太长了，请把工具放到短一点的路径下（例如桌面）")
        folder = os.path.join(OUTPUT_DIR, sanitize_name(s, "批量", min(80, room)))
    if not within(folder, OUTPUT_DIR):
        raise ApiError(400, "子文件夹名称不正确")
    dpi = obj.get("dpi")
    if dpi not in (None, "", 0, False):
        dpi = _num(obj, "dpi", 1, 10000)
        data = imageio.set_dpi(data, dpi)
    fname = obj.get("filename")
    name = sanitize_name(fname if isinstance(fname, str) else "", "图片")
    base, e = os.path.splitext(name)
    e = e.lower()
    aliases = {".jpg": (".jpg", ".jpeg"), ".png": (".png",), ".webp": (".webp",), ".gif": (".gif",), ".bmp": (".bmp",)}
    if e not in aliases[ext]:
        base = name if e not in _IMG_EXTS else base
        e = ext
    # 完整路径别超过 Windows 的 260 字符限制（留出 " (9999)" 的位置）
    room = MAX_PATH_LEN - len(folder) - 1 - len(" (9999)") - len(e)
    if room < 1:
        raise ApiError(500, "输出文件夹的路径太长了，请把工具放到短一点的路径下（例如桌面）")
    base = base[:room].rstrip(" .") or "图片"
    if is_reserved(base):
        base = "_" + base
    try:
        os.makedirs(folder, exist_ok=True)
    except OSError as ex:
        raise ApiError(500, f"无法创建输出文件夹：{ex.strerror or ex}")
    if not os.path.isdir(folder):
        raise ApiError(500, "无法创建输出文件夹（有同名文件挡住了）")
    with _save_lock:
        for i in range(1, 10000):
            fn = f"{base}{e}" if i == 1 else f"{base} ({i}){e}"
            path = os.path.join(folder, fn)
            if not within(path, OUTPUT_DIR):
                raise ApiError(400, "文件名不正确")
            try:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0))
            except FileExistsError:
                continue
            except PermissionError:
                if os.path.exists(path):  # 同名的文件夹 / 正被占用的文件
                    continue
                raise ApiError(500, "保存失败：没有写入输出文件夹的权限")
            except OSError as ex:
                raise ApiError(500, f"保存失败：{ex.strerror or ex}")
            try:
                with os.fdopen(fd, "wb") as f:
                    f.write(data)
            except OSError as ex:
                try:
                    os.remove(path)
                except OSError:
                    pass
                raise ApiError(500, f"保存失败（磁盘满了？）：{ex.strerror or ex}")
            return {"path": path}, f"保存 {fn}"
    raise ApiError(500, "同名文件太多，保存失败")


def api_open_output(body, query):
    obj = _json_body(body) if body.strip() else {}
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    path = obj.get("path")
    target = None
    if path:
        if not isinstance(path, str) or not within(path, OUTPUT_DIR):
            raise ApiError(400, "只能打开输出文件夹里的文件")
        if os.path.exists(path):
            target = os.path.realpath(path)
    if os.environ.get("KT_NO_EXPLORER") != "1":
        try:
            if target and os.path.isfile(target):
                subprocess.Popen(f'explorer /select,"{target}"')
            else:
                os.startfile(target if target and os.path.isdir(target) else OUTPUT_DIR)
        except Exception as e:
            raise ApiError(500, f"无法打开文件夹：{e}")
    return {"ok": True}, None


POST_ROUTES = {
    "/api/matte": api_matte,
    "/api/faces": api_faces,
    "/api/inpaint": api_inpaint,
    "/api/retouch": api_retouch,
    "/api/save": api_save,
    "/api/open-output": api_open_output,
}


# ----------------------------------------------------------------------------
# HTTP
# ----------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "KT"
    sys_version = ""
    timeout = 120  # 秒：连接空闲 / 请求体传一半不动了 → 断开，不让线程永远挂着

    # 标准库 send_error 默认返回英文 HTML；这里统一改成中文 JSON（请求行格式错误、头太长、不支持的方法等）
    _STD_ERRORS = {
        400: "请求格式不正确", 404: "找不到这个文件", 405: "不支持的请求方式", 408: "请求超时",
        411: "请求缺少长度信息", 413: "请求太大了", 414: "网址太长了", 417: "不支持的 Expect 请求头",
        431: "请求头太大了", 500: "服务器内部错误", 501: "不支持的请求方式", 505: "不支持的 HTTP 版本",
    }

    def log_message(self, fmt, *args):  # 不打印每个请求
        pass

    def send_error(self, code, message=None, explain=None):
        msg = self._STD_ERRORS.get(code, "请求出错了")
        try:
            if getattr(self, "request_version", "HTTP/0.9") == "HTTP/0.9" or not hasattr(self, "command"):
                self.request_version = "HTTP/1.1"
            if not getattr(self, "command", None):
                self.command = "GET"
            self._err(code, msg, close=True)
        except Exception:
            self.close_connection = True

    # --- 响应 ---
    def _send(self, status, body, ctype, extra=None, close=False):
        self._responded = True
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        if close:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (ConnectionError, OSError):
                self.close_connection = True

    def _json(self, status, obj, close=False):
        try:
            data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        except UnicodeEncodeError:  # 字符串里有孤立的代理项 → 用 \\uXXXX 转义，仍然是合法 JSON
            data = json.dumps(obj, ensure_ascii=True).encode("ascii")
        self._send(status, data, "application/json; charset=utf-8", close=close)

    def _err(self, status, msg, close=False):
        self._json(status, {"error": msg}, close=close)

    def _oom(self):
        from engine import runtime
        msg = runtime.oom_message()
        say(f"[{time.strftime('%H:%M:%S')}] [提示] {msg}")
        return self._err(503, msg)

    def _reject(self, status, msg):
        """在读请求体之前就要拒绝：小请求体先读掉再回复（否则 Windows 关连接时会发 RST，浏览器看到的是「连接被重置」而不是错误说明）。"""
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = -1
        if 0 < n <= 8 * 1024 * 1024 and "chunked" not in (self.headers.get("Transfer-Encoding") or "").lower():
            self._read_body(n)
        return self._err(status, msg, close=True)

    # --- 检查 ---
    def _host_ok(self):
        hosts = self.headers.get_all("Host") or []
        if len(hosts) != 1:
            return False
        host = hosts[0].strip().lower()
        port = self.server.server_address[1]
        return host in (f"127.0.0.1:{port}", f"localhost:{port}")

    def _guard(self, fn):
        """兜底：任何没想到的异常都回一个中文 JSON 500，而不是直接断开连接。"""
        self._responded = False
        try:
            fn()
        except (ConnectionError, TimeoutError):
            self.close_connection = True
        except Exception as e:
            traceback.print_exc()
            if not self._responded:
                try:
                    self._err(500, f"服务器内部错误：{type(e).__name__}", close=True)
                except Exception:
                    pass
            self.close_connection = True

    # --- 方法 ---
    def do_GET(self):
        self._guard(self._get)

    def do_HEAD(self):
        self._guard(self._get)

    def do_POST(self):
        self._guard(self._post)

    def _get(self):
        if not self._host_ok():
            return self._reject(403, "拒绝访问：请用 http://127.0.0.1 地址打开本工具")
        path = urllib.parse.urlsplit(self.path).path
        if path.startswith("/api/"):
            if path == "/api/status":
                try:
                    return self._json(200, api_status())
                except Exception as e:
                    traceback.print_exc()
                    return self._err(500, f"读取状态失败：{type(e).__name__}")
            if path in POST_ROUTES:
                return self._err(405, "这个接口只能用 POST 调用")
            return self._err(404, "没有这个接口")
        return self._static(path)

    def _post(self):
        if not self._host_ok():
            return self._reject(403, "拒绝访问：请用 http://127.0.0.1 地址打开本工具")
        if self.headers.get("X-KT") != "1":
            return self._reject(403, "拒绝访问：缺少 X-KT 请求头")
        path = urllib.parse.urlsplit(self.path).path
        route = POST_ROUTES.get(path)
        if route is None:
            return self._reject(404, "没有这个接口")
        if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
            return self._err(411, "请求缺少长度信息", close=True)
        lengths = self.headers.get_all("Content-Length") or []
        try:
            if len(set(v.strip() for v in lengths)) != 1:
                raise ValueError
            length = int(lengths[0].strip())
        except ValueError:
            return self._err(411, "请求缺少长度信息", close=True)
        if length < 0:
            return self._err(400, "请求长度不正确", close=True)
        if length > MAX_BODY:
            return self._err(413, "图片太大了（超过 256 MB），请先缩小后再试", close=True)
        body = self._read_body(length)
        if body is None:
            self.close_connection = True
            return
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        t = time.perf_counter()
        try:
            if route in HEAVY:
                with _heavy:
                    res, label = route(body, query)
            else:
                res, label = route(body, query)
        except ApiError as e:
            return self._err(e.status, e.msg)
        except ValueError as e:  # engine.imageio.ImageError 等
            from engine.imageio import ImageError
            if isinstance(e, ImageError):
                return self._err(400, str(e))
            traceback.print_exc()
            return self._err(400, f"处理失败：{runtime_short(e)}")
        except MemoryError:
            return self._oom()
        except Exception as e:
            from engine import runtime
            if runtime.is_oom(e):
                return self._oom()
            traceback.print_exc()
            return self._err(500, f"处理失败：{runtime.short_err(e, 200)}")
        self._json(200, res)
        if label:
            say(f"[{time.strftime('%H:%M:%S')}] {label} 完成，用时 {fmt_ms(int((time.perf_counter() - t) * 1000))}")

    def _read_body(self, length):
        chunks = []
        left = length
        while left > 0:
            try:
                c = self.rfile.read(min(left, 1 << 20))
            except (ConnectionError, OSError):
                return None
            if not c:
                return None
            chunks.append(c)
            left -= len(c)
        return b"".join(chunks)

    def _method_not_allowed(self):
        self._responded = False
        self._reject(405, "不支持的请求方式")

    do_PUT = do_DELETE = do_PATCH = do_OPTIONS = do_TRACE = do_CONNECT = _method_not_allowed

    # --- 静态文件 ---
    def _static(self, path):
        try:
            rel = urllib.parse.unquote(path, errors="strict")
        except UnicodeDecodeError:
            return self._err(400, "路径不正确")
        if rel in ("", "/"):
            rel = "/index.html"
        if "\x00" in rel or "\\" in rel or ":" in rel or "~" in rel:
            return self._err(403, "拒绝访问")
        segs = rel.split("/")
        if any(s in ("..", ".") for s in segs) or rel.startswith("//"):
            return self._err(403, "拒绝访问")
        # Windows 会悄悄去掉结尾的点和空格、把 CON/NUL 当设备 → 一律不认
        if any(s != s.rstrip(" .") or is_reserved(s) for s in segs if s):
            return self._err(404, "找不到这个文件")
        rel = rel.lstrip("/")
        if os.path.isabs(rel):
            return self._err(403, "拒绝访问")
        full = os.path.join(WEB_DIR, *[s for s in rel.split("/") if s])
        if not within(full, WEB_DIR):
            return self._err(403, "拒绝访问")
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        if not os.path.isfile(full):
            return self._err(404, "找不到这个文件")
        ext = os.path.splitext(full)[1].lower()
        try:
            with open(full, "rb") as f:
                data = f.read()
        except OSError:
            return self._err(404, "找不到这个文件")
        self._send(200, data, MIME.get(ext, "application/octet-stream"))


# 同时最多跑 2 个重活（抠图/消除/美颜/人脸）：模型本来就按顺序跑，多了只会让内存（大图的中间结果）翻倍
# 抠图/消除/美颜一次只做一件：单人使用不需要并行，还能把内存峰值压在 1GB 以内（用户电脑常只剩 2GB 空闲内存）
_heavy = threading.BoundedSemaphore(1)
HEAVY = {api_matte, api_inpaint, api_retouch}  # 人脸定位很快，不排队


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False  # Windows 上 SO_REUSEADDR 会让两个进程抢同一个端口
    request_queue_size = 64     # 默认 5：并发一多，Windows 会直接拒绝新连接

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionError, TimeoutError)):
            return
        super().handle_error(request, client_address)


def _is_our_server(port):
    s = socket.socket()
    s.settimeout(0.3)
    try:
        if s.connect_ex(("127.0.0.1", port)) != 0:
            return False
    except OSError:
        return False
    finally:
        s.close()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # 不走系统代理
    try:
        with opener.open(f"http://127.0.0.1:{port}/api/status", timeout=3) as r:
            obj = json.loads(r.read(1 << 16).decode("utf-8"))
        return bool(isinstance(obj, dict) and obj.get("ok") and "models" in obj and "output_dir" in obj)
    except Exception:
        return False


def find_running():
    """已在运行的实例 → 端口号（多个时取最小的），否则 None。
    各端口同时探测：Windows 上连接一个没人监听的本机端口要等到超时，逐个试 20 个端口要 3 秒多。"""
    ports = list(PORTS)
    if not ports:
        return None
    import concurrent.futures as cf
    with cf.ThreadPoolExecutor(min(len(ports), 20)) as ex:
        hits = [p for p, ok in zip(ports, ex.map(_is_our_server, ports)) if ok]
    return min(hits) if hits else None


def _pause_on_error():
    """出错时停一下让用户看清提示；从 .bat 启动时由 .bat 负责 pause（避免按两次回车）。"""
    if os.environ.get("KT_LAUNCHER") == "1":
        return
    try:
        input("按回车键退出……")
    except Exception:
        pass


def open_browser(url):
    import webbrowser
    try:
        webbrowser.open(url)
    except Exception:
        say(f"[提示] 没能自动打开浏览器，请手动在浏览器里打开：{url}")


def background_warmup():
    from engine import runtime, models_present
    have = models_present()
    try:
        if have.get("general"):
            runtime.preload(["general"])
        prov, dev = runtime.status()
        say(f"[就绪] AI 加速：{dev}（{prov}）" if prov != "CPU" else "[就绪] AI 使用 CPU 运行")
        for k in ("portrait",):  # 消除模型（LaMa，走 CPU）第一次用到时再加载，免得一启动就占满 CPU 十几秒
            if have.get(k):
                runtime.preload([k])
        if have.get("face"):
            import numpy as np
            from engine import face
            face.detect(np.zeros((64, 64, 3), np.uint8))
    except Exception as e:
        say(f"[提示] 模型预加载失败：{e}")


def lower_priority():
    """把本进程设成「低于正常」优先级：AI 计算很吃 CPU，这样用户同时在用的其它程序不会卡。"""
    try:
        import ctypes
        k32 = ctypes.WinDLL("kernel32")
        k32.GetCurrentProcess.restype = ctypes.c_void_p
        k32.SetPriorityClass.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        k32.SetPriorityClass(k32.GetCurrentProcess(), 0x4000)  # BELOW_NORMAL_PRIORITY_CLASS
    except Exception:
        pass


def main(argv=None):
    ap = argparse.ArgumentParser(description="AI抠图P图工具 本地服务器")
    ap.add_argument("--port", type=int, default=None, help="指定端口（默认 7860–7879 里第一个空闲的）")
    ap.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    args = ap.parse_args(argv)

    check_deps()
    lower_priority()

    if args.port is None:
        port = find_running()
        if port is not None:
            url = f"http://127.0.0.1:{port}/"
            say(f"工具已经在运行了：{url}")
            if not args.no_browser:
                say("已为你打开浏览器。这个窗口可以关掉。")
                open_browser(url)
            time.sleep(1.5)
            return 0

    check_models()
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    httpd = None
    ports = [args.port] if args.port else list(PORTS)
    for p in ports:
        try:
            httpd = Server(("127.0.0.1", p), Handler)
            break
        except OSError:
            continue
    if httpd is None:
        if args.port:
            say(f"[错误] 端口 {args.port} 被占用，请换一个端口或不指定端口。")
        else:
            say("[错误] 7860–7879 的端口都被占用了，请关掉一些程序后再试。")
        _pause_on_error()
        return 1
    port = httpd.server_address[1]
    url = f"http://127.0.0.1:{port}/"

    from engine import runtime
    cfg = runtime._load_cfg()
    if cfg is not None:
        prov, dev = runtime.status()
        gpu_line = f"{dev}（DirectML 加速）" if prov == "DirectML" else "CPU（没有可用的显卡加速）"
    else:
        gpu_line = "正在检测显卡（首次运行约需半分钟）……"
    say("=" * 60)
    say("  AI抠图P图工具 已启动")
    say(f"  地址：{url}")
    say(f"  显卡/CPU：{gpu_line}")
    say(f"  输出文件夹：{OUTPUT_DIR}")
    say("  关闭这个窗口即可退出。")
    say("=" * 60)

    threading.Thread(target=background_warmup, daemon=True).start()
    if not args.no_browser:
        threading.Timer(0.3, open_browser, args=(url,)).start()
    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
