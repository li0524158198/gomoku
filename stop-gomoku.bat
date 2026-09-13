@echo off
rem ============================================================
rem  Gomoku stop script: removes the docker container and/or
rem  kills any leftover process listening on the port.
rem  Usage: stop-gomoku.bat [port]   (default port 3000)
rem ============================================================
title Gomoku Stop
set PORT=3000
if not "%~1"=="" set PORT=%~1
echo Stopping Gomoku server (port %PORT%) ...

where docker >nul 2>nul
if not errorlevel 1 (
  docker rm -f gomoku >nul 2>nul && echo  - docker container "gomoku" removed
)

rem Fallback: kill whatever still listens on the port (bare-metal node run)
set KILLED=
for /f "tokens=5" %%p in ('netstat -ano ^| findstr LISTENING ^| findstr ":%PORT% " 2^>nul') do (
  echo  - killing PID %%p listening on %PORT%
  taskkill /F /PID %%p >nul 2>nul
  set KILLED=1
)
if not defined KILLED (
  docker ps --format "{{.Names}}" 2>nul | findstr /x "gomoku" >nul || echo  - nothing listening on %PORT%
)
echo Done.
ping -n 3 127.0.0.1 >nul
