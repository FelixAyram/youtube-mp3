@echo off
title Instalar descarga con un clic
echo.
echo Registrando launcher local (solo una vez)...
echo.

set "DIR=%~dp0"
set "DIR=%DIR:~0,-1%"

reg add "HKCU\Software\Classes\ypldl-start" /ve /d "YouTube MP3 Launcher" /f >nul
reg add "HKCU\Software\Classes\ypldl-start" /v "URL Protocol" /d "" /f >nul
reg add "HKCU\Software\Classes\ypldl-start\shell\open\command" /ve /d "wscript.exe \"%DIR%\silent-start.vbs\" \"%%1\"" /f >nul

echo [OK] Instalado.
echo.
echo Ahora en YouTube: un clic en "Descargar MP3" arranca el servidor solo
echo y guarda los archivos en Descargas / YouTube Playlists
echo.
pause
