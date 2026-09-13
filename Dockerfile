FROM node:20-alpine
WORKDIR /app

# 游戏页面（内嵌引擎）、服务器与配置模板（启动时自动生成 config.json）
COPY index.html gomoku-server.js config.example.json ./

# 容器内无浏览器：禁用自动打开；端口默认 3000
ENV GOMOKU_NO_OPEN=1
ENV PORT=3000

EXPOSE 3000

# 端口映射示例：docker run -p 3000:3000；也可 -e PORT_RANGE=3000-3010
CMD ["node", "gomoku-server.js", "3000"]
