@echo off
cd /d "%~dp0"
start "UWB Lab Service" /min cmd /c "node server.mjs"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:4173"
