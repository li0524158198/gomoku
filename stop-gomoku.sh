#!/usr/bin/env bash
# ============================================================
#  五子棋停止脚本：移除 Docker 容器，并兜底结束占用端口的进程
#  用法：./stop-gomoku.sh [端口]     默认 3000
# ============================================================
PORT="${1:-${PORT:-3000}}"
echo "停止五子棋服务（端口 ${PORT}）..."

# 1) Docker 容器
if command -v docker >/dev/null 2>&1; then
  docker rm -f gomoku >/dev/null 2>&1 && echo " - Docker 容器 gomoku 已移除"
fi

# 2) 兜底：结束仍监听该端口的进程（裸 Node 运行 / nohup / systemd 均适用）
#    Ubuntu 预装 ss(iproute2) 与 pkill(procps)，足够覆盖；fuser/lsof 为可选增强
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

echo "完成。重新启动：./docker-deploy.sh 或 ./start-gomoku.sh"
