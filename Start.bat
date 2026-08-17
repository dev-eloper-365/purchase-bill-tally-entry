@echo off
title Purchase Bill Tally Entry
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tally-bridge.ps1"
pause
