# AI 智能体桥接器 (ai-bridge) 生产镜像
# 使用 Node 20 LTS Alpine，体积小且包含必要的构建工具
FROM node:20-alpine

# 安装 better-sqlite3 等 native 模块编译所需的工具
RUN apk add --no-cache python3 make g++ git

WORKDIR /app

# 先复制依赖清单，利用 Docker layer cache
COPY package*.json ./
RUN npm ci --omit=dev

# 复制源码并构建
COPY . .
RUN npm run build

# 数据持久化目录
VOLUME ["/app/data"]

# 暴露服务端口
EXPOSE 4567

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:4567/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# 生产启动
CMD ["node", "dist/index.js"]
