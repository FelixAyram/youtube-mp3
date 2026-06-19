@echo off
title YouTube Playlist Downloader - Servidor yt-dlp
echo.
echo Comprobando dependencias...
python -m yt_dlp --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] yt-dlp no esta instalado.
    echo Instalalo con: pip install yt-dlp
    pause
    exit /b 1
)
ffmpeg -version >nul 2>&1
if errorlevel 1 (
    echo [AVISO] ffmpeg no esta en el PATH.
    echo Instalalo con: winget install Gyan.FFmpeg
    echo Sin ffmpeg no se convertira a MP3 ni se embebera la portada.
)
python "%~dp0yt-dlp-server.py"
pause
