# 第三方素材说明

项目根目录的 MIT 许可证适用于本项目的原创源码与文档，不改变第三方材料各自的许可。

## AI 模型

模型权重由使用者通过下载脚本获取，不包含在本仓库中。来源如下；使用与分发条件以各上游仓库提供的许可为准。

- [BiRefNet Lite ONNX](https://huggingface.co/onnx-community/BiRefNet_lite-ONNX)
- [MODNet ONNX](https://huggingface.co/Xenova/modnet)
- [LaMa ONNX](https://huggingface.co/Carve/LaMa-ONNX)
- [YuNet](https://huggingface.co/opencv/face_detection_yunet)

## 软件依赖

`requirements-lock.txt` 列出的软件包分别适用其自身的许可证。依赖安装在本地虚拟环境中，不随源码仓库分发。

## 测试图片

公开源码不分发开发时使用的测试照片。实际模型集成测试需要使用者自行准备有权使用的图片，见 [测试样图说明](tests/samples/README.md)。这些由使用者另行提供的图片不受本项目 MIT 许可证授权。
