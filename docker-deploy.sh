#!/usr/bin/env bash
# ============================================================
#  五子棋 Docker 一键部署（Ubuntu / Linux / macOS）
#  用法：./docker-deploy.sh [端口|范围]     例：./docker-deploy.sh 3000-3010
#  自定义配置：编辑 config.json 后  docker restart gomoku
# ============================================================
set -u
cd "$(dirname "$0")"
PORT="${1:-${PORT:-3000}}"

echo "== 五子棋 Docker 一键部署（目标端口 ${PORT}）=="

# 0) 前置检查
command -v docker >/dev/null 2>&1 || {
  echo "[错误] 未检测到 Docker。安装：https://docs.docker.com/engine/install/ubuntu/"
  echo "       安装后如提示权限不足：sudo usermod -aG docker \$USER 然后重新登录"
  exit 1
}
if ! docker info >/dev/null 2>&1; then
  echo "[错误] Docker 未运行或无权限：请启动 Docker，或用 sudo 运行本脚本"
  exit 1
fi
command -v curl >/dev/null 2>&1 || { echo "[错误] 未检测到 curl：sudo apt-get install -y curl"; exit 1; }

# 1) 构建镜像（首跑拉取 node:20-alpine；失败自动换国内镜像源重试）
echo "[1/3] 构建镜像 gomoku ..."
if ! docker build -t gomoku . ; then
  echo "构建失败，尝试国内镜像源（daocloud）拉取基础镜像后重试..."
  docker pull docker.m.daocloud.io/library/node:20-alpine || \
  docker pull docker.1ms.run/library/node:20-alpine || {
    echo "[错误] 基础镜像拉取失败，请检查网络或手动配置 registry mirror"; exit 1; }
  docker tag docker.m.daocloud.io/library/node:20-alpine node:20-alpine 2>/dev/null || \
  docker tag docker.1ms.run/library/node:20-alpine node:20-alpine
  docker build -t gomoku . || { echo "[错误] 镜像构建失败"; exit 1; }
fi

# 2) 启动容器（重建同名旧容器）
echo "[2/3] 启动容器 gomoku ..."
docker rm -f gomoku >/dev/null 2>&1 || true
docker run -d --name gomoku -p "${PORT}:3000" --restart unless-stopped gomoku || {
  echo "[错误] 容器启动失败，查看日志：docker logs gomoku"; exit 1; }

# 3) 健康检查 + 打开浏览器
echo -n "[3/3] 等待服务启动 "
ok=""
for i in $(seq 1 15); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/" 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then ok=1; echo " ✓ (HTTP 200)"; break; fi
  echo -n "."; sleep 1
done
[ -z "$ok" ] && echo "（15 秒内未就绪，可稍后刷新页面或查看 docker logs gomoku）"

LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
command -v xdg-open >/dev/null 2>&1 && xdg-open "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 || true
command -v open     >/dev/null 2>&1 && open     "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 || true

echo
echo "============================================================"
echo " 部署完成！本机访问:  http://127.0.0.1:${PORT}/"
[ -n "${LAN_IP:-}" ] && echo "            局域网:  http://${LAN_IP}:${PORT}/"
echo " 日志:  docker logs -f gomoku"
echo " 停止:  docker rm -f gomoku"
echo " 配置:  编辑 config.json 后  docker restart gomoku"
echo "============================================================"
