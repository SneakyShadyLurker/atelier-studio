@echo off
setlocal
title Atelier private ComfyUI
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0start-private-worker.ps1"
if errorlevel 1 (
    echo.
    echo ComfyUI did not become ready. No legacy launcher was started.
    pause
    exit /b 1
)
exit /b 0
