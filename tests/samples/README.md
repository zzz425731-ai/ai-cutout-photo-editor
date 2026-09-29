# 实际模型测试用图

公开仓库不分发测试照片。运行 `tests/test_engine.py`、`tests/test_server.py` 或照片质量对比脚本前，请将自己拍摄或有权使用的图片放在本目录。

现有测试脚本按下列名称读取图片；应选择符合用途的图片，不能仅更改不相关图片的文件名，否则人脸数量、图像尺寸和模型效果相关的断言可能不成立。

| 文件名 | 用途 |
| --- | --- |
| `butterfly.jpg` | 小尺寸主体图片，无人脸；部分界面验收按 256×256 像素操作 |
| `corgi.jpg` | 动物图片，无人脸 |
| `portrait-of-woman.jpg` | 清晰正面单人肖像，用于人脸定位、证件照及美颜 |
| `woman-with-afro_medium.jpg` | 蓬松发丝人像，用于边缘效果检查 |
| `young-man-standing-and-leaning-on-car.jpg` | 人物及复杂背景，用于消除效果检查 |
| `football-match.jpg` | 多人场景，用于多人主体保留和人脸检测 |
| `bread_small.png` | 小尺寸物品，用于通用抠图 |
| `vitmatte_image.png` | 含发丝或细边缘的图片，用于抠图效果检查 |

这些文件默认被 `.gitignore` 排除。更换样图后，请根据新样图核对并调整涉及具体尺寸、主体或人脸数量的验收条件。

不需要这些照片的测试包括浏览器 `/tests.html`，以及 `test_matting_quality.py`、`test_matte_api.py`、`test_download_models.py` 中的合成图片或本地 HTTP 测试。
