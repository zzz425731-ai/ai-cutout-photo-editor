"""Decode the isolated browser QA exports and verify their real format/dimensions."""
import json
from pathlib import Path

from PIL import Image


def main():
    root = Path(__file__).resolve().parent / "out" / "fullcheck-ui"
    records = []
    for path in sorted((root / "saved").rglob("*")):
        if not path.is_file():
            continue
        with Image.open(path) as im:
            im.load()
            expected = {".png": "PNG", ".jpg": "JPEG", ".webp": "WEBP"}[path.suffix]
            assert im.format == expected, path
            dpi = im.info.get("dpi")
            alpha = im.getchannel("A").getextrema() if "A" in im.getbands() else None
            if "6寸排版" in path.name:
                assert im.size == (1800, 1200) and dpi == (300, 300), path
            elif "证件照_一寸" in path.name:
                assert im.size == (295, 413) and dpi == (300, 300), path
            elif "real-portrait-export" in path.name:
                assert im.size == (1280, 1600), path
            elif "压缩" in path.name:
                assert max(im.size) == 200, path
            elif "butterfly_抠图" in path.name:
                assert im.size == (200, 200) and alpha and alpha[0] == 0 and alpha[1] == 255, path
            elif "butterfly_换底" in path.name:
                assert im.size == (200, 200) and im.mode == "RGB", path
            records.append({"path": str(path), "format": im.format, "size": im.size,
                            "dpi": dpi, "alpha_range": alpha, "bytes": path.stat().st_size})
    assert records, "No browser QA output files"
    (root / "files-verified.json").write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"PASS: decoded and verified {len(records)} exported files")


if __name__ == "__main__":
    main()
