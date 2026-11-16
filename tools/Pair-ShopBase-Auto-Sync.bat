@echo off
setlocal
cd /d "%~dp0"
set "PYTHON="
py -3.13 -c "import sys" >nul 2>nul && set "PYTHON=py -3.13"
if not defined PYTHON (
  python -c "import sys" >nul 2>nul && set "PYTHON=python"
)
if not defined PYTHON (
  echo Python 3.13 or newer is required. Install Python from https://www.python.org/downloads/windows/.
  pause
  exit /b 1
)
%PYTHON% -m pip install -r requirements.txt
if errorlevel 1 (
  echo Could not install the automatic sync helper dependency.
  pause
  exit /b 1
)
%PYTHON% -m playwright install chromium
if errorlevel 1 (
  echo Could not install the ShopBase browser helper.
  pause
  exit /b 1
)
%PYTHON% run_shopbase_sync_agent.py --pair
if errorlevel 1 pause
