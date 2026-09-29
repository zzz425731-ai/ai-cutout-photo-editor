"""把 ONNX 浮点模型转成混合精度（fp16）——不依赖 onnx 包（用 onnxruntime 自带的 protobuf）。

BiRefNet_lite 在 DirectML 上用 fp32 要申请约 10GB 显存（显存不够就挤占系统内存，整台电脑会卡）；
转成 fp16 后显存约 5GB、系统内存约 0.5GB、推理约 0.3 秒，结果与 fp32 平均相差 < 0.001。
坐标 / 取整相关路径（Floor、Resize 的 roi/scales、被取整的中间量）保持 fp32，保证可变形卷积的采样位置准确。

用法：python -m engine.tofp16 in.onnx out.onnx [--ln32] [--keep op1,op2]
"""
import os
import sys

import numpy as np

from . import onnxmini as om

FLOAT, FLOAT16 = om.FLOAT, om.FLOAT16
SAME0 = {"Unsqueeze", "Reshape", "Transpose", "Expand", "Slice", "Gather", "GatherND", "Split", "Identity", "Pad",
         "Relu", "Clip", "Floor", "Softmax", "Erf", "Sigmoid", "Resize", "LayerNormalization",
         "BatchNormalization", "GlobalAveragePool", "Conv", "MatMul", "Neg", "ScatterND", "Concat", "Add", "Mul",
         "Div", "Sub", "Mod", "Sum", "Sqrt", "Pow", "ReduceMean", "Tanh", "Exp", "Abs", "Max", "Min",
         "Squeeze", "Flatten", "Tile", "MaxPool", "AveragePool", "ConvTranspose", "Gemm", "HardSigmoid", "LeakyRelu",
         "InstanceNormalization", "Upsample", "DepthToSpace", "SpaceToDepth", "Round", "Ceil", "Reciprocal", "Log"}
LIGHT = {"Add", "Sub", "Mul", "Div", "Mod", "Floor", "Clip", "Reshape", "Transpose", "Unsqueeze", "Squeeze",
         "Concat", "Slice", "Gather", "Expand", "Split", "Where", "Identity", "Neg", "Sum", "Abs", "Round", "Ceil",
         "Max", "Min", "Tile", "Flatten"}
AGNOSTIC_IN = {"Cast", "Shape"}  # accept any input type, no cast needed
FORWARD = True
FIXED32_INPUTS = {("Resize", 1), ("Resize", 2)}  # roi / scales stay float32


def attr(n, name):
    for a in n.attribute:
        if a.name == name:
            return a
    return None


def tensor_to_fp16(t):
    if t.data_type != FLOAT:
        return
    if t.raw_data:
        arr = np.frombuffer(t.raw_data, np.float32)
    else:
        arr = np.array(t.float_data, np.float32)
    a16 = np.clip(arr, -65504, 65504).astype(np.float16)
    del t.float_data[:]
    t.raw_data = a16.tobytes()
    t.data_type = FLOAT16


def convert(m, keep32_ops=(), verbose=True):
    g = m.graph
    nodes = list(g.node)
    types = {}
    for vi in g.input:
        types[vi.name] = vi.type.tensor_type.elem_type
    inits = {t.name: t for t in g.initializer}
    for t in g.initializer:
        types[t.name] = t.data_type
    producer = {}
    consumers = {}
    for i, n in enumerate(nodes):
        for o in n.output:
            producer[o] = i
        for j, x in enumerate(n.input):
            if x:
                consumers.setdefault(x, []).append((i, j))
    # ---- forward type inference
    for n in nodes:
        op = n.op_type
        if op == "Constant":
            a = attr(n, "value")
            dt = a.t.data_type if a is not None else FLOAT
            outs = [dt]
        elif op == "Shape":
            outs = [7]
        elif op == "Cast":
            outs = [attr(n, "to").i]
        elif op in ("Equal", "Not", "Less", "Greater", "And", "Or"):
            outs = [9]
        elif op == "ConstantOfShape":
            a = attr(n, "value")
            outs = [a.t.data_type if a is not None else FLOAT]
        elif op == "Where":
            outs = [types.get(n.input[1], FLOAT)]
        elif op in SAME0:
            outs = [types.get(n.input[0], FLOAT)] * len(n.output)
        else:
            raise RuntimeError("unknown op " + op)
        for o, dt in zip(n.output, outs):
            types[o] = dt
    isf = lambda x: types.get(x) == FLOAT
    # ---- fp32 marking (backward from index/coordinate uses)
    mark = set()
    stack = []
    for i, n in enumerate(nodes):
        if n.op_type == "Floor" or (n.op_type == "Cast" and attr(n, "to").i not in (FLOAT, FLOAT16)):
            for x in n.input:
                if isf(x):
                    stack.append(x)
        for j, x in enumerate(n.input):
            if (n.op_type, j) in FIXED32_INPUTS and isf(x):
                stack.append(x)
    while stack:
        x = stack.pop()
        if x in mark:
            continue
        mark.add(x)
        p = producer.get(x)
        if p is None:
            continue
        pn = nodes[p]
        if pn.op_type in LIGHT or pn.op_type in ("Constant", "ConstantOfShape"):
            for y in pn.input:
                if y and isf(y):
                    stack.append(y)
    # forward: results computed (by light ops) from fp32 coordinates stay fp32 (e.g. bilinear weights p - floor(p))
    if FORWARD:
        const = set(inits)
        for n in nodes:
            if n.op_type in ("Constant", "ConstantOfShape"):
                const.update(n.output)
        for n in nodes:
            fin = [x for x in n.input if x and isf(x)]
            if n.op_type in LIGHT and any(x in mark for x in fin) and all(x in mark or x in const for x in fin):
                for o in n.output:
                    if isf(o):
                        mark.add(o)
    # ---- node precision
    prec = {}
    for i, n in enumerate(nodes):
        fl_out = [o for o in n.output if isf(o)]
        fl_in = [x for x in n.input if x and isf(x)]
        if not fl_out and not fl_in:
            continue
        if n.op_type in keep32_ops or any(o in mark for o in fl_out):
            prec[i] = FLOAT
        elif n.op_type in AGNOSTIC_IN and not fl_out:
            continue
        else:
            prec[i] = FLOAT16
    # dtype of every float tensor after conversion
    newt = {}
    for vi in g.input:
        newt[vi.name] = types[vi.name]
    # initializers: fp16 if any consumer wants fp16 and none wants fp32; else keep fp32 (+ cast)
    for name, t in inits.items():
        if t.data_type != FLOAT:
            continue
        wants = set()
        for (i, j) in consumers.get(name, []):
            n = nodes[i]
            if (n.op_type, j) in FIXED32_INPUTS:
                wants.add(FLOAT)
            elif i in prec:
                wants.add(prec[i])
        if wants == {FLOAT16}:
            tensor_to_fp16(t)
            newt[name] = FLOAT16
        else:
            newt[name] = FLOAT
    for i, n in enumerate(nodes):
        if i not in prec:
            continue
        p = prec[i]
        if p == FLOAT16:
            if n.op_type in ("Constant", "ConstantOfShape"):
                a = attr(n, "value")
                if a is not None and a.t.data_type == FLOAT:
                    tensor_to_fp16(a.t)
                elif a is None and n.op_type == "ConstantOfShape":
                    na = n.attribute.add(name="value", type=4)
                    na.t.dims.append(1)
                    na.t.data_type = FLOAT16
                    na.t.raw_data = np.zeros(1, np.float16).tobytes()
            for o in n.output:
                if isf(o):
                    newt[o] = FLOAT16
        else:
            for o in n.output:
                if isf(o):
                    newt[o] = FLOAT
    # ---- insert casts
    new_nodes = []
    cast_cache = {}
    ncast = 0

    def get_cast(x, to):
        nonlocal ncast
        k = (x, to)
        if k not in cast_cache:
            out = f"{x}__to{'16' if to == FLOAT16 else '32'}"
            c = om.NodeProto(op_type="Cast", name=f"mpcast_{len(cast_cache)}", input=[x], output=[out])
            a = c.attribute.add(name="to", type=2)
            a.i = to
            cast_cache[k] = (out, c)
            ncast += 1
            return out, c
        return cast_cache[k][0], None

    for i, n in enumerate(nodes):
        pre = []
        if i in prec and n.op_type not in AGNOSTIC_IN:
            for j, x in enumerate(n.input):
                if not x or not isf(x):
                    continue
                want = FLOAT if (n.op_type, j) in FIXED32_INPUTS else prec[i]
                if newt.get(x, FLOAT) != want:
                    out, c = get_cast(x, want)
                    if c is not None:
                        pre.append(c)
                    n.input[j] = out
        new_nodes.extend(pre)
        new_nodes.append(n)
    # graph outputs stay fp32
    outnames = {vi.name for vi in g.output}
    post = []
    for i, n in enumerate(nodes):
        for k, o in enumerate(n.output):
            if o in outnames and newt.get(o) == FLOAT16:
                n.output[k] = o + "__fp16"
                c = om.NodeProto(op_type="Cast", name="mpcast_out_" + o, input=[o + "__fp16"], output=[o])
                a = c.attribute.add(name="to", type=2)
                a.i = FLOAT
                post.append(c)
                # other consumers of o still read the fp16 name
                for (ci, cj) in consumers.get(o, []):
                    if nodes[ci].input[cj] == o:
                        nodes[ci].input[cj] = o + "__fp16"
    del g.node[:]
    g.node.extend(new_nodes + post)
    del g.value_info[:]
    if verbose:
        n16 = sum(1 for p in prec.values() if p == FLOAT16)
        n32 = sum(1 for p in prec.values() if p == FLOAT)
        ops32 = {}
        for i, p in prec.items():
            if p == FLOAT:
                ops32[nodes[i].op_type] = ops32.get(nodes[i].op_type, 0) + 1
        print(f"fp16 nodes {n16}, fp32 nodes {n32} {ops32}, casts {ncast}, marked fp32 tensors {len(mark)}")
    return m


def convert_file(src, dst, keep32_ops=(), verbose=False):
    """src → dst（先写临时文件再改名，避免半截文件）。"""
    m = om.load(src)
    convert(m, set(keep32_ops), verbose=verbose)
    tmp = dst + ".tmp"
    with open(tmp, "wb") as f:
        f.write(m.SerializeToString())
    os.replace(tmp, dst)
    return dst


if __name__ == "__main__":
    src, dst = sys.argv[1], sys.argv[2]
    keep = set()
    if "--ln32" in sys.argv:
        keep.add("LayerNormalization")
    if "--keep" in sys.argv:
        keep |= set(sys.argv[sys.argv.index("--keep") + 1].split(","))
    m = om.load(src)
    convert(m, keep)
    with open(dst, "wb") as f:
        f.write(m.SerializeToString())
