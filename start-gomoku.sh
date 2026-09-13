#!/usr/bin/env bash
# 五子棋对战服务器一键启动（Linux / macOS）
# 用法：./start-gomoku.sh [端口|范围]   例：./start-gomoku.sh 3000-3010
cd "$(dirname "$0")"
PORT="${1:-${PORT:-3000}}"
if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未检测到 Node.js，请先安装：https://nodejs.org/"
  exit 1
fi
echo "正在启动五子棋服务器（端口 ${PORT}），浏览器将自动打开游戏页面..."
node gomoku-server.js "$PORT"
