@echo off
setlocal
rem ============================================================
rem  Gomoku one-click Docker deploy (Windows)
rem  Usage: double-click, or run with a host port:  docker-deploy.bat 8080
rem  Config: ALL settings (port, spectator cap, ...) come from config.json.
rem          Command-line port overrides the config host port.
rem  (ASCII-only batch: cmd parses .bat in ANSI/GBK codepage.)
rem ============================================================
title Gomoku Docker Deploy
cd /d "%~dp0"
set PORT=3000
if not "%~1"=="" set PORT=%~1

where docker >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Docker not found.
  echo         Install Docker Desktop: https://www.docker.com/products/docker-desktop/
  echo         (then start Docker Desktop and run this script again)
  pause
  exit /b 1
)

rem --- read the listen port from config.json (fallback 3000) ---
set CFGPORT=3000
if exist config.json for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "$c=[string](Get-Content 'config.json' -Raw -Encoding UTF8 | ConvertFrom-Json).port; $c=$c.Split('-')[0]; $c=$c.Split(',')[0]; if(-not $c){$c='3000'}; $c"`) do set CFGPORT=%%v

echo [1/3] Building image "gomoku" (rebuilds after git pull)...
docker build -t gomoku .
if errorlevel 1 (
  echo Build failed. Retrying base image via CN mirror ^(daocloud^)...
  docker pull docker.m.daocloud.io/library/node:20-alpine
  docker tag docker.m.daocloud.io/library/node:20-alpine node:20-alpine
  docker build -t gomoku .
  if errorlevel 1 (
    echo [ERROR] Image build failed. Check network / Docker Desktop is running.
    pause
    exit /b 1
  )
)

echo [2/3] Starting container "gomoku": host %PORT% -^> container %CFGPORT% ...
docker rm -f gomoku >nul 2>nul
if exist config.json (
  docker run -d --name gomoku -p %PORT%:%CFGPORT% -v "%cd%\config.json:/app/config.json" --restart unless-stopped gomoku
) else (
  docker run -d --name gomoku -p %PORT%:%CFGPORT% --restart unless-stopped gomoku
)
if errorlevel 1 (
  echo [ERROR] Failed to start container. See: docker logs gomoku
  pause
  exit /b 1
)

echo [3/3] Waiting for server and opening browser...
ping -n 2 127.0.0.1 >nul
where curl >nul 2>nul && curl -s -o nul -w "Health check: HTTP %%{http_code}\n" http://127.0.0.1:%PORT%/
start "" "http://127.0.0.1:%PORT%/"

echo.
echo ============================================================
echo  Deployed!   Game:  http://127.0.0.1:%PORT%/
echo  Config:    config.json  (change port there, then re-run this script)
echo  Logs:    docker logs -f gomoku
echo  Stop:    stop-gomoku.bat %PORT%
echo ============================================================
pause
