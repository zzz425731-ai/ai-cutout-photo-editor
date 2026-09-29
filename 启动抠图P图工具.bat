@echo off
chcp 65001>nul
cd /d "%~dp0"
title AI抠图P图工具 - 关闭此窗口即退出
echo 正在启动 AI抠图P图工具，请稍候……
echo.
rem 找 Python 3.9+：先试 python，再试 py -3（有的电脑只装了 py 启动器）
set "PYEXE="
if exist ".venv\Scripts\python.exe" (
    .venv\Scripts\python.exe -c "import numpy, PIL, cv2, onnxruntime" >nul 2>nul && set "PYEXE=.venv\Scripts\python.exe"
)
if not defined PYEXE (
    python -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>nul && set "PYEXE=python"
)
if not defined PYEXE (
    py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)" >nul 2>nul && set "PYEXE=py -3"
)
if not defined PYEXE (
    echo [错误] 没有找到 Python 3。
    echo 请先安装 Python 3（安装时勾选 Add python.exe to PATH），再双击本文件。
    echo.
    pause
    exit /b 1
)
set "KT_LAUNCHER=1"
set "PYTHONIOENCODING=utf-8"
%PYEXE% server.py %*
if errorlevel 1 (
    echo.
    echo [提示] 工具异常退出了。请把上面的文字拍照发给帮你安装的人。
    echo.
    pause
    exit /b 1
)
exit /b 0
