@echo off
rem ============================================================
rem  Gomoku unified manager (auto-detects Docker / bare Node)
rem  Usage: gomoku.bat [start^|stop^|restart^|status] [port]
rem    Config comes from config.json (port, spectator cap, ...)
rem    Docker available -^> containerized deploy (build + run)
rem    No Docker       -^> bare Node (background, gomoku-server.log)
rem  Replaces: start-gomoku.bat / docker-deploy.bat / stop-gomoku.bat
rem  (ASCII-only batch: cmd parses .bat in ANSI/GBK codepage.)
rem ============================================================
setlocal
title Gomoku Manager
cd /d "%~dp0"
set CMD=%1
if "%CMD%"=="" set CMD=start
set PORT_ARG=%2

rem --- port: explicit arg > config.json > 3000 ---
set PORT=3000
if exist config.json for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "$c=[string](Get-Content 'config.json' -Raw -Encoding UTF8 | ConvertFrom-Json).port; $c=$c.Split('-')[0]; $c=$c.Split(',')[0]; if(-not $c){$c='3000'}; $c"`) do set PORT=%%v
if not "%PORT_ARG%"=="" set PORT=%PORT_ARG%

set USE_DOCKER=0
where docker >nul 2>nul
if not errorlevel 1 docker info >nul 2>nul && set USE_DOCKER=1

if /i "%CMD%"=="start"   goto start
if /i "%CMD%"=="stop"    goto stop
if /i "%CMD%"=="restart" goto stop
if /i "%CMD%"=="status"  goto status
echo Usage: gomoku.bat [start^|stop^|restart^|status] [port]
goto end

:stop
set STOPPED=0
if "%USE_DOCKER%"=="1" (
  for /f %%c in ('docker ps -aq --filter "name=gomoku" 2^>nul') do (
    docker rm -f %%c >nul 2>nul
    echo  - removed docker container %%c
    set STOPPED=1
  )
)
for /f "tokens=5" %%p in ('netstat -ano ^| findstr LISTENING ^| findstr ":%PORT% " 2^>nul') do (
  echo  - killing PID %%p listening on %PORT%
  taskkill /F /PID %%p >nul 2>nul
  set STOPPED=1
)
if "%STOPPED%"=="0" echo  - nothing running on port %PORT%
goto end

:start
if "%USE_DOCKER%"=="1" goto start_docker
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found: https://nodejs.org/
  goto end
)
call :stop_silent
echo [node mode] starting server in background (log: gomoku-server.log) ...
start "gomoku-server" /min cmd /c "node gomoku-server.js %PORT_ARG% > gomoku-server.log 2>&1"
goto wait_open

:start_docker
echo [docker mode] building image gomoku ...
docker build -t gomoku .
if errorlevel 1 (
  echo Build failed. Retrying base image via CN mirror ^(daocloud^)...
  docker pull docker.m.daocloud.io/library/node:20-alpine
  docker tag docker.m.daocloud.io/library/node:20-alpine node:20-alpine
  docker build -t gomoku .
  if errorlevel 1 (
    echo [ERROR] Image build failed.
    goto end
  )
)
call :stop_silent
set VOL=
if exist config.json set VOL=-v "%cd%\config.json:/app/config.json"
docker run -d --name gomoku -p %PORT%:%PORT% %VOL% --restart unless-stopped gomoku
if errorlevel 1 (
  echo [ERROR] Container failed. Maybe the port is used by a bare node process?
  echo         Try:  gomoku.bat stop   then   gomoku.bat start
  goto end
)
goto wait_open

:wait_open
ping -n 3 127.0.0.1 >nul
where curl >nul 2>nul && curl -s -o nul -w "Health check: HTTP %%{http_code}\n" http://127.0.0.1:%PORT%/
start "" "http://127.0.0.1:%PORT%/"
echo Deployed!  Game: http://127.0.0.1:%PORT%/    Stop: gomoku.bat stop
goto end

:status
echo Mode: %USE_DOCKER%
curl -s -o nul -w "HTTP %%%%{http_code}\n" http://127.0.0.1:%PORT%/ 2>nul
docker ps -a --filter "name=gomoku" --format "container: {{.Names}} ^| {{.Status}}" 2>nul
goto end

:stop_silent
if "%USE_DOCKER%"=="1" (
  for /f %%c in ('docker ps -aq --filter "name=gomoku" 2^>nul') do docker rm -f %%c >nul 2>nul
)
goto :eof

:end
endlocal
