#!/usr/bin/env bash
# 五子棋对战服务器一键启动（Linux / macOS）
# 用法：./start-gomoku.sh [端口|范围]   例：./start-gomoku.sh 3000-3010
# 说明：若旧实例正在运行会**先停止再启动**——git pull 更新代码后执行本脚本即可生效
cd "$(dirname "$0")"
PORT_ARG="${1:-}"
if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未检测到 Node.js，请先安装：https://nodejs.org/"
  exit 1
fi
# 先停止已在运行的旧实例（否则新进程因端口占用启动失败，页面仍是旧版本）
if [ -x ./stop-gomoku.sh ]; then
  ./stop-gomoku.sh >/dev/null 2>&1 || true
  sleep 1
fi
echo "正在启动五子棋服务器（端口见 config.json），浏览器将自动打开游戏页面...（停止：./stop-gomoku.sh）"
node gomoku-server.js $PORT_ARG
