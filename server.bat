@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (
  echo [Suchat] Installing local dependencies...
  call npm install
  if errorlevel 1 exit /b %errorlevel%
)
echo [Suchat] Starting local server at http://127.0.0.1:8787
call npm start
