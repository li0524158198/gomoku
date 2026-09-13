@echo off
setlocal
rem ============================================================
rem  Gomoku stop script: removes the docker container and/or
rem  kills any leftover process listening on the port.
rem  Usage: stop-gomoku.bat [port]   (default port 3000)
rem ============================================================
title Gomoku Stop
rem default port comes from config.json
set PORT=3000
if exist config.json for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "$c=[string](Get-Content 'config.json' -Raw -Encoding UTF8 | ConvertFrom-Json).port; $c=$c.Split('-')[0]; $c=$c.Split(',')[0]; if(-not $c){$c='3000'}; $c"`) do set PORT=%%v
if not "%~1"=="" set PORT=%~1
echo Stopping Gomoku server (port %PORT%) ...
rem (also pass a port: stop-gomoku.bat 8080)

where docker >nul 2>nul
if errorlevel 1 set DOCKER=0
if not errorlevel 1 set DOCKER=1
if "%DOCKER%"=="1" (
  docker rm -f gomoku >nul 2>nul && echo  - docker container "gomoku" removed
  rem Docker releases the port itself. Never kill its proxy process!
) else (
  rem No docker: kill leftover listener (bare-metal node run)
  for /f "tokens=5" %%p in ('netstat -ano ^| findstr LISTENING ^| findstr ":%PORT% " 2^>nul') do (
    echo  - killing PID %%p listening on %PORT%
    taskkill /F /PID %%p >nul 2>nul
  )
)
echo Done.
ping -n 3 127.0.0.1 >nul
