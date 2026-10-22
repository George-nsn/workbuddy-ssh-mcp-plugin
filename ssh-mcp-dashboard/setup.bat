@echo off
setlocal
chcp 65001 >nul

set "SCRIPT_DIR=%~dp0"
set "MCP_DIR=%SCRIPT_DIR%..\ssh-mcp-server"
set "IN_MCP_DIR=0"
set "FAIL_MESSAGE="

if not exist "%SCRIPT_DIR%server.js" (
  set "FAIL_MESSAGE=找不到 Dashboard server.js。请从完整项目副本部署。"
  goto :fail
)
if not exist "%SCRIPT_DIR%public\index.html" (
  set "FAIL_MESSAGE=找不到 public\index.html。请从完整项目副本部署。"
  goto :fail
)
if not exist "%MCP_DIR%\package.json" (
  set "FAIL_MESSAGE=找不到同级 ssh-mcp-server 项目。请确认两个目录保持并列。"
  goto :fail
)

where node >nul 2>nul
if errorlevel 1 (
  set "FAIL_MESSAGE=找不到 Node.js。请安装 Node.js 22 或更新版本，并将 node.exe 加入 PATH。"
  goto :fail
)

where npm >nul 2>nul
if errorlevel 1 (
  set "FAIL_MESSAGE=找不到 npm。请安装包含 npm 的 Node.js 22 或更新版本，并将其加入 PATH。"
  goto :fail
)

set "NODE_MAJOR="
for /f "delims=" %%V in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR (
  set "FAIL_MESSAGE=无法读取 Node.js 版本。请检查 PATH 中的 node 命令。"
  goto :fail
)
if %NODE_MAJOR% LSS 22 (
  set "FAIL_MESSAGE=检测到 Node.js %NODE_MAJOR%。本项目要求 Node.js 22 或更新版本。"
  goto :fail
)

pushd "%MCP_DIR%"
if errorlevel 1 (
  set "FAIL_MESSAGE=无法进入 ssh-mcp-server 目录。"
  goto :fail
)
set "IN_MCP_DIR=1"

if not exist package-lock.json (
  set "FAIL_MESSAGE=缺少 package-lock.json。请从完整项目副本恢复锁文件后重试。"
  goto :fail
)

set "LOCK_HASH="
for /f "delims=" %%H in ('node -e "const fs=require('fs'),crypto=require('crypto');process.stdout.write(crypto.createHash('sha256').update(fs.readFileSync('package-lock.json')).digest('hex'))" 2^>nul') do set "LOCK_HASH=%%H"
if not defined LOCK_HASH (
  set "FAIL_MESSAGE=无法校验 package-lock.json。请检查 Node.js 和锁文件。"
  goto :fail
)
if not exist "node_modules\.ssh-mcp-lock.sha256" goto :install
set "INSTALLED_LOCK_HASH="
set /p INSTALLED_LOCK_HASH=<"node_modules\.ssh-mcp-lock.sha256"
if /i not "%LOCK_HASH%"=="%INSTALLED_LOCK_HASH%" goto :install
if not exist "node_modules\@modelcontextprotocol\sdk\package.json" goto :install
if not exist "node_modules\socks\package.json" goto :install
if not exist "node_modules\ssh2\package.json" goto :install
if not exist "node_modules\zod\package.json" goto :install
if not exist "node_modules\typescript\bin\tsc" goto :install
goto :build

:install
echo 正在使用 package-lock.json 安装 MCP 依赖...
call npm ci
if errorlevel 1 (
  set "FAIL_MESSAGE=npm ci 安装失败。请检查网络与 npm 错误信息后重试。"
  goto :fail
)
> "node_modules\.ssh-mcp-lock.sha256" echo %LOCK_HASH%
if errorlevel 1 (
  set "FAIL_MESSAGE=依赖安装完成，但无法记录锁文件版本。请检查 node_modules 写入权限。"
  goto :fail
)

:build
echo 正在构建 ssh-mcp-server...
call npm run build
if errorlevel 1 (
  set "FAIL_MESSAGE=MCP 构建失败。请检查上方 TypeScript 错误信息。"
  goto :fail
)
if not exist "build\index.js" (
  set "FAIL_MESSAGE=构建命令结束但未生成 build\index.js。"
  goto :fail
)

if not exist ssh-config.json (
  > ssh-config.json echo []
  if errorlevel 1 (
    set "FAIL_MESSAGE=无法创建 ssh-config.json。请检查项目目录写入权限。"
    goto :fail
  )
  echo 已创建空的 ssh-config.json；启动面板后可在“账号”页添加服务器。
)

popd
set "IN_MCP_DIR=0"
echo.
echo 部署准备完成。
echo - Dashboard 使用 PATH 中的 Node.js %NODE_MAJOR%。
echo - MCP 入口：%MCP_DIR%\build\index.js
echo - 配置文件：%MCP_DIR%\ssh-config.json
echo - WorkBuddy 连接器也必须指向上述 MCP 入口与同一配置文件。
if /i not "%~1"=="--no-pause" pause
exit /b 0

:fail
echo.
echo 部署准备失败：%FAIL_MESSAGE%
if "%IN_MCP_DIR%"=="1" popd
if /i not "%~1"=="--no-pause" pause
exit /b 1
