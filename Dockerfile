FROM node:20-alpine
WORKDIR /app

# 游戏页面（内嵌引擎）、服务器与配置模板（启动时自动生成 config.json）
COPY index.html gomoku-server.js config.example.json ./

# 容器内无浏览器：禁用自动打开
ENV GOMOKU_NO_OPEN=1

EXPOSE 3000

# 不传端口参数：容器内监听端口以挂载/生成的 config.json 为准
# （CMD 不带端口参数，避免硬编码覆盖用户的配置）
CMD ["node", "gomoku-server.js"]
