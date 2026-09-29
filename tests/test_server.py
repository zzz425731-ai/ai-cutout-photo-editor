"""服务器接口 + 安全测试（纯 assert，直接运行：python tests/test_server.py [关键字...]）。

会在 127.0.0.1:7882（环境变量 KT_TEST_PORT 可改）启动一个测试用服务器（--no-browser），结束时自动关掉。
保存的文件写到 tests/out/server_save/（不会碰真正的「输出」文件夹），不会打开资源管理器。
"""
import base64
import concurrent.futures as cf
import http.client
import io
import json
import os
import shutil
import socket
import subprocess
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
os.environ["NO_PROXY"] = "127.0.0.1,localhost"

import numpy as np
import cv2
from PIL import Image

PORT = int(os.environ.get("KT_TEST_PORT", "7882"))
HOST = f"127.0.0.1:{PORT}"
SAMPLES = os.path.join(ROOT, "tests", "samples")
OUT = os.path.join(ROOT, "tests", "out")
SAVE_DIR = os.path.join(OUT, "server_save")
LOG = os.path.join(OUT, "test_server.log")
_proc = None


# ----------------------------------------------------------------------------
# HTTP 小工具（http.client 不走代理）
# ----------------------------------------------------------------------------
def req(method, path, body=None, headers=None, host=HOST, timeout=300):
    h = {"Host": host}
    if body is not None and not isinstance(body, (bytes, bytearray)):
        body = json.dumps(body).encode("utf-8")
        h["Content-Type"] = "application/json"
    h.update(headers or {})
    c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=timeout)
    try:
        c.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        for k, v in h.items():
            c.putheader(k, v)
        if body is not None:
            c.putheader("Content-Length", str(len(body)))
        c.endheaders()
        if body is not None:
            c.send(body)
        r = c.getresponse()
        data = r.read()
        return r.status, dict(r.getheaders()), data
    finally:
        c.close()


def post(path, body, extra=None):
    h = {"X-KT": "1"}
    if isinstance(body, (bytes, bytearray)):
        h["Content-Type"] = "image/jpeg"
    h.update(extra or {})
    return req("POST", path, body, h)


def js(data):
    return json.loads(data.decode("utf-8"))


def has_cn(s):
    return any("\u4e00" <= ch <= "\u9fff" for ch in s)


def durl(data, mime="image/png"):
    return f"data:{mime};base64," + base64.b64encode(data).decode("ascii")


def undurl(u):
    assert u.startswith("data:image/png;base64,"), u[:40]
    return base64.b64decode(u.split(",", 1)[1])


def sample(name):
    with open(os.path.join(SAMPLES, name), "rb") as f:
        return f.read()


def enc(arr, fmt="PNG", **kw):
    b = io.BytesIO()
    Image.fromarray(arr).save(b, fmt, **kw)
    return b.getvalue()


def decode(png):
    return np.asarray(Image.open(io.BytesIO(png)))


# ----------------------------------------------------------------------------
# 启动 / 关闭测试服务器
# ----------------------------------------------------------------------------
def start_server():
    global _proc
    if os.path.isdir(SAVE_DIR):
        shutil.rmtree(SAVE_DIR, ignore_errors=True)
    env = dict(os.environ, KT_OUTPUT_DIR=SAVE_DIR, KT_NO_EXPLORER="1", PYTHONIOENCODING="utf-8")
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    log = open(LOG, "wb")
    _proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "server.py"), "--port", str(PORT), "--no-browser"],
                             cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, creationflags=flags)
    t0 = time.time()
    while time.time() - t0 < 120:
        if _proc.poll() is not None:
            raise RuntimeError("测试服务器启动失败，见 " + LOG)
        try:
            st, _, _ = req("GET", "/api/status", timeout=2)
            if st == 200:
                return time.time() - t0
        except OSError:
            pass
        time.sleep(0.2)
    raise RuntimeError("测试服务器 120 秒内没有响应")


def stop_server():
    if _proc and _proc.poll() is None:
        _proc.terminate()
        try:
            _proc.wait(10)
        except Exception:
            _proc.kill()


# ----------------------------------------------------------------------------
# 基准：4096×3072 的大图，冷启动（服务器刚起来第一次调用）与热启动
# ----------------------------------------------------------------------------
TIMINGS = {}


def _bench_image():
    im = np.asarray(Image.open(os.path.join(SAMPLES, "portrait-of-woman.jpg")).convert("RGB"))
    h = 3072
    w = int(im.shape[1] * h / im.shape[0])
    im = cv2.resize(im, (w, h), interpolation=cv2.INTER_CUBIC)
    pad = 4096 - w
    im = cv2.copyMakeBorder(im, 0, 0, pad // 2, pad - pad // 2, cv2.BORDER_REFLECT)
    return im


def test_00_bench_cold_warm():
    """必须第一个跑（服务器刚启动时的第一次调用 = 冷启动）。"""
    im = _bench_image()
    jpg = enc(im, "JPEG", quality=92)
    png_url = durl(enc(im, "PNG", compress_level=1))
    H, W = im.shape[:2]
    small = np.zeros((H, W), np.uint8)
    cv2.ellipse(small, (int(W * 0.12), int(H * 0.3)), (160, 220), 0, 0, 360, 255, -1)
    large = np.zeros((H, W), np.uint8)
    cv2.rectangle(large, (int(W * 0.05), int(H * 0.1)), (int(W * 0.35), int(H * 0.9)), 255, -1)
    cases = [
        ("matte general", lambda: post("/api/matte?mode=general&decontam=1", jpg)),
        ("matte portrait", lambda: post("/api/matte?mode=portrait&decontam=1", jpg)),
        ("faces", lambda: post("/api/faces", jpg)),
        ("inpaint small", lambda: post("/api/inpaint", {"image": png_url, "mask": durl(enc(small))})),
        ("inpaint large", lambda: post("/api/inpaint", {"image": png_url, "mask": durl(enc(large))})),
        ("retouch 50/30", lambda: post("/api/retouch", {"image": png_url, "smooth": 50, "whiten": 30, "mask": None})),
    ]
    for name, fn in cases:
        res = []
        for i in range(3):
            t = time.perf_counter()
            st, _, data = fn()
            wall = (time.perf_counter() - t) * 1000
            assert st == 200, (name, st, data[:300])
            srv = js(data).get("ms")
            res.append((wall, srv))
        TIMINGS[name] = {"cold_wall": round(res[0][0]), "cold_server": res[0][1],
                         "warm_wall": round(min(r[0] for r in res[1:])),
                         "warm_server": min((r[1] for r in res[1:] if r[1] is not None), default=None)}
    print("    4096×3072 基准（毫秒；wall = 含上传/下载/编解码的总时间，server = 接口返回的 ms）")
    print(f"    {'接口':18s} {'冷 wall':>8s} {'冷 server':>9s} {'热 wall':>8s} {'热 server':>9s}")
    for k, v in TIMINGS.items():
        print(f"    {k:18s} {v['cold_wall']:>8} {str(v['cold_server']):>9} {v['warm_wall']:>8} {str(v['warm_server']):>9}")
    with open(os.path.join(OUT, "timings.json"), "w", encoding="utf-8") as f:
        json.dump(TIMINGS, f, ensure_ascii=False, indent=2)


# ----------------------------------------------------------------------------
# 基本接口
# ----------------------------------------------------------------------------
def test_status():
    st, hd, data = req("GET", "/api/status")
    assert st == 200
    assert hd.get("Content-Type", "").startswith("application/json")
    assert hd.get("Cache-Control") == "no-store"
    assert "Access-Control-Allow-Origin" not in hd
    o = js(data)
    assert o["ok"] is True and o["version"] == "1.0"
    assert o["provider"] in ("DirectML", "CPU") and isinstance(o["device"], str)
    assert set(o["models"]) == {"general", "portrait", "inpaint", "face"} and all(o["models"].values())
    assert os.path.normcase(o["output_dir"]) == os.path.normcase(os.path.abspath(SAVE_DIR))
    print(f"    {o['provider']} / {o['device']}")


def test_static():
    idx = os.path.join(ROOT, "web", "index.html")
    st, hd, data = req("GET", "/")
    if os.path.isfile(idx):
        assert st == 200 and hd["Content-Type"].startswith("text/html"), (st, hd)
        assert hd.get("Cache-Control") == "no-store"
        with open(idx, "rb") as f:
            assert data == f.read()
    else:
        assert st == 404
    # 找一个 js / css 文件验证 MIME
    for ext, mime in ((".js", "text/javascript"), (".css", "text/css"), (".svg", "image/svg+xml")):
        for dp, _, fs in os.walk(os.path.join(ROOT, "web")):
            f = next((x for x in fs if x.endswith(ext)), None)
            if f:
                rel = os.path.relpath(os.path.join(dp, f), os.path.join(ROOT, "web")).replace("\\", "/")
                st, hd, _ = req("GET", "/" + "/".join(__import__("urllib.parse").parse.quote(p) for p in rel.split("/")))
                assert st == 200 and hd["Content-Type"].startswith(mime), (rel, st, hd.get("Content-Type"))
                break
    st, hd, data = req("GET", "/no/such/file.js")
    assert st == 404 and has_cn(js(data)["error"])


def test_security_host_header():
    for host in ("evil.com", f"evil.com:{PORT}", "127.0.0.1", "127.0.0.1:1234", f"localhost.evil.com:{PORT}", "",
                 f"0.0.0.0:{PORT}", f"[::1]:{PORT}"):
        st, _, data = req("GET", "/api/status", host=host)
        assert st == 403, (host, st)
        assert has_cn(js(data)["error"])
        st, _, _ = req("GET", "/", host=host)
        assert st == 403, host
        st, _, _ = req("POST", "/api/faces", sample("corgi.jpg"), {"X-KT": "1"}, host=host)
        assert st == 403, host
    for host in (f"localhost:{PORT}", f"LOCALHOST:{PORT}", HOST):
        st, _, _ = req("GET", "/api/status", host=host)
        assert st == 200, host


def test_security_xkt_header():
    for hdr in ({}, {"X-KT": "0"}, {"X-KT": ""}, {"X-Kt-Other": "1"}):
        st, hd, data = req("POST", "/api/faces", sample("corgi.jpg"), hdr)
        assert st == 403, (hdr, st)
        assert has_cn(js(data)["error"])
        assert "Access-Control-Allow-Origin" not in hd
    # CORS 预检不给通过
    st, hd, _ = req("OPTIONS", "/api/matte", None, {"Origin": "http://evil.com", "Access-Control-Request-Method": "POST"})
    assert st in (403, 405) and "Access-Control-Allow-Origin" not in hd


def test_security_traversal():
    with open(os.path.join(ROOT, "server.py"), "rb") as f:
        secret = f.read()[:200]
    paths = ["/../server.py", "/%2e%2e/server.py", "/..%2fserver.py", "/%2e%2e%2fserver.py", "/..%5cserver.py",
             "/%2e%2e%5cserver.py", "/css/../../server.py", "/css/%2e%2e/%2e%2e/server.py", "/./../server.py",
             "/C:/Windows/win.ini", "/C:%5CWindows%5Cwin.ini", "//C:/Windows/win.ini", "/%5C%5C127.0.0.1%5Cc$%5Cwindows",
             "/index.html%00.js", "/index.html::$DATA", "/web/../server.py", "/..", "/.%2e/server.py",
             "/" + "%2e%2e/" * 8 + "Windows/win.ini", "/engine/runtime.py", "/models/yunet.onnx"]
    for p in paths:
        st, _, data = req("GET", p)
        assert st in (400, 403, 404), (p, st)
        assert secret not in data, p


def test_security_body_limit():
    s = socket.create_connection(("127.0.0.1", PORT), timeout=10)
    try:
        hdr = (f"POST /api/matte HTTP/1.1\r\nHost: {HOST}\r\nX-KT: 1\r\nContent-Type: image/jpeg\r\n"
               f"Content-Length: {300 * 1024 * 1024}\r\n\r\n").encode()
        s.sendall(hdr + b"\xff\xd8" + b"\0" * 1000)
        buf = b""
        while b"\r\n\r\n" not in buf or len(buf) < 50:
            c = s.recv(65536)
            if not c:
                break
            buf += c
        head, _, body = buf.partition(b"\r\n\r\n")
        assert head.startswith(b"HTTP/1.1 413"), head[:100]
        # 读完剩下的 JSON
        s.settimeout(3)
        try:
            while True:
                c = s.recv(65536)
                if not c:
                    break
                body += c
        except socket.timeout:
            pass
        assert has_cn(json.loads(body.decode("utf-8"))["error"])
    finally:
        s.close()
    # 没有 Content-Length
    s = socket.create_connection(("127.0.0.1", PORT), timeout=10)
    try:
        s.sendall(f"POST /api/faces HTTP/1.1\r\nHost: {HOST}\r\nX-KT: 1\r\nTransfer-Encoding: chunked\r\n\r\n".encode())
        head = s.recv(4096)
        assert head.startswith(b"HTTP/1.1 411"), head[:80]
    finally:
        s.close()
    # 服务器仍然正常
    assert req("GET", "/api/status")[0] == 200


def test_bad_inputs():
    for path in ("/api/matte", "/api/faces"):
        for bad in (b"", b"hello world", b"\x89PNG\r\n\x1a\n" + b"\0" * 64, sample("corgi.jpg")[:300]):
            st, _, data = post(path, bad)
            assert st == 400, (path, bad[:10], st, data[:200])
            assert has_cn(js(data)["error"]), data
    st, _, data = post("/api/matte?mode=abc", sample("corgi.jpg"))
    assert st == 400 and has_cn(js(data)["error"])
    st, _, data = post("/api/matte?decontam=maybe", sample("corgi.jpg"))
    assert st == 400
    for path in ("/api/inpaint", "/api/retouch", "/api/save"):
        st, _, data = post(path, b"{not json")
        assert st == 400 and has_cn(js(data)["error"]), (path, st)
        st, _, data = post(path, b"[1,2,3]")
        assert st == 400, path
        st, _, data = post(path, {"image": "data:image/png;base64,AAAA", "mask": "data:image/png;base64,AAAA",
                                  "data": "data:image/png;base64,AAAA", "filename": "x.png"})
        assert st == 400 and has_cn(js(data)["error"]), (path, st, data[:200])
    img = durl(sample("corgi.jpg"), "image/jpeg")
    st, _, data = post("/api/inpaint", {"image": img})
    assert st == 400 and has_cn(js(data)["error"])
    st, _, data = post("/api/retouch", {"image": img, "smooth": "abc", "whiten": 0})
    assert st == 400 and has_cn(js(data)["error"])
    st, _, data = post("/api/nope", {})
    assert st == 404
    st, _, _ = req("PUT", "/api/matte", b"x", {"X-KT": "1"})
    assert st == 405
    st, _, _ = req("GET", "/api/matte")  # 接口存在但只收 POST
    assert st == 405


# ----------------------------------------------------------------------------
# 功能
# ----------------------------------------------------------------------------
def test_matte():
    for name, mode in (("corgi.jpg", "general"), ("portrait-of-woman.jpg", "portrait")):
        data = sample(name)
        W, H = Image.open(io.BytesIO(data)).size
        st, _, body = post(f"/api/matte?mode={mode}&decontam=1", data)
        assert st == 200, body[:200]
        o = js(body)
        assert o["width"] == W and o["height"] == H and isinstance(o["ms"], int)
        m = Image.open(io.BytesIO(undurl(o["mask"])))
        assert m.mode == "L" and m.size == (W, H)
        # fg = 去色边补丁（RGBA），放在 fg_rect = [x, y, w, h] 处，必须落在图内
        fg = Image.open(io.BytesIO(undurl(o["fg"])))
        x, y, w, h = o["fg_rect"]
        assert fg.mode == "RGBA" and fg.size == (w, h)
        assert 0 <= x and 0 <= y and x + w <= W and y + h <= H
    st, _, body = post("/api/matte?mode=general&decontam=0", sample("butterfly.jpg"))
    assert st == 200 and js(body)["fg"] is None
    st, _, body = post("/api/matte", sample("butterfly.jpg"))  # 默认参数
    assert st == 200 and js(body)["fg"] is not None


def test_faces():
    st, _, body = post("/api/faces", sample("portrait-of-woman.jpg"))
    o = js(body)
    assert st == 200 and len(o["faces"]) == 1 and o["width"] == 2550 and o["height"] == 3188
    f = o["faces"][0]
    assert set(f) == {"x", "y", "w", "h", "score", "landmarks"} and len(f["landmarks"]) == 5
    assert f["score"] >= 0.6
    st, _, body = post("/api/faces", sample("butterfly.jpg"))
    assert st == 200 and js(body)["faces"] == []


def test_inpaint():
    img = np.asarray(Image.open(os.path.join(SAMPLES, "corgi.jpg")).convert("RGB"))
    H, W = img.shape[:2]
    m = np.zeros((H, W), np.uint8)
    cv2.circle(m, (150, 120), 30, 255, -1)
    st, _, body = post("/api/inpaint", {"image": durl(enc(img, "JPEG"), "image/jpeg"), "mask": durl(enc(m))})
    assert st == 200, body[:300]
    o = js(body)
    assert o["engine"] in ("lama", "opencv") and isinstance(o["ms"], int)
    out = decode(undurl(o["image"]))
    assert out.shape == (H, W, 3)
    # 蒙版尺寸不一致也能处理（自动缩放）
    st, _, body = post("/api/inpaint", {"image": durl(enc(img)), "mask": durl(enc(cv2.resize(m, (W // 2, H // 2))))})
    assert st == 200
    # 透明 PNG：保留透明通道
    rgba = np.dstack([img, np.full((H, W), 255, np.uint8)])
    rgba[:20, :20, 3] = 0
    st, _, body = post("/api/inpaint", {"image": durl(enc(rgba)), "mask": durl(enc(m))})
    out = decode(undurl(js(body)["image"]))
    assert st == 200 and out.shape == (H, W, 4) and out[5, 5, 3] == 0


def test_retouch():
    data = sample("portrait-of-woman.jpg")
    st, _, body = post("/api/retouch", {"image": durl(data, "image/jpeg"), "smooth": 50, "whiten": 40, "mask": None})
    assert st == 200, body[:300]
    o = js(body)
    out = decode(undurl(o["image"]))
    assert out.shape == (3188, 2550, 3)
    # 有主体蒙版（全黑）→ 不变
    blank = np.zeros((3188, 2550), np.uint8)
    st, _, body = post("/api/retouch", {"image": durl(data, "image/jpeg"), "smooth": 80, "whiten": 80, "mask": durl(enc(blank))})
    out2 = decode(undurl(js(body)["image"]))
    ref = np.asarray(Image.open(io.BytesIO(data)).convert("RGB"))
    assert st == 200 and np.array_equal(out2, ref)
    # 超出范围的数值会被夹住
    st, _, body = post("/api/retouch", {"image": durl(data, "image/jpeg"), "smooth": 1000, "whiten": -5})
    assert st == 200


def test_save():
    img = np.asarray(Image.open(os.path.join(SAMPLES, "butterfly.jpg")).convert("RGB"))
    png = enc(img)
    jpg = enc(img, "JPEG", quality=90)
    st, _, body = post("/api/save", {"data": durl(png), "filename": "照片_抠图.png", "subdir": None, "dpi": 300})
    assert st == 200, body
    p1 = js(body)["path"]
    assert os.path.dirname(p1) == os.path.abspath(SAVE_DIR) and os.path.basename(p1) == "照片_抠图.png"
    assert round(Image.open(p1).info["dpi"][0]) == 300
    # 不覆盖
    st, _, body = post("/api/save", {"data": durl(png), "filename": "照片_抠图.png"})
    p2 = js(body)["path"]
    assert os.path.basename(p2) == "照片_抠图 (2).png" and os.path.isfile(p1)
    st, _, body = post("/api/save", {"data": durl(png), "filename": "照片_抠图.png"})
    assert os.path.basename(js(body)["path"]) == "照片_抠图 (3).png"
    # 非法字符 / 路径
    for name, expect in (('a<b>:c?"d|e*.png', "abcde.png"), ("..\\..\\evil.png", "evil.png"),
                         ("../../evil.png", "evil (2).png"), ("C:\\Windows\\x.png", "CWindowsx.png"),
                         ("CON.png", "_CON.png"), ("  .hidden.png ", "hidden.png"), ("", "图片.png"),
                         ("tab\tname\n.png", "tabname.png"), ("没有扩展名", "没有扩展名.png"), ("文档.txt", "文档.txt.png")):
        st, _, body = post("/api/save", {"data": durl(png), "filename": name})
        assert st == 200, (name, body)
        p = js(body)["path"]
        assert os.path.dirname(p) == os.path.abspath(SAVE_DIR), p
        assert os.path.basename(p) == expect, (name, os.path.basename(p))
    # 扩展名跟着真实格式走
    st, _, body = post("/api/save", {"data": durl(jpg, "image/jpeg"), "filename": "结果.png", "dpi": 300})
    p = js(body)["path"]
    assert p.endswith("结果.jpg") and round(Image.open(p).info["dpi"][0]) == 300
    st, _, body = post("/api/save", {"data": durl(jpg, "image/jpeg"), "filename": "结果.jpeg"})
    assert js(body)["path"].endswith("结果.jpeg")
    # 很长的名字
    st, _, body = post("/api/save", {"data": durl(png), "filename": "长" * 400 + ".png"})
    assert st == 200 and len(os.path.basename(js(body)["path"])) <= 130
    # 子文件夹
    st, _, body = post("/api/save", {"data": durl(png), "filename": "a.png", "subdir": "批量_20260925_1530"})
    p = js(body)["path"]
    assert st == 200 and os.path.dirname(p) == os.path.join(os.path.abspath(SAVE_DIR), "批量_20260925_1530")
    for bad in ("../evil", "..\\evil", "a/b", "a\\b", "..", ".", "C:\\evil", "C:evil", "/abs", "\\\\server\\share"):
        st, _, body = post("/api/save", {"data": durl(png), "filename": "a.png", "subdir": bad})
        assert st == 400 and has_cn(js(body)["error"]), (bad, st)
    assert not os.path.exists(os.path.join(ROOT, "tests", "out", "evil"))
    assert not os.path.exists(os.path.join(ROOT, "tests", "evil"))
    # 不是图片
    st, _, body = post("/api/save", {"data": "data:text/plain;base64," + base64.b64encode(b"hello").decode(), "filename": "x.png"})
    assert st == 400 and has_cn(js(body)["error"])
    # 并发保存同名文件：都成功、互不覆盖
    with cf.ThreadPoolExecutor(8) as ex:
        paths = list(ex.map(lambda _: js(post("/api/save", {"data": durl(png), "filename": "并发.png"})[2])["path"], range(8)))
    assert len(set(paths)) == 8


def test_open_output():
    st, _, body = post("/api/open-output", {})
    assert st == 200 and js(body) == {"ok": True}
    st, _, body = post("/api/open-output", b"")
    assert st == 200
    st, _, body = post("/api/save", {"data": durl(sample("butterfly.jpg"), "image/jpeg"), "filename": "open.jpg"})
    st, _, body = post("/api/open-output", {"path": js(body)["path"]})
    assert st == 200
    for bad in ("C:\\Windows\\win.ini", os.path.join(SAVE_DIR, "..", "..", "server.py"), "\\\\evil\\share\\x"):
        st, _, body = post("/api/open-output", {"path": bad})
        assert st == 400 and has_cn(js(body)["error"]), bad


def test_robust_formats():
    base = np.asarray(Image.open(os.path.join(SAMPLES, "corgi.jpg")).convert("RGB"))
    H, W = base.shape[:2]
    variants = {
        "灰度 PNG": enc(np.asarray(Image.fromarray(base).convert("L"))),
        "16 位灰度 PNG": enc(np.asarray(Image.fromarray(base).convert("L")).astype(np.uint16) * 257),
        "带透明 PNG": enc(np.dstack([base, np.full((H, W), 200, np.uint8)])),
        "WEBP": enc(base, "WEBP"),
    }
    b = io.BytesIO()
    Image.fromarray(base).convert("CMYK").save(b, "JPEG")
    variants["CMYK JPEG"] = b.getvalue()
    for k, data in variants.items():
        st, _, body = post("/api/matte?mode=general", data)
        assert st == 200, (k, body[:200])
        o = js(body)
        assert (o["width"], o["height"]) == (W, H), k
    # EXIF 旋转
    exif = Image.Exif()
    exif[0x0112] = 6
    b = io.BytesIO()
    Image.fromarray(base).save(b, "JPEG", exif=exif.tobytes())
    o = js(post("/api/matte", b.getvalue())[2])
    assert (o["width"], o["height"]) == (H, W)
    # 极小
    tiny = enc(np.full((16, 16, 3), 120, np.uint8))
    for path in ("/api/matte?mode=portrait", "/api/faces"):
        st, _, body = post(path, tiny)
        assert st == 200, (path, body[:200])
    st, _, body = post("/api/inpaint", {"image": durl(tiny), "mask": durl(enc(np.full((16, 16), 255, np.uint8)))})
    assert st == 200
    st, _, body = post("/api/retouch", {"image": durl(tiny), "smooth": 50, "whiten": 50})
    assert st == 200
    # 6000×4000
    big = cv2.resize(np.asarray(Image.open(os.path.join(SAMPLES, "young-man-standing-and-leaning-on-car.jpg")).convert("RGB")),
                     (4000, 6000), interpolation=cv2.INTER_LINEAR)
    data = enc(big, "JPEG", quality=90)
    t = time.perf_counter()
    st, _, body = post("/api/matte?mode=portrait", data)
    o = js(body)
    assert st == 200 and (o["width"], o["height"]) == (4000, 6000), body[:200]
    print(f"    6000×4000 人像抠图（含传输）{(time.perf_counter() - t) * 1000:.0f} ms")
    st, _, body = post("/api/faces", data)
    assert st == 200 and len(js(body)["faces"]) >= 1


def test_concurrent():
    corgi = sample("corgi.jpg")
    portrait = sample("portrait-of-woman.jpg")
    m = np.zeros((410, 614), np.uint8)
    cv2.circle(m, (300, 200), 40, 255, -1)
    jobs = [
        lambda: post("/api/matte?mode=general", corgi),
        lambda: post("/api/matte?mode=portrait", portrait),
        lambda: post("/api/faces", portrait),
        lambda: post("/api/faces", corgi),
        lambda: post("/api/inpaint", {"image": durl(corgi, "image/jpeg"), "mask": durl(enc(m))}),
        lambda: post("/api/retouch", {"image": durl(portrait, "image/jpeg"), "smooth": 40, "whiten": 20}),
        lambda: req("GET", "/api/status"),
        lambda: post("/api/matte?mode=general", corgi),
    ]
    t = time.perf_counter()
    with cf.ThreadPoolExecutor(len(jobs)) as ex:
        res = list(ex.map(lambda f: f(), jobs))
    for st, _, body in res:
        assert st == 200, body[:300]
    print(f"    8 个并发请求全部成功，用时 {(time.perf_counter() - t):.1f} 秒")


def test_single_instance_detection():
    import server
    server.PORTS = [PORT - 1, PORT]
    assert server.find_running() == PORT
    server.PORTS = [PORT - 1]
    assert server.find_running() is None


def main(argv):
    tests = sorted((k, v) for k, v in globals().items() if k.startswith("test_") and callable(v))
    if argv:
        tests = [(k, v) for k, v in tests if any(a in k for a in argv)]
    failed = []
    print("[启动] 测试服务器 127.0.0.1:%d ……" % PORT)
    try:
        print(f"[就绪] 用时 {start_server():.1f} 秒")
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
    finally:
        stop_server()
    print("=" * 60)
    print(f"共 {len(tests)} 项，失败 {len(failed)} 项")
    if failed:
        print("失败：" + "、".join(failed) + f"（服务器日志：{LOG}）")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
