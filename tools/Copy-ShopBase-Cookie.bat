@echo off
cd /d "%~dp0.."
py -m pip install -r tools\requirements.txt
if errorlevel 1 (
  pause
  exit /b 1
)
py tools\sync_shopbase_cookie.py
if errorlevel 1 pause
