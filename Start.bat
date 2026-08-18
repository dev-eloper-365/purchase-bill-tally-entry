@echo off
title Purchase Bill Tally Entry - Launcher
cd /d "%~dp0"

echo Checking Tally...
tasklist /FI "IMAGENAME eq tally.exe" 2>NUL | find /I "tally.exe" >NUL
if errorlevel 1 (
    echo Starting Tally...
    start "" "C:\Program Files\TallyPrime\tally.exe"
    echo Waiting for Tally to come up...
    timeout /t 8 /nobreak >NUL
) else (
    echo Tally is already running.
)

echo Starting bridge server on port 8765...
start "Purchase Bill Tally Entry - Bridge" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tally-bridge.ps1"

echo Starting remote tunnel (billentry-tunnel)...
start "Purchase Bill Tally Entry - Tunnel" powershell.exe -NoProfile -Command "& 'C:\Users\Admin\AppData\Local\Microsoft\WinGet\Packages\Microsoft.devtunnel_Microsoft.Winget.Source_8wekyb3d8bbwe\devtunnel.exe' host billentry-tunnel"

echo.
echo All three started in separate windows:
echo   - Tally
echo   - Bridge  (http://localhost:8765)
echo   - Tunnel  (public URL will print in its window - close that window to stop sharing)
echo.
pause
