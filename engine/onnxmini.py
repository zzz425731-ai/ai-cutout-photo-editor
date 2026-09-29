"""Minimal ONNX protobuf schema built at runtime (no onnx package needed).
Only the fields we touch are declared; unknown fields are preserved on re-serialisation."""
from google.protobuf import descriptor_pb2, descriptor_pool, message_factory

F = descriptor_pb2.FieldDescriptorProto
L_OPT, L_REP = F.LABEL_OPTIONAL, F.LABEL_REPEATED
T = {"i64": F.TYPE_INT64, "i32": F.TYPE_INT32, "str": F.TYPE_STRING, "bytes": F.TYPE_BYTES,
     "f": F.TYPE_FLOAT, "d": F.TYPE_DOUBLE, "u64": F.TYPE_UINT64, "msg": F.TYPE_MESSAGE}


def _build():
    fd = descriptor_pb2.FileDescriptorProto(name="onnxmini.proto", package="onnxmini", syntax="proto2")

    def msg(name, fields):
        m = fd.message_type.add(name=name)
        for num, fname, label, typ, tname in fields:
            f = m.field.add(name=fname, number=num, label=label, type=T[typ])
            if tname:
                f.type_name = ".onnxmini." + tname
            if label == L_REP and typ in ("i64", "i32", "f", "d", "u64"):
                f.options.packed = True
        return m

    msg("StringStringEntryProto", [(1, "key", L_OPT, "str", None), (2, "value", L_OPT, "str", None)])
    msg("TensorProto", [(1, "dims", L_REP, "i64", None), (2, "data_type", L_OPT, "i32", None),
                        (4, "float_data", L_REP, "f", None), (5, "int32_data", L_REP, "i32", None),
                        (6, "string_data", L_REP, "bytes", None), (7, "int64_data", L_REP, "i64", None),
                        (8, "name", L_OPT, "str", None), (9, "raw_data", L_OPT, "bytes", None),
                        (10, "double_data", L_REP, "d", None), (11, "uint64_data", L_REP, "u64", None),
                        (12, "doc_string", L_OPT, "str", None),
                        (13, "external_data", L_REP, "msg", "StringStringEntryProto"),
                        (14, "data_location", L_OPT, "i32", None)])
    msg("Dimension", [(1, "dim_value", L_OPT, "i64", None), (2, "dim_param", L_OPT, "str", None)])
    msg("TensorShapeProto", [(1, "dim", L_REP, "msg", "Dimension")])
    msg("TensorTypeProto", [(1, "elem_type", L_OPT, "i32", None), (2, "shape", L_OPT, "msg", "TensorShapeProto")])
    msg("TypeProto", [(1, "tensor_type", L_OPT, "msg", "TensorTypeProto")])
    msg("ValueInfoProto", [(1, "name", L_OPT, "str", None), (2, "type", L_OPT, "msg", "TypeProto")])
    msg("AttributeProto", [(1, "name", L_OPT, "str", None), (2, "f", L_OPT, "f", None), (3, "i", L_OPT, "i64", None),
                           (4, "s", L_OPT, "bytes", None), (5, "t", L_OPT, "msg", "TensorProto"),
                           (6, "g", L_OPT, "msg", "GraphProto"), (7, "floats", L_REP, "f", None),
                           (8, "ints", L_REP, "i64", None), (9, "strings", L_REP, "bytes", None),
                           (10, "tensors", L_REP, "msg", "TensorProto"), (11, "graphs", L_REP, "msg", "GraphProto"),
                           (20, "type", L_OPT, "i32", None), (21, "ref_attr_name", L_OPT, "str", None)])
    msg("NodeProto", [(1, "input", L_REP, "str", None), (2, "output", L_REP, "str", None),
                      (3, "name", L_OPT, "str", None), (4, "op_type", L_OPT, "str", None),
                      (5, "attribute", L_REP, "msg", "AttributeProto"), (7, "domain", L_OPT, "str", None)])
    msg("GraphProto", [(1, "node", L_REP, "msg", "NodeProto"), (2, "name", L_OPT, "str", None),
                       (5, "initializer", L_REP, "msg", "TensorProto"),
                       (11, "input", L_REP, "msg", "ValueInfoProto"), (12, "output", L_REP, "msg", "ValueInfoProto"),
                       (13, "value_info", L_REP, "msg", "ValueInfoProto")])
    msg("OperatorSetIdProto", [(1, "domain", L_OPT, "str", None), (2, "version", L_OPT, "i64", None)])
    msg("ModelProto", [(1, "ir_version", L_OPT, "i64", None), (2, "producer_name", L_OPT, "str", None),
                       (7, "graph", L_OPT, "msg", "GraphProto"),
                       (8, "opset_import", L_REP, "msg", "OperatorSetIdProto")])
    pool = descriptor_pool.DescriptorPool()
    pool.Add(fd)
    get = message_factory.GetMessageClass
    return {n: get(pool.FindMessageTypeByName("onnxmini." + n)) for n in
            ("ModelProto", "GraphProto", "NodeProto", "TensorProto", "AttributeProto", "ValueInfoProto")}


C = _build()
ModelProto = C["ModelProto"]
NodeProto = C["NodeProto"]
TensorProto = C["TensorProto"]
AttributeProto = C["AttributeProto"]
ValueInfoProto = C["ValueInfoProto"]
FLOAT, UINT8, INT8, UINT16, INT16, INT32, INT64, STRING, BOOL, FLOAT16, DOUBLE = 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11


def load(path):
    m = ModelProto()
    with open(path, "rb") as f:
        m.ParseFromString(f.read())
    return m
