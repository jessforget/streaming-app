@echo off
title Gfx app
cd /d "%~dp0"
rem The gfx app window (needs the streaming apps files: node_modules).
if exist "node_modules\electron\dist\electron.exe" (
  start "" "node_modules\electron\dist\electron.exe" gfx-app\main.cjs
  exit /b 0
)
rem Without them: the same app in the browser (no window sending, no file picking).
where node >NUL 2>NUL
if errorlevel 1 (
  echo Node.js was not found on this PC, so the gfx app cannot start.
  echo Copy the whole Streaming App folder here, or install Node.js from https://nodejs.org
  pause
  exit /b 1
)
echo The gfx app window needs the Streaming App folders node_modules. Opening it in the browser instead.
echo Keep this window open while you use it.
node gfx-app\server.cjs --open
pause
