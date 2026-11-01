# 固定资产管理系统 — 生产镜像
# 用 node:20-bookworm 完整版（已预装 python3/make/g++，无需 apt 安装，规避国内源慢）
# better-sqlite3 为原生模块，直接在镜像内编译；配国内 npm 镜像加速
FROM node:20-bookworm

WORKDIR /app

# 配国内 npm 镜像，先装依赖（利用层缓存）
COPY package.json package-lock.json ./
RUN npm config set registry https://registry.npmmirror.com \
    && npm ci --omit=dev \
    && npm cache clean --force

# 复制应用代码
COPY server ./server
COPY public ./public

# 运行期目录（数据与上传由 compose 卷挂载持久化）
RUN mkdir -p /app/data /app/uploads && chmod 777 /app/data /app/uploads

ENV NODE_ENV=production
ENV PORT=3200
EXPOSE 3200

# 说明：data/uploads 以宿主机目录 bind mount 持久化，容器内以 root 运行以避免挂载卷属主导致的写入失败
CMD ["node", "server/index.js"]
