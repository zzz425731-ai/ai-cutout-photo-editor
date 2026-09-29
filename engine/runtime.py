"""ONNX Runtime 会话工厂：DirectML（自动挑最快且结果正确的显卡）→ CPU 兜底。

- 混合显卡笔记本（AMD 核显 + NVIDIA 独显）上 DirectML 的 device_id 0 往往是核显，
  所以启动时对每个 DXGI 适配器跑一次 BiRefNet，挑「最快且与 CPU 结果一致」的那个，
  结果缓存到 engine/device.json（删掉该文件即可重新检测）。
- 每个模型第一次在 DirectML 上用时，都会和 CPU 跑同一份测试输入比对一次；
  出错或差异过大就让该模型改走 CPU（同样记在 device.json 里）。
- 会话按需创建并缓存；每个模型一把锁，串行执行。
"""
import ctypes
import json
import os
import threading
import time
import uuid

import numpy as np

from . import ENGINE_DIR, gpu_model_path, model_path

DEVICE_JSON = os.path.join(ENGINE_DIR, "device.json")
CFG_VERSION = 2

# 与 CPU 结果比对的容差（输出先归一到 0..1 再比较）
TOL_MEAN = 0.01   # 平均绝对误差
TOL_P999 = 0.15   # 99.9 分位绝对误差

_cfg_lock = threading.RLock()
_cfg = None                       # device.json 内容
_probe_lock = threading.Lock()
_probing = False

_sessions = {}                    # (key, provider) -> InferenceSession
_session_locks = {}               # key -> Lock（创建会话用）
_run_locks = {}                   # key -> Lock（执行用）
_runtime_cpu = set()              # 本次运行中因报错临时改走 CPU 的模型
_global_lock = threading.Lock()
# 同一块显卡上「创建 DirectML 会话」和「另一个会话正在推理」同时发生会让 onnxruntime 访问冲突崩溃
# （实测：后台预加载 LaMa/MODNet 的同时来了抠图请求 → access violation），所以显卡上的操作一律排队。
_dml_lock = threading.RLock()

_ort = None


def ort():
    global _ort
    if _ort is None:
        import onnxruntime
        try:
            onnxruntime.set_default_logger_severity(4)  # 错误由我们自己用中文提示
        except Exception:
            pass
        _ort = onnxruntime
    return _ort


def errmsg(e):
    """ORT 在中文 Windows 上的报错是 GBK 编码，pybind 解码失败会变成 UnicodeDecodeError。"""
    if isinstance(e, UnicodeDecodeError) and isinstance(e.object, (bytes, bytearray)):
        return bytes(e.object).decode("gbk", "replace")
    return str(e)


def short_err(e, n=300):
    """报错太长时保留开头和结尾（DirectML 的 HRESULT 在最后）。"""
    s = errmsg(e)
    return s if len(s) <= n else s[: n // 2] + " … " + s[-n // 2:]


# ----------------------------------------------------------------------------
# 内存不足
# ----------------------------------------------------------------------------
class OutOfMemory(MemoryError):
    """内存（或显存）不够：不是模型/显卡的问题，不要因此把模型永久改到 CPU。"""


_OOM_MARKERS = ("bad allocation", "bad_alloc", "e_outofmemory", "8007000e", "failed to allocate",
                "not enough memory", "insufficient memory", "out of memory", "outofmemory",
                "memory allocation", "cannot allocate")


def is_oom(e):
    if isinstance(e, MemoryError):
        return True
    s = errmsg(e).lower()
    return any(m in s for m in _OOM_MARKERS)


class _MEMSTATUSEX(ctypes.Structure):
    _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]


def memory_info():
    """{"commit_free_mb", "commit_total_mb", "phys_free_mb", "phys_total_mb"}；取不到时返回 None。
    commit（提交内存 = 物理内存 + 页面文件）才是「还能申请多少内存」的真正上限。"""
    if os.name != "nt":
        return None
    try:
        m = _MEMSTATUSEX()
        m.dwLength = ctypes.sizeof(m)
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m)):
            return None
        mb = 1 << 20
        return {"commit_free_mb": m.ullAvailPageFile // mb, "commit_total_mb": m.ullTotalPageFile // mb,
                "phys_free_mb": m.ullAvailPhys // mb, "phys_total_mb": m.ullTotalPhys // mb}
    except Exception:
        return None


class _PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [("dwSize", ctypes.c_ulong), ("cntUsage", ctypes.c_ulong), ("th32ProcessID", ctypes.c_ulong),
                ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", ctypes.c_ulong),
                ("cntThreads", ctypes.c_ulong), ("th32ParentProcessID", ctypes.c_ulong),
                ("pcPriClassBase", ctypes.c_long), ("dwFlags", ctypes.c_ulong), ("szExeFile", ctypes.c_wchar * 260)]


def _top_handle_process():
    """句柄数最多的进程 (名字, 句柄数)。某个程序泄漏共享内存时，句柄数通常会涨到几十万。"""
    best = (None, 0)
    if os.name != "nt":
        return best
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateToolhelp32Snapshot.restype = ctypes.c_void_p
    k32.OpenProcess.restype = ctypes.c_void_p
    snap = k32.CreateToolhelp32Snapshot(2, 0)  # TH32CS_SNAPPROCESS
    if not snap or snap == ctypes.c_void_p(-1).value:
        return best
    try:
        e = _PROCESSENTRY32W()
        e.dwSize = ctypes.sizeof(e)
        ok = k32.Process32FirstW(ctypes.c_void_p(snap), ctypes.byref(e))
        while ok:
            h = k32.OpenProcess(0x1000, False, e.th32ProcessID)  # PROCESS_QUERY_LIMITED_INFORMATION
            if h:
                cnt = ctypes.c_ulong()
                if k32.GetProcessHandleCount(ctypes.c_void_p(h), ctypes.byref(cnt)) and cnt.value > best[1]:
                    best = (e.szExeFile, cnt.value)
                k32.CloseHandle(ctypes.c_void_p(h))
            ok = k32.Process32NextW(ctypes.c_void_p(snap), ctypes.byref(e))
    except Exception:
        pass
    finally:
        k32.CloseHandle(ctypes.c_void_p(snap))
    return best


LOW_MEM_MB = 2500   # 可用提交内存低于此值时提示（BiRefNet + LaMa 同时工作大约要 2 GB）


def low_memory_hint(threshold_mb=LOW_MEM_MB):
    """内存紧张时返回一句中文提示（说明可能的原因），否则 None。"""
    info = memory_info()
    if not info or info["commit_free_mb"] >= threshold_mb:
        return None
    msg = f"电脑可用内存只剩约 {info['commit_free_mb'] / 1024:.1f} GB"
    name, cnt = _top_handle_process()
    if name and cnt > 150000:
        msg += (f"。程序「{name}」占用了 {cnt // 10000} 万个系统资源（多半是它长时间运行后内存泄漏），"
                f"请先退出或重启「{name}」，或者重启电脑，再使用本工具")
    else:
        msg += "，请关闭一些不用的程序（或重启电脑）后再试"
    return msg


def oom_message():
    hint = low_memory_hint(threshold_mb=1 << 30)  # 总是给出原因
    return "电脑内存不足，AI 处理失败。" + (hint + "。" if hint else "请关闭一些程序后再试。")


def log(msg):
    try:
        print(msg, flush=True)
    except Exception:
        pass


# ----------------------------------------------------------------------------
# DXGI 适配器枚举（与 DirectML EP 的 device_id 顺序一致：EnumAdapters1(i)）
# ----------------------------------------------------------------------------
class _GUID(ctypes.Structure):
    _fields_ = [("Data1", ctypes.c_ulong), ("Data2", ctypes.c_ushort),
                ("Data3", ctypes.c_ushort), ("Data4", ctypes.c_ubyte * 8)]


def _guid(s):
    u = uuid.UUID(s)
    g = _GUID()
    g.Data1, g.Data2, g.Data3 = u.fields[0], u.fields[1], u.fields[2]
    for i, b in enumerate(u.bytes[8:]):
        g.Data4[i] = b
    return g


class _LUID(ctypes.Structure):
    _fields_ = [("LowPart", ctypes.c_ulong), ("HighPart", ctypes.c_long)]


class _DXGI_ADAPTER_DESC1(ctypes.Structure):
    _fields_ = [("Description", ctypes.c_wchar * 128),
                ("VendorId", ctypes.c_uint), ("DeviceId", ctypes.c_uint),
                ("SubSysId", ctypes.c_uint), ("Revision", ctypes.c_uint),
                ("DedicatedVideoMemory", ctypes.c_size_t),
                ("DedicatedSystemMemory", ctypes.c_size_t),
                ("SharedSystemMemory", ctypes.c_size_t),
                ("AdapterLuid", _LUID), ("Flags", ctypes.c_uint)]


_VENDORS = {0x10DE: "NVIDIA", 0x1002: "AMD", 0x1022: "AMD", 0x8086: "Intel", 0x1414: "Microsoft"}


def list_adapters():
    """返回 [{"index", "name", "vendor", "vram_mb", "software"}]，顺序即 DirectML device_id。"""
    out = []
    if os.name != "nt":
        return out
    try:
        dxgi = ctypes.WinDLL("dxgi")
        factory = ctypes.c_void_p()
        iid = _guid("770aae78-f26f-4dba-a829-253c83d1b387")  # IID_IDXGIFactory1
        dxgi.CreateDXGIFactory1.restype = ctypes.c_long
        hr = dxgi.CreateDXGIFactory1(ctypes.byref(iid), ctypes.byref(factory))
        if hr < 0 or not factory:
            return out
        fvt = ctypes.cast(factory, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
        enum_adapters1 = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p, ctypes.c_uint,
                                            ctypes.POINTER(ctypes.c_void_p))(fvt[12])
        release = ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)
        for i in range(16):
            adapter = ctypes.c_void_p()
            if enum_adapters1(factory, i, ctypes.byref(adapter)) < 0 or not adapter:
                break
            avt = ctypes.cast(adapter, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
            get_desc1 = ctypes.WINFUNCTYPE(ctypes.c_long, ctypes.c_void_p,
                                           ctypes.POINTER(_DXGI_ADAPTER_DESC1))(avt[10])
            desc = _DXGI_ADAPTER_DESC1()
            if get_desc1(adapter, ctypes.byref(desc)) >= 0:
                out.append({
                    "index": i,
                    "name": desc.Description.strip(),
                    "vendor": _VENDORS.get(desc.VendorId, hex(desc.VendorId)),
                    "vram_mb": int(desc.DedicatedVideoMemory // (1 << 20)),
                    "software": bool(desc.Flags & 2) or desc.VendorId == 0x1414,
                })
            release(avt[2])(adapter)
        release(fvt[2])(factory)
    except Exception as e:  # pragma: no cover - 仅在奇怪的系统上
        log(f"[提示] 读取显卡列表失败：{e}")
    return out


def _adapter_signature(adapters):
    return [f'{a["name"]}|{a["vram_mb"]}' for a in adapters]


# ----------------------------------------------------------------------------
# 配置（device.json）
# ----------------------------------------------------------------------------
def _load_cfg():
    global _cfg
    with _cfg_lock:
        if _cfg is not None:
            return _cfg
        cfg = None
        try:
            with open(DEVICE_JSON, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            if cfg.get("version") != CFG_VERSION or cfg.get("ort") != ort().__version__:
                cfg = None
            elif cfg.get("adapters_sig") != _adapter_signature(list_adapters()):
                cfg = None  # 换了显卡/驱动，重新检测
        except Exception:
            cfg = None
        _cfg = cfg
        return _cfg


def _save_cfg(cfg):
    global _cfg
    with _cfg_lock:
        _cfg = cfg
        if cfg.get("_tentative"):
            return
        tmp = DEVICE_JSON + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(cfg, f, ensure_ascii=False, indent=2)
            os.replace(tmp, DEVICE_JSON)
        except Exception as e:
            log(f"[提示] 无法写入 {DEVICE_JSON}：{e}")


def dml_available():
    try:
        return "DmlExecutionProvider" in ort().get_available_providers()
    except Exception:
        return False


# ----------------------------------------------------------------------------
# 会话
# ----------------------------------------------------------------------------
def _make_session(key, provider, device_id=0):
    o = ort()
    so = o.SessionOptions()
    so.graph_optimization_level = o.GraphOptimizationLevel.ORT_ENABLE_ALL
    so.log_severity_level = 4
    if provider == "dml":
        so.enable_mem_pattern = False
        so.execution_mode = o.ExecutionMode.ORT_SEQUENTIAL
        # DirectML 的图融合会给 BiRefNet 申请超大的融合缓冲区 → E_OUTOFMEMORY（8GB 显存也不够）；
        # 关掉融合后逐算子执行，结果正确且 RTX 5060 上约 0.7–1.5 秒。
        so.add_session_config_entry("ep.dml.disable_graph_fusion", "1")
        providers = [("DmlExecutionProvider", {"device_id": str(int(device_id))}), "CPUExecutionProvider"]
        # BiRefNet 用 fp16 版本：fp32 要约 10GB 显存，不够时挤占系统内存导致整机卡顿
        path = gpu_model_path(key)
    else:
        # 不用 CPU 内存池：每次运行完把大块中间结果还给系统（BiRefNet 在 CPU 上峰值好几 GB）
        so.enable_cpu_mem_arena = False
        # 不占满所有核心：用户同时在用电脑，留一半给其它程序（本机 16 核 32 线程 → 8 线程）
        so.intra_op_num_threads = max(2, min(8, (os.cpu_count() or 4) // 2))
        providers = ["CPUExecutionProvider"]
        path = model_path(key)
        return o.InferenceSession(path, sess_options=so, providers=providers)
    with _dml_lock:
        return o.InferenceSession(path, sess_options=so, providers=providers)


def _run_session(sess, feeds):
    """执行会话；DirectML 会话在显卡锁内执行。"""
    if "DmlExecutionProvider" in sess.get_providers():
        with _dml_lock:
            return sess.run(None, feeds)
    return sess.run(None, feeds)


def _test_image(size_hw):
    """确定性的测试图：真实样张（若在）否则合成图。返回 RGB uint8。"""
    import cv2
    h, w = size_hw
    root = os.path.dirname(ENGINE_DIR)
    p = os.path.join(root, "tests", "samples", "portrait-of-woman.jpg")
    img = None
    if os.path.isfile(p):
        try:
            data = np.fromfile(p, dtype=np.uint8)
            img = cv2.imdecode(data, cv2.IMREAD_COLOR)
            if img is not None:
                img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        except Exception:
            img = None
    if img is None:
        yy, xx = np.mgrid[0:512, 0:512].astype(np.float32) / 512
        img = np.stack([yy, xx, 1 - yy * xx], -1)
        cv2.circle(img, (256, 280), 150, (0.9, 0.7, 0.6), -1)
        img = (img * 255).astype(np.uint8)
    return cv2.resize(img, (w, h), interpolation=cv2.INTER_AREA)


def _test_feeds(key):
    """每个模型的比对输入 + 输出归一化系数。"""
    img = None
    if key == "general":
        img = _test_image((1024, 1024)).astype(np.float32) / 255.0
        img = (img - np.array([0.485, 0.456, 0.406], np.float32)) / np.array([0.229, 0.224, 0.225], np.float32)
        return {"input_image": img.transpose(2, 0, 1)[None].copy()}, "sigmoid"
    if key == "portrait":
        img = _test_image((640, 512)).astype(np.float32) / 127.5 - 1.0
        return {"input": img.transpose(2, 0, 1)[None].copy()}, 1.0
    if key == "inpaint":
        img = _test_image((512, 512)).astype(np.float32) / 255.0
        mask = np.zeros((1, 1, 512, 512), np.float32)
        mask[..., 180:330, 200:320] = 1.0
        return {"image": img.transpose(2, 0, 1)[None].copy(), "mask": mask}, 255.0
    raise KeyError(key)


def _norm_out(y, norm):
    y = np.asarray(y, np.float32)
    if norm == "sigmoid":
        return 1.0 / (1.0 + np.exp(-np.clip(y, -30, 30)))
    return y / float(norm)


def _compare(a, b):
    d = np.abs(a.astype(np.float32) - b.astype(np.float32))
    if not np.all(np.isfinite(d)):
        return 1.0, 1.0
    return float(d.mean()), float(np.quantile(d, 0.999))


def _timed_run(sess, feeds, repeat=2):
    _run_session(sess, feeds)  # 预热（DirectML 首次会编译）
    best = 1e9
    out = None
    for _ in range(repeat):
        t = time.perf_counter()
        out = _run_session(sess, feeds)
        best = min(best, time.perf_counter() - t)
    return out, best * 1000


def probe_devices(force=False):
    """检测并选择 DirectML 显卡，结果写入 device.json。返回配置 dict。"""
    global _probing
    with _probe_lock:
        cfg = None if force else _load_cfg()
        if cfg is not None:
            return cfg
        _probing = True
        try:
            adapters = list_adapters()
            cfg = {"version": CFG_VERSION, "ort": ort().__version__,
                   "adapters_sig": _adapter_signature(adapters), "adapters": adapters,
                   "device_id": None, "device_name": "CPU", "probe": [], "models": {},
                   "time": time.strftime("%Y-%m-%d %H:%M:%S")}
            if not dml_available():
                log("[提示] 没有 DirectML，AI 将使用 CPU 运行（会慢一些）。")
                cfg["models"] = {"general": "cpu", "portrait": "cpu", "inpaint": "cpu"}
                _save_cfg(cfg)
                return cfg
            log("[检测] 首次运行，正在测试哪块显卡最快（约半分钟，只做一次）……")
            feeds, norm = _test_feeds("general")
            try:
                cpu = _make_session("general", "cpu")
                t = time.perf_counter()
                ref = _norm_out(cpu.run(None, feeds)[0], norm)
                cfg["cpu_ms"] = round((time.perf_counter() - t) * 1000)
                del cpu  # CPU 版 BiRefNet 很占内存，比对完就释放
            except Exception as e:
                if is_oom(e):  # 内存不够时不下结论，下次再测
                    raise OutOfMemory(short_err(e)) from e
                raise
            hw = [a for a in adapters if not a["software"]][:3] or [{"index": 0, "name": "GPU", "software": False}]
            hw.sort(key=lambda a: -a.get("vram_mb", 0))  # 先测独显
            best = None
            oom = None
            for a in hw:
                rec = {"device_id": a["index"], "name": a["name"]}
                sess = None
                try:
                    sess = _make_session("general", "dml", a["index"])
                    out, ms = _timed_run(sess, feeds)
                    mean, p999 = _compare(_norm_out(out[0], norm), ref)
                    rec.update(ms=round(ms, 1), diff_mean=round(mean, 5), diff_p999=round(p999, 4),
                               ok=mean < TOL_MEAN and p999 < TOL_P999)
                    if rec["ok"] and (best is None or ms < best[1]):
                        best = (a, ms, sess)
                        sess = None
                except Exception as e:
                    rec.update(ok=False, error=short_err(e))
                    if is_oom(e) and a.get("vram_mb", 0) >= 1024:
                        oom = e  # 独显因内存不足失败：结果不可信，不写缓存
                finally:
                    del sess
                cfg["probe"].append(rec)
                log(f"  显卡 {a['index']}：{a['name']} → " +
                    (f"{rec['ms']:.0f} 毫秒，结果{'一致' if rec['ok'] else '不一致'}" if "ms" in rec else "不可用"))
            if oom is not None and best is None:
                raise OutOfMemory(short_err(oom))
            if best is not None:
                a, ms, sess = best
                if ms < cfg["cpu_ms"] * 0.9:
                    cfg["device_id"] = a["index"]
                    cfg["device_name"] = a["name"]
                    cfg["models"]["general"] = "dml"
                    _sessions[("general", "dml")] = sess
                else:
                    cfg["models"]["general"] = "cpu"
            else:
                cfg["models"]["general"] = "cpu"
            if cfg["models"]["general"] == "cpu":
                log("[提示] 显卡加速不可用或不比 CPU 快，改用 CPU。")
            else:
                log(f"[检测] 选用显卡：{cfg['device_name']}")
            if oom is not None:  # 有显卡因内存不足没测成：本次先用着，不写缓存，下次启动重测
                cfg["_tentative"] = True
            _save_cfg(cfg)
            return cfg
        finally:
            _probing = False


def _verify_model(key, cfg):
    """首次在 DML 上使用某模型时与 CPU 比对；返回 "dml" 或 "cpu"。"""
    feeds, norm = _test_feeds(key)
    rec = {}
    dml = cpu = None
    try:
        dml = _make_session(key, "dml", cfg["device_id"])
        out, ms = _timed_run(dml, feeds, repeat=2)
        cpu = _sessions.get((key, "cpu")) or _make_session(key, "cpu")
        cpu.run(None, feeds)  # 预热
        t = time.perf_counter()
        ref = cpu.run(None, feeds)
        cpu_ms = (time.perf_counter() - t) * 1000
        mean, p999 = _compare(_norm_out(out[0], norm), _norm_out(ref[0], norm))
        ok = mean < TOL_MEAN and p999 < TOL_P999 * 2 and ms < cpu_ms * 1.1
        rec = {"ms": round(ms, 1), "cpu_ms": round(cpu_ms, 1), "diff_mean": round(mean, 5),
               "diff_p999": round(p999, 4), "ok": ok}
        if ok:
            _sessions[(key, "dml")] = dml
        else:
            _sessions[(key, "cpu")] = cpu
        choice = "dml" if ok else "cpu"
    except Exception as e:
        if is_oom(e):  # 内存不够不代表显卡不行：不下结论，这次请求报「内存不足」
            raise OutOfMemory(short_err(e)) from e
        rec = {"ok": False, "error": short_err(e)}
        choice = "cpu"
    finally:
        dml = cpu = None
    with _cfg_lock:
        cfg.setdefault("verify", {})[key] = rec
        cfg["models"][key] = choice
        _save_cfg(cfg)
    return choice


def _lock_for(table, key):
    with _global_lock:
        if key not in table:
            table[key] = threading.Lock()
        return table[key]


def provider_for(key):
    """该模型实际使用的后端："dml" / "cpu"（必要时触发检测/比对）。"""
    if key in _runtime_cpu:
        return "cpu"
    cfg = probe_devices()
    choice = cfg.get("models", {}).get(key)
    if choice is None:
        if cfg.get("device_id") is None:
            choice = "cpu"
        else:
            with _lock_for(_session_locks, ("verify", key)):
                cfg = _load_cfg()
                choice = cfg.get("models", {}).get(key) or _verify_model(key, cfg)
    return choice


def get_session(key):
    prov = provider_for(key)
    sk = (key, prov)
    s = _sessions.get(sk)
    if s is not None:
        return s, prov
    with _lock_for(_session_locks, key):
        s = _sessions.get(sk)
        if s is None:
            cfg = _load_cfg() or {}
            try:
                s = _make_session(key, prov, cfg.get("device_id") or 0)
            except Exception as e:
                if is_oom(e):
                    raise OutOfMemory(short_err(e)) from e
                if prov != "dml":
                    raise
                log(f"[提示] 显卡加载模型 {key} 失败，本次改用 CPU：{short_err(e, 200)}")
                _runtime_cpu.add(key)
                prov, sk = "cpu", (key, "cpu")
                s = _sessions.get(sk) or _make_session(key, "cpu")
            _sessions[sk] = s
    return s, prov


def run(key, feeds):
    """执行模型（每个模型串行）。DirectML 运行出错时自动改用 CPU 重试；内存不足抛 OutOfMemory。"""
    with _lock_for(_run_locks, key):
        sess, prov = get_session(key)
        try:
            return _run_session(sess, feeds)
        except Exception as e:
            if is_oom(e):
                raise OutOfMemory(short_err(e)) from e
            if prov != "dml":
                raise
            log(f"[提示] 显卡运行 {key} 出错，本次改用 CPU：{short_err(e, 200)}")
            _runtime_cpu.add(key)
            _sessions.pop((key, "dml"), None)  # 释放显存
            del sess
        sess, prov = get_session(key)
        try:
            return _run_session(sess, feeds)
        except Exception as e:
            if is_oom(e):
                raise OutOfMemory(short_err(e)) from e
            raise


def release(key):
    """释放某个模型的会话（内存紧张时用）。"""
    with _lock_for(_run_locks, key):
        for prov in ("dml", "cpu"):
            _sessions.pop((key, prov), None)


def preload(keys=("general",)):
    """创建会话并空跑一次（DirectML 首次运行要编译着色器，约 1–2 秒）。"""
    for k in keys:
        try:
            feeds, _ = _test_feeds(k)
            run(k, feeds)
        except MemoryError:
            log("[提示] 内存不足，AI 模型暂时没能预先载入：" + (low_memory_hint(1 << 30) or "请关闭一些程序后再试"))
            return False
        except Exception as e:
            log(f"[提示] 预加载模型 {k} 失败：{short_err(e, 200)}")
    return True


def status():
    """(provider, device) —— 供 /api/status 使用。"""
    cfg = _load_cfg()
    if cfg is None:
        # 仍在检测中：按显卡列表猜一个（检测完成后以实际结果为准）
        if not dml_available():
            return "CPU", "CPU"
        hw = [a for a in list_adapters() if not a["software"]]
        if not hw:
            return "CPU", "CPU"
        best = max(hw, key=lambda a: (a["vendor"] == "NVIDIA", a["vram_mb"]))
        return "DirectML", best["name"]
    if cfg.get("models", {}).get("general") == "dml" and "general" not in _runtime_cpu and cfg.get("device_id") is not None:
        return "DirectML", cfg.get("device_name") or "GPU"
    return "CPU", "CPU"


def is_probing():
    return _probing
