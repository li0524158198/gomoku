@echo off
setlocal
rem Gomoku online server launcher (kept ASCII-only: cmd parses .bat in ANSI/GBK
rem codepage, so Chinese text here would turn into mojibake / syntax errors.
rem Chinese messages are printed by the Node process instead, which renders fine.)
title Gomoku Server  (close this window = stop server)
cd /d "%~dp0"
rem default port comes from config.json (only an explicit argument overrides it)
set ARGPORT=
if not "%~1"=="" set ARGPORT=%~1
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install it from https://nodejs.org/
  pause
  exit /b 1
)
if not "%ARGPORT%"=="" (set PARG=%ARGPORT%) else (set PARG=)
echo Your browser will open automatically  (http://127.0.0.1:%PORT%/)
echo Stop: close this window / Ctrl+C, or run stop-gomoku.bat %PORT%
rem Restart first: kill an old running instance (after git pull, the new code only takes effect after a restart)
if exist stop-gomoku.bat call stop-gomoku.bat %PORT% >nul 2>nul
echo.
node gomoku-server.js %PARG%
echo.
echo Server stopped.
echo If it reported the port was busy, a server is already running -
echo just use the browser page at http://127.0.0.1:%PORT%/
echo To use another port:  start-gomoku.bat 3000-3010
pause
