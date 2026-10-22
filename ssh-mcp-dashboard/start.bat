@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0" || (
  echo 无法进入 Dashboard 目录。
  pause
  exit /b 1
)

call "%~dp0setup.bat" --no-pause
if errorlevel 1 (
  pause
  exit /b 1
)

echo 正在启动 SSH Dashboard...
node "%~dp0server.js" --open
if errorlevel 1 (
  echo Dashboard 已退出，请检查上方错误信息。
)
pause
