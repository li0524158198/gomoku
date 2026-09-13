@echo off
rem Gomoku online server launcher (kept ASCII-only: cmd parses .bat in ANSI/GBK
rem codepage, so Chinese text here would turn into mojibake / syntax errors.
rem Chinese messages are printed by the Node process instead, which renders fine.)
title Gomoku Server  (close this window = stop server)
cd /d "%~dp0"
set PORT=3000
if not "%~1"=="" set PORT=%~1
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Please install it from https://nodejs.org/
  pause
  exit /b 1
)
echo Starting Gomoku server on port %PORT% ...
echo Your browser will open automatically  (http://127.0.0.1:%PORT%/)
echo Stop: close this window / Ctrl+C, or run stop-gomoku.bat %PORT%
echo.
node gomoku-server.js %PORT%
echo.
echo Server stopped.
echo If it reported the port was busy, a server is already running -
echo just use the browser page at http://127.0.0.1:%PORT%/
echo To use another port:  start-gomoku.bat 3000-3010
pause
