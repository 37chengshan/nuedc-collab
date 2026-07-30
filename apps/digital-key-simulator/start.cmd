@echo off
setlocal
cd /d "%~dp0"
set "DIGITAL_KEY_PORT=4180"
echo.
echo  Digital Key Simulator
echo  http://127.0.0.1:%DIGITAL_KEY_PORT%
echo.
npm run dev
endlocal
