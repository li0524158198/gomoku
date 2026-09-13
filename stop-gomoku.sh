#!/usr/bin/env bash
# ============================================================
#  五子棋停止脚本：移除 Docker 容器；裸机运行时结束端口进程
#  用法：./stop-gomoku.sh [端口]     默认取 config.json 的端口（否则 3000）
# ============================================================
PORT="${1:-}"
if [ -z "$PORT" ] && [ -f config.json ]; then
  PORT=$(grep -E '"port"[[:space:]]*:[[:space:]]*[0-9]+' config.json | head -n1 | grep -oE '[0-9]+' | head -n1)
fi
PORT="${PORT:-3000}"
echo "停止五子棋服务（端口 ${PORT}）..."

if command -v docker >/dev/null 2>&1; then
  docker rm -f gomoku >/dev/null 2>&1 && echo " - Docker 容器 gomoku 已移除"
  # 注意：端口由 Docker 自行释放，绝不 kill 其代理进程（否则 Docker 引擎受损）
fi

# 无 Docker 的裸机运行：结束仍监听端口的进程（ss → fuser → lsof → pkill 逐级降级）
if ! command -v docker >/dev/null 2>&1; then
  killed=""
  pids=""
  if command -v ss >/dev/null 2>&1; then
    pids=$(ss -ltnp 2>/dev/null | grep ":${PORT} " | grep -oP 'pid=\K[0-9]+' | sort -u)
  elif command -v lsof >/dev/null 2>&1; then
    pids=$(lsof -t -i ":${PORT}" 2>/dev/null)
  fi
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null && killed=1 && echo " - 已结束监听端口 ${PORT} 的进程: $(echo $pids | tr ' ' ',')"
  elif command -v fuser >/dev/null 2>&1; then
    fuser -k "${PORT}/tcp" >/dev/null 2>&1 && killed=1 && echo " - fuser 已结束端口 ${PORT} 上的进程"
  elif pgrep -f "gomoku-server" >/dev/null 2>&1; then
    pkill -f "gomoku-server" && killed=1 && echo " - 已结束 gomoku-server 进程（按进程名匹配）"
  fi
  [ -n "$killed" ] || echo " - 端口 ${PORT} 无残留进程"
fi

echo "完成。重新启动：./docker-deploy.sh 或 ./start-gomoku.sh"
