# AI 抠图 P 图工具

中文本地图片编辑器：Python 后端运行 AI 模型，浏览器提供编辑界面，无需前端构建。照片处理在本机完成；安装依赖、下载模型时需要联网，准备完成后可离线使用。

## 功能

- **抠图与边缘精修**：通用抠图、人像发丝、去色边、羽化、细调收缩/扩张、保留/擦除画笔；黑底、白底、绿底和蒙版检查仅影响预览。
- **换背景与证件照**：透明、纯色、渐变、图片、背景虚化，阴影和描边；证件照尺寸、底色、文件大小限制及六寸相纸排版。
- **图片编辑**：调色与滤镜、磨皮美白、裁剪、旋转、翻转、拉直、改尺寸、文字与贴纸。
- **修补与批量处理**：AI 消除、马赛克/模糊/涂鸦、人脸打码，批量抠图、换底色、压缩和改尺寸。
- **保存与历史**：撤销/重做，PNG/JPG/WebP 导出，透明图片保存，重名文件自动添加后缀。

## Windows 安装

当前依赖锁定文件已在 **Windows 11、64 位 Python 3.14.5** 上验证。建议使用 Python 3.14 和新版 Chrome 或 Edge；其他 Python 版本未保证兼容该锁定文件。AI 推理通过 ONNX Runtime 使用 DirectML，显卡不可用时回退到 CPU。

1. 安装 [Python](https://www.python.org/downloads/windows/)，勾选 **Add python.exe to PATH**。
2. 克隆仓库，或下载并解压源码。

   ```powershell
   git clone https://github.com/zzz425731-ai/ai-cutout-photo-editor.git
   cd ai-cutout-photo-editor
   ```

3. 在项目根目录打开 PowerShell，创建独立环境并安装依赖：

   ```powershell
   python -m venv .venv
   .\.venv\Scripts\python.exe -m pip install -r requirements-lock.txt
   ```

4. 下载 AI 模型：

   ```powershell
   .\.venv\Scripts\python.exe -m engine.download_models
   ```

   模型存入 `models/`，不随 Git 仓库打包。下载器依次尝试 Hugging Face 和镜像；中断后可重新运行，支持续传。首次使用可能需要加载模型或生成本机使用的 FP16 模型，请稍候。

以上命令直接使用 `.venv` 内的 Python，不需要执行 PowerShell 环境激活脚本。若已激活该环境，安装和下载命令也可写为 `pip install -r requirements-lock.txt`、`python -m engine.download_models`。

## 启动与使用

完成安装后，双击 **`启动抠图P图工具.bat`**，或在项目根目录运行：

```powershell
.\.venv\Scripts\python.exe server.py
```

已激活 `.venv` 时可直接执行 `python server.py`。浏览器会自动打开；服务只监听 `127.0.0.1`，默认在 `7860–7879` 中选择空闲端口。使用时保留后台窗口，关闭窗口即可退出。

需要固定端口或手动打开浏览器时：

```powershell
.\.venv\Scripts\python.exe server.py --port 7861 --no-browser
```

随后打开 `http://127.0.0.1:7861/`。

导入或拖入图片后，人物可选择“人像发丝”，物品可选择“通用”抠图。用检查底色观察边缘，再按需要微调收缩、羽化和画笔。复杂背景仍可能需要手动修补。图片导入时长边最多保留 4096 像素；HEIC 请先转为 PNG 或 JPG。

- **保存**：写入项目根目录的 `输出/`；有透明背景时优先 PNG，否则 JPG。重名时保留旧文件并生成新文件名。
- **导出**：选择 PNG、JPG 或 WebP，调整尺寸和画质，保存到本地输出目录或浏览器下载目录。需要透明底时请选择 PNG；JPG 不支持透明。
- **快捷键**：`Ctrl+Z` 撤销、`Ctrl+Y` 重做、`Ctrl+V` 粘贴图片；滚轮缩放，空格加拖动平移。

更多操作见 [使用说明](使用说明.txt)。仓库不包含 `.venv/`、模型权重或个人输出图片；首次克隆后需要按上面的步骤准备环境。

## 测试

以下命令均在项目根目录执行。

不需要 AI 模型推理的后端回归：

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -p test_matting_quality.py -v
.\.venv\Scripts\python.exe -m unittest discover -s tests -p test_matte_api.py -v
.\.venv\Scripts\python.exe -m unittest discover -s tests -p test_download_models.py -v
```

前端测试：启动服务后，在 Chrome 或 Edge 打开 `/tests.html`，例如 `http://127.0.0.1:7861/tests.html`。页面自动运行测试并显示结果；端口以实际启动地址为准。

安装全部模型后，可运行真实引擎和服务器接口集成测试。这些测试需要自行准备有权使用的图片，文件名与内容要求见 [测试样图说明](tests/samples/README.md)；公开仓库不提供测试照片：

```powershell
.\.venv\Scripts\python.exe tests/test_engine.py
.\.venv\Scripts\python.exe tests/test_server.py
```

结果写入 `tests/out/`。服务器测试会启动并关闭独立测试服务，默认端口为 `7882`，保存结果不会写入日常使用的 `输出/`。`tests/` 中另外的浏览器验收脚本可能依赖本机生成的测试产物，不能替代上述克隆后可用的测试入口。

## 模型与项目结构

| 模型 | 用途 | 下载来源 |
| --- | --- | --- |
| BiRefNet Lite | 通用抠图 | [onnx-community/BiRefNet_lite-ONNX](https://huggingface.co/onnx-community/BiRefNet_lite-ONNX) |
| MODNet | 人像发丝 | [Xenova/modnet](https://huggingface.co/Xenova/modnet) |
| LaMa | AI 消除 | [Carve/LaMa-ONNX](https://huggingface.co/Carve/LaMa-ONNX) |
| YuNet | 人脸定位 | [opencv/face_detection_yunet](https://huggingface.co/opencv/face_detection_yunet) |

模型和第三方依赖分别受其上游许可及使用条款约束，项目的 MIT 许可证不改变它们的授权范围。

- `server.py`：本地 HTTP 服务与图片处理接口。
- `engine/`：模型下载、推理、图像处理和设备选择。
- `web/`：编辑界面与浏览器测试。
- `tests/`：后端回归、样图准备说明与验收脚本。
- `docs/`：架构、前端 API 和功能检查记录。

开发说明见 [架构文档](docs/ARCHITECTURE.md) 和 [前端 API](docs/FRONTEND-API.md)。

## 开源许可

本项目的原创源码与文档采用 [MIT 许可证](LICENSE)。模型权重、第三方依赖及测试图片不因本项目开源而被重新授权；相关说明见 [第三方素材说明](THIRD_PARTY_NOTICES.md)。
