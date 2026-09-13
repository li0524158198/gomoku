#!/usr/bin/env bash
# ============================================================
#  五子棋统一管理脚本（自动识别运行方式：Docker / 裸机 Node）
#  用法: ./gomoku.sh [start|stop|restart|status] [端口]
#    - 端口默认读 config.json（显式第二参数可临时覆盖）
#    - 检测到可用 Docker → 自动构建镜像并容器化部署
#      （清理 docker run 与 compose 两种命名的容器，避免端口冲突）
#    - 无 Docker → 自动用本机 Node 裸跑（后台运行，日志 gomoku-server.log）
#  兼容: 取代原 start-gomoku / docker-deploy / stop-gomoku
# ============================================================
cd "$(dirname "$0")"

# 兼容 sh/dash 调用：本脚本使用了部分 bash 特性，检测到非 bash 时自动切换
if [ -z "${BASH_VERSION:-}" ] && command -v bash >/dev/null 2>&1; then exec bash "$0" "$@"; fi
CMD="${1:-start}"
PORT_ARG="${2:-}"

# —— 端口：显式参数 > config.json > 3000 ——
PORT=""
if [ -f config.json ]; then
  PORT=$(grep -E '"port"[[:space:]]*:[[:space:]]*[0-9]+' config.json | head -n1 | grep -oE '[0-9]+' | head -n1)
fi
PORT="${PORT:-3000}"
[ -n "$PORT_ARG" ] && PORT="$PORT_ARG"


# —— 诊断：端口在但外部访问不了时的自动检查 ——
do_doctor() {
  echo "== 五子棋诊断（端口 ${PORT}）=="
  local code="" i="" cfghost="0.0.0.0" spec_max=""
  if [ -f config.json ]; then
    cfghost=$(grep -E '^  "host"[[:space:]]*:' config.json | head -n1 | sed "s/.*:[[:space:]]*\"//; s/\".*//")
    spec_max=$(grep -E '"specMax"[[:space:]]*:' config.json | head -n1 | grep -oE '[0-9]+' | head -n1)
  fi
  [ -z "$cfghost" ] && cfghost="0.0.0.0"
  local loopback_only=0
  case "$cfghost" in 127.0.0.1|localhost|::1) loopback_only=1 ;; esac
  for i in 1 2 3; do
    code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/" 2>/dev/null || echo 000)
    [ "$code" = "200" ] && break
    sleep 1
  done
  echo "1) 配置: host=${cfghost} · 端口=${PORT} · 观战上限=${spec_max:-5000（默认）}"
  echo "2) 本机自检: HTTP ${code} $([ "$code" = "200" ] && echo "✓ 服务正常" || echo "✗ 服务未启动，请先 ./gomoku.sh start")"
  local bindline=""
  if command -v ss >/dev/null 2>&1; then
    bindline=$(ss -ltn 2>/dev/null | grep ":${PORT} " | head -n 1)
  elif command -v netstat >/dev/null 2>&1; then
    bindline=$(netstat -an 2>/dev/null | grep LISTEN | grep "[:.]${PORT} " | head -n 1)
  fi
  echo "3) 监听地址: ${bindline:-（未检测到 ss/netstat，跳过）}"
  if [ "$USE_DOCKER" = 1 ]; then
    echo "4) Docker 容器:"
    docker ps -a --filter name=gomoku --format "   {{.Names}} | {{.Status}} | {{.Ports}}" 2>/dev/null
  fi
  echo "5) 防火墙:"
  if command -v ufw >/dev/null 2>&1; then
    ufw status 2>/dev/null | head -n 5 | sed "s/^/   /"
  else
    echo "   （未检测到 ufw；云服务器请到控制台检查安全组是否放行 TCP ${PORT}）"
  fi
  echo "6) 结论:"
  if [ "$loopback_only" = 1 ]; then
    echo "   ⚠ 配置的 host 是 ${cfghost}：服务只对本机开放，外部无法访问！"
    echo "   → 把 config.json 的 host 改为 0.0.0.0，然后 ./gomoku.sh restart"
  elif [ "$code" != "200" ]; then
    if [ "$USE_DOCKER" = 1 ] && docker ps --filter name=gomoku --format "{{.Names}}" 2>/dev/null | grep -q gomoku; then
      echo "   容器刚启动可能尚未就绪，可稍候重试 ./gomoku.sh doctor"
    else
      echo "   服务未启动 → ./gomoku.sh start"
    fi
  else
    echo "   服务与配置正常。外部仍打不开时依次检查："
    echo "   a) 云控制台安全组放行 TCP ${PORT}（最常见原因）"
    echo "   b) 系统防火墙: sudo ufw allow ${PORT}/tcp"
    echo "   c) 浏览器地址用 http://公网IP:${PORT}/（不要用 https）"
  fi
}

# —— 运行方式识别：Docker 可用即容器化，否则裸机 Node ——
USE_DOCKER=0
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  USE_DOCKER=1
fi

# —— 停止：清理全部相关容器（覆盖 docker run 与 compose 两种命名）+ 端口残留进程 ——
do_stop() {
  local cleaned=0 ids="" pids=""
  if [ "$USE_DOCKER" = 1 ]; then
    ids=$(docker ps -aq --filter name=gomoku 2>/dev/null)
    if [ -n "$ids" ]; then
      docker rm -f $ids >/dev/null 2>&1
      echo " - 已移除 Docker 容器: $(echo $ids | tr ' ' ',')"
      cleaned=1
    fi
  fi
  # 裸机进程兜底（docker 模式下排除 docker-proxy，绝不误杀 Docker）
  if command -v ss >/dev/null 2>&1; then
    pids=$(ss -ltnp 2>/dev/null | grep ":${PORT} " | grep -v docker-proxy | grep -oP 'pid=\K[0-9]+' | sort -u)
  elif command -v lsof >/dev/null 2>&1; then
    pids=$(lsof -t -i ":${PORT}" 2>/dev/null)
  elif command -v fuser >/dev/null 2>&1; then
    fuser -k "${PORT}/tcp" >/dev/null 2>&1 && cleaned=1 && echo " - fuser 已结束端口 ${PORT} 上的进程"
  elif pgrep -f "gomoku-server.js" >/dev/null 2>&1; then
    pids=$(pgrep -f "gomoku-server.js")
  fi
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null && echo " - 已结束端口 ${PORT} 上的进程: $(echo $pids | tr ' ' ',')" && cleaned=1
  fi
  [ "$cleaned" = 0 ] && echo " - 没有正在运行的实例"
}

# —— 健康检查（最长 15 秒）——
health_check() {
  local code="" i
  for i in $(seq 1 15); do
    code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/" 2>/dev/null || echo 000)
    if [ "$code" = "200" ]; then echo " ✓ (HTTP 200)"; return 0; fi
    echo -n "."; sleep 1
  done
  echo "（15 秒未就绪：可稍后刷新页面，或查看 docker logs gomoku / gomoku-server.log）"
  return 1
}

# —— Docker 模式启动 ——
do_start_docker() {
  echo "[docker 模式] 构建镜像 gomoku ..."
  if ! docker build -t gomoku . ; then
    echo "构建失败，尝试国内镜像源（daocloud → 1ms）拉取基础镜像后重试..."
    docker pull docker.m.daocloud.io/library/node:20-alpine || \
    docker pull docker.1ms.run/library/node:20-alpine || {
      echo "[错误] 基础镜像拉取失败，请检查网络或手动配置 registry mirror"; exit 1; }
    docker tag docker.m.daocloud.io/library/node:20-alpine node:20-alpine 2>/dev/null || \
    docker tag docker.1ms.run/library/node:20-alpine node:20-alpine
    docker build -t gomoku . || { echo "[错误] 镜像构建失败"; exit 1; }
  fi
  do_stop
  local vol=""
  [ -f config.json ] && vol="-v $(pwd)/config.json:/app/config.json"
  docker run -d --name gomoku -p "${PORT}:${PORT}" $vol --restart unless-stopped gomoku || {
    echo "[错误] 容器启动失败（端口可能被其他程序占用，可先执行 ./gomoku.sh stop）"; exit 1; }
  echo -n "等待服务启动 "
  health_check || true
  command -v xdg-open >/dev/null 2>&1 && xdg-open "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 || true
  command -v open >/dev/null 2>&1 && open "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 || true
  echo "访问: http://127.0.0.1:${PORT}/   日志: docker logs -f gomoku"
}

# —— 裸机 Node 模式启动（后台 + 日志）——
do_start_node() {
  do_stop
  command -v node >/dev/null 2>&1 || { echo "[错误] 未检测到 Node.js：https://nodejs.org/"; exit 1; }
  nohup node gomoku-server.js ${PORT_ARG:+$PORT_ARG} > gomoku-server.log 2>&1 &
  echo -n "等待服务启动 "
  health_check || true
  command -v xdg-open >/dev/null 2>&1 && xdg-open "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 || true
  echo "后台运行中，日志: gomoku-server.log（停止: ./gomoku.sh stop）"
}

# —— 状态 ——
do_status() {
  echo "运行方式: $([ "$USE_DOCKER" = 1 ] && echo "Docker 可用" || echo "裸机 Node")"
  echo "配置端口: ${PORT}（来源: config.json）"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/" 2>/dev/null || echo 000)
  echo "服务状态: HTTP ${code}"
  if [ "$USE_DOCKER" = 1 ]; then
    docker ps -a --filter name=gomoku --format "容器: {{.Names}} | {{.Status}}" 2>/dev/null
  fi
  [ -f gomoku-server.log ] && echo "日志文件: gomoku-server.log"
}

case "$CMD" in
  start)   if [ "$USE_DOCKER" = 1 ]; then do_start_docker; else do_start_node; fi ;;
  stop)    do_stop ;;
  restart) do_stop; sleep 1; if [ "$USE_DOCKER" = 1 ]; then do_start_docker; else do_start_node; fi ;;
  status)  do_status ;;
  doctor)  do_doctor ;;
  *) echo "用法: ./gomoku.sh [start|stop|restart|status|doctor] [端口]"; exit 1 ;;
esac
