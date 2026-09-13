@echo off
rem ============================================================
rem  Gomoku one-click Docker deploy (Windows)
rem  Usage: double-click, or run with a port:  docker-deploy.bat 8080
rem  Custom config: edit config.json, then docker restart gomoku
rem  (This batch is ASCII-only: cmd parses .bat in ANSI/GBK codepage,
rem   Chinese text here would turn into mojibake / syntax errors.)
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

echo [1/3] Building image "gomoku" (first run pulls node:20-alpine)...
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

echo [2/3] Starting container "gomoku" on port %PORT% ...
docker rm -f gomoku >nul 2>nul
docker run -d --name gomoku -p %PORT%:3000 --restart unless-stopped gomoku
if errorlevel 1 (
  echo [ERROR] Failed to start container. See: docker logs gomoku
  pause
  exit /b 1
)

echo [3/3] Waiting for server and opening browser...
timeout /t 2 /nobreak >nul
where curl >nul 2>nul && curl -s -o nul -w "Health check: HTTP %%{http_code}\n" http://127.0.0.1:%PORT%/
start "" "http://127.0.0.1:%PORT%/"

echo.
echo ============================================================
echo  Deployed!   Game:  http://127.0.0.1:%PORT%/
echo              LAN:   http://^(your-ip^):%PORT%/
echo  Logs:   docker logs -f gomoku
echo  Stop:   docker rm -f gomoku
echo  Config: edit config.json  then  docker restart gomoku
echo ============================================================
pause
