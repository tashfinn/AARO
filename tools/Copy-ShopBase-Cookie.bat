@echo off
setlocal
cd /d "%~dp0"
set "PYTHON="
where py >nul 2>nul && set "PYTHON=py"
if not defined PYTHON (
  python -c "import sys" >nul 2>nul && set "PYTHON=python"
)
if not defined PYTHON (
  python3 -c "import sys" >nul 2>nul && set "PYTHON=python3"
)
if not defined PYTHON (
  echo Python is not installed or is not available on PATH.
  echo Install Python 3 from https://www.python.org/downloads/windows/
  echo During installation, enable "Add python.exe to PATH", then reopen this tool.
  pause
  exit /b 1
)
%PYTHON% -m pip install -r requirements.txt
if errorlevel 1 (
  echo Could not install the cookie helper dependency.
  pause
  exit /b 1
)
%PYTHON% sync_shopbase_cookie.py
if errorlevel 1 exit /b 1
echo.
pause
